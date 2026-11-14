import { Router } from 'express';
import { z } from 'zod';
import { Device, EnrollmentKey } from '../db/index.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth/middleware.js';
import { signDeviceToken } from '../auth/jwt.js';
import { publicKeyFingerprint } from '../certs/certOps.js';
import type { Config } from '../config.js';
import type { ServerCerts } from '../certs/certOps.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('enrollment');

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  group: z.string().max(64).nullable().optional(),
  labels: z.array(z.string().max(64)).max(32).optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
});

const enrollSchema = z.object({
  enrollmentKey: z.string().min(10),
  hostname: z.string().min(1).max(128),
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  agentVersion: z.string().min(1).max(32),
  publicKeyPem: z.string().min(100).max(4000),
});

export function enrollmentRoutes(cfg: Config, certs: ServerCerts): Router {
  const router = Router();

  // ---- Reusable enrollment keys (embedded in server-generated agent packages) ----

  // POST /api/enrollment/keys — create a reusable enrollment key
  router.post('/keys', requireAuth(cfg), requireRole('admin'), async (req: AuthedRequest, res) => {
    const parsed = createKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { name, group, labels, maxUses, expiresInDays } = parsed.data;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

    const keyDoc = await EnrollmentKey.create({
      name,
      group: group ?? null,
      labels: labels ?? [],
      maxUses: maxUses ?? null,
      expiresAt,
      createdBy: req.user!.sub,
    });

    log.info(`Enrollment key created by ${req.user!.username}: ${keyDoc.name} (${keyDoc.key.slice(0, 8)}…)`);
    res.status(201).json({
      id: keyDoc._id.toString(),
      name: keyDoc.name,
      key: keyDoc.key, // full secret — shown once
      group: keyDoc.group,
      labels: keyDoc.labels,
      maxUses: keyDoc.maxUses,
      useCount: keyDoc.useCount,
      expiresAt: keyDoc.expiresAt?.toISOString() ?? null,
      revokedAt: null,
      createdAt: keyDoc.createdAt.toISOString(),
    });
  });

  // GET /api/enrollment/keys — list keys (secret masked)
  router.get('/keys', requireAuth(cfg), requireRole('admin'), async (_req, res) => {
    const keys = await EnrollmentKey.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      keys: keys.map((k) => ({
        id: k._id.toString(),
        name: k.name,
        key: k.key.slice(0, 8) + '…',
        group: k.group,
        labels: k.labels,
        maxUses: k.maxUses,
        useCount: k.useCount,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  });

  // POST /api/enrollment/keys/:id/revoke — block future enrolls with this key
  router.post('/keys/:id/revoke', requireAuth(cfg), requireRole('admin'), async (req, res) => {
    const keyDoc = await EnrollmentKey.findById(req.params.id);
    if (!keyDoc) {
      res.status(404).json({ error: 'Enrollment key not found' });
      return;
    }
    if (keyDoc.revokedAt === null) {
      keyDoc.revokedAt = new Date();
      await keyDoc.save();
    }
    log.info(`Enrollment key revoked: ${keyDoc.name} (${keyDoc.key.slice(0, 8)}…)`);
    res.json({ ok: true });
  });

  // POST /api/enrollment/enroll — agent exchanges an enrollment key for device credentials
  router.post('/enroll', async (req, res) => {
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { enrollmentKey, hostname, platform, arch, agentVersion, publicKeyPem } = parsed.data;

    // Enrollment keys are the only credential — always required
    const keyDoc = await EnrollmentKey.findOne({ key: enrollmentKey });
    if (!keyDoc) {
      res.status(401).json({ error: 'Valid enrollment key is required' });
      return;
    }
    if (!keyDoc.isValid()) {
      res.status(401).json({ error: 'Invalid, expired or revoked enrollment key' });
      return;
    }

    // Compute fingerprint of agent's public key
    let fingerprint: string;
    try {
      fingerprint = publicKeyFingerprint(publicKeyPem);
    } catch {
      res.status(400).json({ error: 'Invalid public key format' });
      return;
    }

    // Reject if this key is already enrolled
    const existing = await Device.findOne({ publicKeyFingerprint: fingerprint });
    if (existing) {
      res.status(409).json({ error: 'This agent key is already enrolled' });
      return;
    }

    // Derive device name from hostname
    const deviceName = hostname.slice(0, 64);

    const device = await Device.create({
      name: deviceName,
      hostname,
      platform,
      arch,
      agentVersion,
      publicKeyPem,
      publicKeyFingerprint: fingerprint,
      status: 'pending',
      group: keyDoc.group,
      labels: keyDoc.labels,
      enrollmentKeyId: keyDoc._id,
    });

    await EnrollmentKey.updateOne({ _id: keyDoc._id }, { $inc: { useCount: 1 } });

    const deviceToken = signDeviceToken(
      {
        sub: device._id.toString(),
        deviceId: device._id.toString(),
        fingerprint,
        typ: 'device',
      },
      cfg,
    );

    log.info(`Device enrolled: ${deviceName} (${device._id})`);
    res.status(201).json({
      deviceId: device._id.toString(),
      deviceName,
      deviceToken,
      serverCertHash: certs.agentCertHash,
      serverUrl: `http://${req.headers.host ?? 'localhost:' + cfg.PORT}`,
    });
  });

  return router;
}
