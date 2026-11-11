import type { Namespace, Socket } from 'socket.io';
import type { DeviceTokenPayload } from '../auth/jwt.js';
import { Device } from '../db/index.js';
import type { Config } from '../config.js';
import type { ServerCerts } from '../certs/certOps.js';
import { createLogger } from '../utils/logger.js';
import { liveAgents } from './index.js';
import {
  AgentEvent,
  ServerEvent,
  type AgentStatusPayload,
  type CommandPayload,
  type CommandResultPayload,
  type SignalPayload,
} from '@monitour/shared';

const log = createLogger('agent');

/** Latest thumbnail per device (base64 JPEG). */
export const thumbnailStore = new Map<string, { data: string; ts: number }>();

/** Latest session lock state per device. */
export const sessionStateStore = new Map<string, { locked: boolean; ts: number }>();

export function setupAgentNamespace(ns: Namespace, cfg: Config, certs: ServerCerts): void {
  ns.on('connection', (socket: Socket) => {
    const device = (socket.data as { device?: DeviceTokenPayload }).device!;
    const deviceId = device.deviceId;

    log.info(`Agent connected: ${deviceId} (socket=${socket.id})`);
    liveAgents.set(deviceId, socket.id);

    // Mark online in DB
    void Device.findByIdAndUpdate(deviceId, {
      status: 'online',
      lastSeen: new Date(),
    });

    // Notify dashboards of status change
    notifyDashboards(ns.server, deviceId, 'online');

    // ---- Agent status updates ----
    socket.on(AgentEvent.Status, async (payload: AgentStatusPayload) => {
      try {
        await Device.findByIdAndUpdate(deviceId, {
          systemInfo: payload.systemInfo,
          lastSeen: new Date(),
          status: 'online',
        });
        // Relay to dashboards watching this device
        ns.server.of('/dashboard').emit('device:status-update', {
          deviceId,
          status: 'online',
          systemInfo: payload.systemInfo,
          timestamp: payload.timestamp,
          sessionState: payload.sessionState,
        });
        // Track lock state for device grid badges
        if (payload.sessionState) {
          sessionStateStore.set(deviceId, { locked: payload.sessionState.locked, ts: payload.timestamp });
        }
      } catch (err) {
        log.error('Failed to update agent status:', err);
      }
    });

    // ---- Command results from agent ----
    socket.on(AgentEvent.CommandResult, (payload: CommandResultPayload) => {
      log.debug(`Command result from ${deviceId}: ${payload.commandId}`);
      // Relay to dashboard namespace so the requesting user sees it
      ns.server.of('/dashboard').emit('dash:command-result', {
        deviceId,
        ...payload,
      });
    });

    // ---- WebRTC signaling from agent ----
    socket.on(AgentEvent.Signal, (payload: SignalPayload) => {
      // Relay to dashboard
      ns.server.of('/dashboard').emit('dash:signal', {
        deviceId,
        ...payload,
      });
    });

    // ---- Agent log messages ----
    socket.on(AgentEvent.Log, (msg: string) => {
      log.debug(`[agent:${deviceId}] ${msg}`);
      ns.server.of('/dashboard').emit('agent:log', { deviceId, message: msg, ts: Date.now() });
    });

    // ---- Thumbnail frames (periodic low-res previews) ----
    socket.on('agent:thumbnail', (payload: { deviceId: string; data: string; width: number; height: number; ts: number }) => {
      thumbnailStore.set(deviceId, { data: payload.data, ts: payload.ts });
      ns.server.of('/dashboard').emit('device:thumbnail-update', {
        deviceId,
        data: payload.data,
        width: payload.width,
        height: payload.height,
        ts: payload.ts,
      });
    });

    // ---- Session lock/desktop state changes ----
    socket.on('agent:session-state', (payload: { deviceId: string; sessionState: { locked: boolean }; ts: number }) => {
      sessionStateStore.set(deviceId, { locked: payload.sessionState.locked, ts: payload.ts });
      ns.server.of('/dashboard').emit('device:session-state-update', {
        deviceId,
        sessionState: payload.sessionState,
        ts: payload.ts,
      });
    });

    // ---- Desktop frames (full-res, for RemoteDesktop page) ----
    socket.on('agent:frame', (payload: { header: unknown; data: Buffer | ArrayBuffer | Uint8Array }) => {
      ns.server.of('/dashboard').emit('device:frame-update', {
        deviceId,
        header: payload.header,
        data: payload.data,
      });
    });

    // ---- Terminal data from agent ----
    socket.on('agent:terminal-data', (payload: { sessionId: string; data: string }) => {
      ns.server.of('/dashboard').emit('device:terminal-data', {
        deviceId,
        ...payload,
      });
    });

    socket.on('agent:terminal-exit', (payload: { sessionId: string; exitCode: number }) => {
      ns.server.of('/dashboard').emit('device:terminal-exit', {
        deviceId,
        ...payload,
      });
    });

    // ---- Ping ----
    socket.on('ping-check', () => {
      socket.emit('pong-check', { ts: Date.now() });
    });

    // ---- Disconnect ----
    socket.on('disconnect', async () => {
      log.info(`Agent disconnected: ${deviceId}`);
      if (liveAgents.get(deviceId) === socket.id) {
        liveAgents.delete(deviceId);
        thumbnailStore.delete(deviceId);
        sessionStateStore.delete(deviceId);
        await Device.findByIdAndUpdate(deviceId, { status: 'offline', lastSeen: new Date() });
        notifyDashboards(ns.server, deviceId, 'offline');
      }
    });
  });

  // Listen for commands targeted at agents from the dashboard namespace
  ns.server.of('/dashboard').on('connection', (dashSocket: Socket) => {
    // Send all stored thumbnails on connect
    dashSocket.on('dash:request-thumbnails', () => {
      const thumbnails = Object.fromEntries(thumbnailStore);
      dashSocket.emit('dash:thumbnails', thumbnails);
    });

    dashSocket.on('dash:send-command', (payload: { deviceId: string; command: CommandPayload }) => {
      const agentSocketId = liveAgents.get(payload.deviceId);
      if (!agentSocketId) {
        dashSocket.emit('dash:command-result', {
          deviceId: payload.deviceId,
          commandId: payload.command.commandId,
          sessionId: payload.command.sessionId,
          success: false,
          error: 'Agent is offline',
        });
        return;
      }
      const agentSocket = ns.sockets.get(agentSocketId);
      if (!agentSocket) {
        dashSocket.emit('dash:command-result', {
          deviceId: payload.deviceId,
          commandId: payload.command.commandId,
          sessionId: payload.command.sessionId,
          success: false,
          error: 'Agent socket not found',
        });
        return;
      }
      log.debug(`Relaying command ${payload.command.type} to agent ${payload.deviceId}`);
      agentSocket.emit(ServerEvent.Command, payload.command);
    });

    // WebRTC signaling from dashboard -> agent
    dashSocket.on('dash:signal', (payload: { deviceId: string; signal: SignalPayload }) => {
      const agentSocketId = liveAgents.get(payload.deviceId);
      const agentSocket = agentSocketId ? ns.sockets.get(agentSocketId) : undefined;
      if (agentSocket) {
        agentSocket.emit(ServerEvent.Signal, payload.signal);
      }
    });

    // Desktop input events from dashboard -> agent
    dashSocket.on('dash:desktop-input', (payload: { deviceId: string; input: unknown }) => {
      const agentSocketId = liveAgents.get(payload.deviceId);
      const agentSocket = agentSocketId ? ns.sockets.get(agentSocketId) : undefined;
      if (agentSocket) {
        agentSocket.emit('server:desktop-input', payload.input);
      }
    });
  });

  log.info('Agent namespace handler ready');
}

function notifyDashboards(io: import('socket.io').Server, deviceId: string, status: string): void {
  io.of('/dashboard').emit('device:status-update', {
    deviceId,
    status,
    timestamp: Date.now(),
  });
}
