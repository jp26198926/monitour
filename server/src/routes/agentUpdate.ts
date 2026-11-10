import { Router } from 'express';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { UpdateManifest } from '@monitour/shared';
import { createLogger } from '../utils/logger.js';

const log = createLogger('update');

function getUpdatesDir(): string {
  return join(process.cwd(), 'updates');
}

function readManifest(): UpdateManifest | null {
  const manifestPath = join(getUpdatesDir(), 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as UpdateManifest;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export function agentUpdateRoutes(cfg: Config): Router {
  const router = Router();

  // GET /api/agent/update-check — agent checks if an update is available
  // Auth: optional (device token or user token)
  router.get('/update-check', (req, res) => {
    const currentVersion = (req.query.version as string) || '0.0.0';
    const manifest = readManifest();

    if (!manifest || !manifest.filename) {
      res.json({ hasUpdate: false, currentVersion, manifest: null });
      return;
    }

    const hasUpdate = compareVersions(manifest.version, currentVersion) > 0;
    res.json({
      hasUpdate,
      currentVersion,
      manifest: hasUpdate ? manifest : null,
    });
  });

  // GET /api/agent/download/:filename — download update package
  router.get('/download/:filename', (req, res) => {
    const filename = basename(req.params.filename); // prevent path traversal
    const filepath = join(getUpdatesDir(), filename);
    if (!existsSync(filepath)) {
      res.status(404).json({ error: 'Update file not found' });
      return;
    }
    log.info(`Update download: ${filename}`);
    res.sendFile(filepath);
  });

  // GET /api/agent/updates — list available update files (admin)
  router.get('/updates', requireAuth(cfg), requireRole('admin'), (_req, res) => {
    const dir = getUpdatesDir();
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f !== 'manifest.json')
          .map((f) => {
            const st = statSync(join(dir, f));
            return { name: f, size: st.size, modifiedAt: st.mtime.toISOString() };
          })
      : [];
    res.json({ manifest: readManifest(), files });
  });

  return router;
}
