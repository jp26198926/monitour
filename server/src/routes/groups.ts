import { Router } from 'express';
import { z } from 'zod';
import { Group, Device } from '../db/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('groups');

const createGroupSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
});

export function groupRoutes(cfg: Config): Router {
  const router = Router();
  router.use(requireAuth(cfg));

  // GET /api/groups
  router.get('/', async (_req, res) => {
    const groups = await Group.find().sort({ name: 1 }).lean();
    // Get device counts per group
    const counts = await Device.aggregate([
      { $match: { group: { $ne: null } } },
      { $group: { _id: '$group', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    res.json({
      groups: groups.map((g) => ({
        id: g._id.toString(),
        name: g.name,
        description: g.description,
        deviceCount: countMap.get(g.name) ?? 0,
        createdAt: g.createdAt?.toISOString() ?? new Date().toISOString(),
      })),
    });
  });

  // POST /api/groups
  router.post('/', requireRole('admin', 'operator'), async (req, res) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const existing = await Group.findOne({ name: parsed.data.name });
    if (existing) {
      res.status(409).json({ error: 'Group name already exists' });
      return;
    }
    const group = await Group.create(parsed.data);
    log.info(`Group created: ${group.name}`);
    res.status(201).json({
      id: group._id.toString(),
      name: group.name,
      description: group.description,
      deviceCount: 0,
      createdAt: group.createdAt?.toISOString(),
    });
  });

  // PATCH /api/groups/:id
  router.patch('/:id', requireRole('admin', 'operator'), async (req, res) => {
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const group = await Group.findById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    // If renaming, update all devices that reference the old name
    if (parsed.data.name && parsed.data.name !== group.name) {
      const existing = await Group.findOne({ name: parsed.data.name });
      if (existing) {
        res.status(409).json({ error: 'Group name already exists' });
        return;
      }
      await Device.updateMany({ group: group.name }, { $set: { group: parsed.data.name } });
    }
    group.name = parsed.data.name ?? group.name;
    group.description = parsed.data.description ?? group.description;
    await group.save();
    log.info(`Group updated: ${group.name}`);
    res.json({ id: group._id.toString(), name: group.name, description: group.description });
  });

  // DELETE /api/groups/:id
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const group = await Group.findByIdAndDelete(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    // Unset group on all devices in this group
    await Device.updateMany({ group: group.name }, { $set: { group: null } });
    log.info(`Group deleted: ${group.name}`);
    res.json({ ok: true });
  });

  return router;
}
