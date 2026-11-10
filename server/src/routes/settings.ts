import { Router } from 'express';
import { z } from 'zod';
import { ServerSettings } from '../db/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('settings');

const updateModeSchema = z.object({
  mode: z.enum(['open', 'locked']),
});

async function getEnrollmentMode(): Promise<'open' | 'locked'> {
  const settings = await ServerSettings.findOne();
  return settings?.enrollmentMode ?? 'locked';
}

export function settingsRoutes(cfg: Config): Router {
  const router = Router();
  router.use(requireAuth(cfg));

  // GET /api/settings/enrollment-mode
  router.get('/enrollment-mode', requireRole('admin'), async (_req, res) => {
    const mode = await getEnrollmentMode();
    res.json({ mode });
  });

  // POST /api/settings/enrollment-mode
  router.post('/enrollment-mode', requireRole('admin'), async (req, res) => {
    const parsed = updateModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input' });
      return;
    }
    await ServerSettings.findOneAndUpdate(
      {},
      { enrollmentMode: parsed.data.mode },
      { upsert: true, new: true },
    );
    log.info(`Enrollment mode set to: ${parsed.data.mode}`);
    res.json({ mode: parsed.data.mode });
  });

  return router;
}

export { getEnrollmentMode };
