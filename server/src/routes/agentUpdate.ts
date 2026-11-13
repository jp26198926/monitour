import { Router } from 'express';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import multer from 'multer';
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
  mkdirSync(getUpdatesDir(), { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, getUpdatesDir()),
      filename: (_req, file, cb) => cb(null, basename(file.originalname)),
    }),
    limits: { fileSize: cfg.MAX_UPLOAD_SIZE },
  });

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
    const filename = basename(String(req.params.filename)); // prevent path traversal
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

  // POST /api/agent/updates — upload a new agent update package (admin)
  router.post('/updates', requireAuth(cfg), requireRole('admin'), upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const { version, platform, arch, notes } = req.body as Record<string, string>;
    if (!version) {
      unlinkSync(file.path);
      res.status(400).json({ error: 'version is required' });
      return;
    }

    // Write manifest
    const manifest: UpdateManifest = {
      version,
      platform: (platform || process.platform) as NodeJS.Platform,
      arch: arch || process.arch,
      filename: file.filename,
      downloadUrl: `/api/agent/download/${file.filename}`,
      notes: notes || '',
      publishedAt: new Date().toISOString(),
    };
    writeFileSync(join(getUpdatesDir(), 'manifest.json'), JSON.stringify(manifest, null, 2));
    log.info(`Update uploaded: ${file.filename} (version ${version})`);
    res.json({ ok: true, manifest });
  });

  // DELETE /api/agent/updates/:filename — remove an update file (admin)
  router.delete('/updates/:filename', requireAuth(cfg), requireRole('admin'), (req, res) => {
    const filename = basename(String(req.params.filename));
    const filepath = join(getUpdatesDir(), filename);
    if (!existsSync(filepath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    unlinkSync(filepath);
    log.info(`Update deleted: ${filename}`);
    res.json({ ok: true });
  });

  return router;
}
