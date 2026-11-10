import type { Server as SocketIOServer, Socket } from 'socket.io';
import { verifyToken, isDevicePayload, isUserPayload, type DeviceTokenPayload, type UserTokenPayload } from '../auth/jwt.js';
import { Device } from '../db/index.js';
import type { Config } from '../config.js';
import type { ServerCerts } from '../certs/certOps.js';
import { createLogger } from '../utils/logger.js';
import { setupAgentNamespace } from './agentHandler.js';
import { setupDashboardNamespace } from './dashboardHandler.js';

const log = createLogger('socket');

/**
 * Tracks live agent connections: deviceId -> socket.id
 */
export const liveAgents = new Map<string, string>();

export function setupSocketHandlers(io: SocketIOServer, cfg: Config, certs: ServerCerts): void {
  // ---- Agent namespace (/agent) ----
  const agentNs = io.of('/agent');
  agentNs.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string })?.token
        ?? socket.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('Missing device token'));

      const payload = verifyToken<DeviceTokenPayload>(token, cfg);
      if (!isDevicePayload(payload)) return next(new Error('Invalid device token'));

      (socket.data as { device?: DeviceTokenPayload }).device = payload;
      next();
    } catch (err) {
      log.warn('Agent auth failed:', err);
      next(new Error('Authentication failed'));
    }
  });

  // ---- Dashboard namespace (/dashboard) ----
  const dashNs = io.of('/dashboard');
  dashNs.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string })?.token
        ?? socket.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('Missing user token'));

      const payload = verifyToken<UserTokenPayload>(token, cfg);
      if (!isUserPayload(payload)) return next(new Error('Invalid user token'));

      (socket.data as { user?: UserTokenPayload }).user = payload;
      next();
    } catch (err) {
      log.warn('Dashboard auth failed:', err);
      next(new Error('Authentication failed'));
    }
  });

  setupAgentNamespace(agentNs, cfg, certs);
  setupDashboardNamespace(dashNs, cfg);

  log.info('Socket.IO namespaces ready: /agent, /dashboard');
}

/** Find the live agent socket for a device, or undefined if offline. */
export function getAgentSocket(
  agentNs: SocketIOServer['of'] extends never ? never : ReturnType<SocketIOServer['of']>,
  deviceId: string,
): Socket | undefined {
  const socketId = liveAgents.get(deviceId);
  if (!socketId) return undefined;
  return agentNs.sockets.get(socketId);
}
