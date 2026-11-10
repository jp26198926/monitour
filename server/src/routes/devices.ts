import { Router } from 'express';
import { z } from 'zod';
import { Device } from '../db/index.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth/middleware.js';
import { liveAgents } from '../socket/index.js';
import type { Config } from '../config.js';

const updateDeviceSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  labels: z.array(z.string().max(32)).max(20).optional(),
  notes: z.string().max(2000).optional(),
  group: z.string().max(64).nullable().optional(),
  alias: z.string().max(64).optional(),
});

export function deviceRoutes(cfg: Config): Router {
  const router = Router();
  router.use(requireAuth(cfg));

  // GET /api/devices
  router.get('/', async (_req, res) => {
    const devices = await Device.find().sort({ lastSeen: -1, enrolledAt: -1 }).lean();
    res.json({
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
      })),
    });
  });

  // GET /api/devices/:id
  router.get('/:id', async (req, res) => {
    const device = await Device.findById(req.params.id).lean();
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({
      id: device._id.toString(),
      name: device.name,
      hostname: device.hostname,
      platform: device.platform,
      arch: device.arch,
      status: device.status,
      lastSeen: device.lastSeen?.toISOString() ?? null,
      enrolledAt: device.enrolledAt?.toISOString() ?? new Date().toISOString(),
      labels: device.labels,
      agentVersion: device.agentVersion,
      systemInfo: device.systemInfo,
      notes: device.notes,
      group: device.group ?? null,
      alias: device.alias ?? '',
    });
  });

  // PATCH /api/devices/:id
  router.patch('/:id', requireRole('admin', 'operator'), async (req: AuthedRequest, res) => {
    const parsed = updateDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const device = await Device.findByIdAndUpdate(req.params.id, parsed.data, { new: true }).lean();
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ id: device._id.toString(), ...parsed.data });
  });

  // DELETE /api/devices/:id
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const deviceId = String(req.params.id);
    const device = await Device.findByIdAndDelete(deviceId);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    // Notify the connected agent (if any) and disconnect it
    const io = (req.app as { get?: (key: string) => unknown }).get?.('io');
    if (io && typeof io === 'object' && 'of' in io) {
      const agentNs = (io as import('socket.io').Server).of('/agent');
      const agentSocketId = liveAgents.get(deviceId);
      if (agentSocketId) {
        const agentSocket = agentNs.sockets.get(agentSocketId);
        if (agentSocket) {
          agentSocket.emit('server:device-deleted', { deviceId });
          // Give the agent a moment to receive it, then disconnect
          setTimeout(() => {
            agentSocket.disconnect(true);
          }, 500);
        }
        liveAgents.delete(deviceId);
      }
    }

    res.json({ ok: true });
  });

  return router;
}
