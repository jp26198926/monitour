import { Router } from 'express';
import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, createReadStream, copyFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { requireAuth, requireRole, requireDeviceAuth, type AuthedRequest } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { Device } from '../db/index.js';
import { findInstaller, installerInfo, INSTALLER_EXT } from '../utils/installers.js';
import {
  ServerEvent,
  type UpdateManifest,
  type PublishUpdateRequest,
  type PublishedUpdatesResponse,
} from '@monitour/shared';
import { createLogger } from '../utils/logger.js';

const log = createLogger('update');

function sha256File(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filepath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function getUpdatesDir(): string {
  return join(process.cwd(), 'updates');
}

function manifestsPath(): string {
  return join(getUpdatesDir(), 'manifests.json');
}

/** Per '<platform>-<arch>' update manifests. Corrupt/missing file → empty map. */
function readManifests(): Record<string, UpdateManifest> {
  try {
    const raw = readFileSync(manifestsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, UpdateManifest>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeManifests(map: Record<string, UpdateManifest>): void {
  mkdirSync(getUpdatesDir(), { recursive: true });
  writeFileSync(manifestsPath(), JSON.stringify(map, null, 2));
}

/** One-time fold of a legacy single manifest.json into manifests.json. */
function migrateLegacyManifest(): void {
  const legacy = join(getUpdatesDir(), 'manifest.json');
  if (!existsSync(legacy)) return;
  try {
    const manifest = JSON.parse(readFileSync(legacy, 'utf-8')) as UpdateManifest;
    const platform = manifest.platform || process.platform;
    const arch = manifest.arch || process.arch;
    const key = `${platform}-${arch}`;
    const map = readManifests();
    map[key] = manifest;
    writeManifests(map);
    unlinkSync(legacy);
    log.info(`Migrated legacy manifest.json -> manifests.json[${key}]`);
  } catch (err) {
    log.warn('Could not migrate legacy manifest.json:', err instanceof Error ? err.message : err);
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

const slotParamsSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
});

const publishSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  version: z.string().min(1).max(32),
  notes: z.string().max(500).optional(),
});

export function agentUpdateRoutes(cfg: Config): Router {
  const router = Router();
  mkdirSync(getUpdatesDir(), { recursive: true });
  migrateLegacyManifest();

  // GET /api/agent/update-check — agent checks if an update is available for its slot
  router.get('/update-check', (req, res) => {
    const currentVersion = (req.query.version as string) || '0.0.0';
    const platform = (req.query.platform as string) || process.platform;
    const arch = (req.query.arch as string) || process.arch;

    const manifest = readManifests()[`${platform}-${arch}`] ?? null;
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

  // GET /api/agent/updates — published manifests + loose files (admin)
  router.get('/updates', requireAuth(cfg), requireRole('admin'), (_req, res) => {
    const dir = getUpdatesDir();
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f !== 'manifests.json' && f !== 'manifest.json')
          .map((f) => installerInfo(join(dir, f), f))
      : [];
    res.json({ manifests: readManifests(), files } satisfies PublishedUpdatesResponse);
  });

  // POST /api/agent/updates/publish — publish a slot installer as that slot's update (admin)
  router.post('/updates/publish', requireAuth(cfg), requireRole('admin'), async (req, res) => {
    const parsed = publishSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { platform, arch, version, notes } = parsed.data satisfies PublishUpdateRequest;

    const installer = findInstaller(platform, arch);
    if (!installer) {
      res.status(400).json({ error: `No installer in the ${platform}-${arch} slot to publish` });
      return;
    }

    // Copy (never reference) so later slot replacement doesn't mutate a published update
    const ext = INSTALLER_EXT[platform];
    const filename = `monitour-agent-${version}-${platform}-${arch}${ext}`;
    const dest = join(getUpdatesDir(), filename);
    const staging = `${dest}.staging`;
    try {
      copyFileSync(installer.path, staging);
      renameSync(staging, dest);
    } catch (err) {
      unlinkSync(staging);
      unlinkSync(dest);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to copy installer' });
      return;
    }

    const manifest: UpdateManifest = {
      version,
      platform,
      arch,
      filename,
      downloadUrl: `/api/agent/download/${filename}`,
      notes: notes ?? '',
      publishedAt: new Date().toISOString(),
      sha256: await sha256File(dest),
    };
    const map = readManifests();
    map[`${platform}-${arch}`] = manifest;
    writeManifests(map);
    log.info(`Update published: ${platform}-${arch} v${version} (${filename})`);

    // Broadcast is safe — each agent's update-check self-filters by its own slot
    const io = req.app.get('io') as SocketIOServer | undefined;
    if (io) {
      io.of('/agent').emit(ServerEvent.UpdateAvailable, manifest);
    }

    res.json({ ok: true, manifest });
  });

  // DELETE /api/agent/updates/:platform/:arch — unpublish a slot's update (admin)
  router.delete('/updates/:platform/:arch', requireAuth(cfg), requireRole('admin'), (req, res) => {
    const parsed = slotParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid platform or arch' });
      return;
    }
    const { platform, arch } = parsed.data;
    const key = `${platform}-${arch}`;
    const map = readManifests();
    const manifest = map[key];
    if (!manifest) {
      res.status(404).json({ error: 'No published update for this slot' });
      return;
    }
    delete map[key];
    writeManifests(map);
    if (manifest.filename) {
      const filepath = join(getUpdatesDir(), basename(manifest.filename));
      if (existsSync(filepath)) unlinkSync(filepath);
    }
    log.info(`Update unpublished: ${key} (was v${manifest.version})`);
    res.json({ ok: true });
  });

  // PATCH /api/agent/profile — agent updates its own display name (device JWT)
  const profileSchema = z.object({ deviceName: z.string().min(1).max(64).optional() });
  router.patch('/profile', requireDeviceAuth(cfg), async (req: AuthedRequest, res) => {
    const parsed = profileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const device = await Device.findById(req.device!.deviceId);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (parsed.data.deviceName !== undefined) {
      device.name = parsed.data.deviceName;
      await device.save();
    }
    res.json({ ok: true, deviceName: device.name });
  });

  return router;
}
