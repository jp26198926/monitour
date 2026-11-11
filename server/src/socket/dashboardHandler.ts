import type { Namespace, Socket } from 'socket.io';
import type { UserTokenPayload } from '../auth/jwt.js';
import { Device } from '../db/index.js';
import type { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { thumbnailStore, sessionStateStore } from './agentHandler.js';
import type { SignalPayload, CommandResultPayload } from '@monitour/shared';

const log = createLogger('dashboard');

export function setupDashboardNamespace(ns: Namespace, _cfg: Config): void {
  ns.on('connection', (socket: Socket) => {
    const user = (socket.data as { user?: UserTokenPayload }).user!;
    log.info(`Dashboard connected: ${user.username} (socket=${socket.id})`);

    // ---- Send initial device list ----
    void sendDeviceList(socket);

    // ---- Send stored thumbnails ----
    const thumbnails = Object.fromEntries(thumbnailStore);
    if (Object.keys(thumbnails).length > 0) {
      socket.emit('dash:thumbnails', thumbnails);
    }

    // ---- Subscribe to a device's status updates ----
    socket.on('dash:subscribe-device', (deviceId: string) => {
      socket.join(`device:${deviceId}`);
      log.debug(`${user.username} subscribed to device ${deviceId}`);
    });

    socket.on('dash:unsubscribe-device', (deviceId: string) => {
      socket.leave(`device:${deviceId}`);
    });

    // ---- Request device list refresh ----
    socket.on('dash:request-devices', () => {
      void sendDeviceList(socket);
    });

    // ---- Ping ----
    socket.on('dash:ping', () => {
      socket.emit('dash:pong', { ts: Date.now() });
    });

    // ---- Disconnect ----
    socket.on('disconnect', () => {
      log.info(`Dashboard disconnected: ${user.username}`);
    });
  });

  log.info('Dashboard namespace handler ready');
}

async function sendDeviceList(socket: Socket): Promise<void> {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 }).lean();
    socket.emit('dash:devices-update', {
      devices: devices.map((d) => ({
        id: d._id.toString(),
        name: d.name,
        hostname: d.hostname,
        platform: d.platform,
        arch: d.arch,
        status: d.status,
        lastSeen: d.lastSeen?.toISOString() ?? null,
        enrolledAt: d.enrolledAt?.toISOString() ?? new Date().toISOString(),
        labels: d.labels,
        agentVersion: d.agentVersion,
        systemInfo: d.systemInfo,
        group: d.group ?? null,
        alias: d.alias ?? '',
        sessionLocked: sessionStateStore.get(d._id.toString())?.locked ?? false,
      })),
    });
  } catch (err) {
    log.error('Failed to send device list:', err);
  }
}
