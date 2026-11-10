import { Router } from 'express';
import { z } from 'zod';
import { Device, EnrollmentToken } from '../db/index.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth/middleware.js';
import { signDeviceToken } from '../auth/jwt.js';
import { publicKeyFingerprint } from '../certs/certOps.js';
import type { Config } from '../config.js';
import type { ServerCerts } from '../certs/certOps.js';
import { getEnrollmentMode } from './settings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('enrollment');

const createTokenSchema = z.object({
  label: z.string().max(64).optional(),
  expiresInHours: z.number().int().positive().max(24 * 90).default(24),
});

const enrollSchema = z.object({
  enrollmentToken: z.string().min(10).optional(),
  hostname: z.string().min(1).max(128),
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  agentVersion: z.string().min(1).max(32),
  publicKeyPem: z.string().min(100).max(4000),
});

export function enrollmentRoutes(cfg: Config, certs: ServerCerts): Router {
  const router = Router();

  // POST /api/enrollment/tokens — admin creates a one-time enrollment token
  router.post('/tokens', requireAuth(cfg), requireRole('admin'), async (req: AuthedRequest, res) => {
    const parsed = createTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { label, expiresInHours } = parsed.data;
    const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);

    const token = await EnrollmentToken.create({
      label: label ?? `token-${Date.now()}`,
      createdBy: req.user!.sub,
      expiresAt,
    });

    log.info(`Enrollment token created by ${req.user!.username}: ${token.token.slice(0, 8)}…`);
    res.status(201).json({
      token: token.token,
      label: token.label,
      expiresAt: token.expiresAt.toISOString(),
      used: false,
    });
  });

  // GET /api/enrollment/tokens — list tokens
  router.get('/tokens', requireAuth(cfg), requireRole('admin'), async (_req, res) => {
    const tokens = await EnrollmentToken.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      tokens: tokens.map((t) => ({
        token: t.token.slice(0, 8) + '…',
        fullToken: t.token,
        label: t.label,
        expiresAt: t.expiresAt.toISOString(),
        used: t.usedAt !== null,
      })),
    });
  });

  // POST /api/enrollment/enroll — agent exchanges enrollment token for device credentials
  router.post('/enroll', async (req, res) => {
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { enrollmentToken, hostname, platform, arch, agentVersion, publicKeyPem } = parsed.data;

    // Check enrollment mode
    const mode = await getEnrollmentMode();
    let tokenDoc = null;
    if (mode === 'locked') {
      // Token is required
      if (!enrollmentToken) {
        res.status(401).json({ error: 'Enrollment token is required' });
        return;
      }
      tokenDoc = await EnrollmentToken.findOne({ token: enrollmentToken });
      if (!tokenDoc || !tokenDoc.isValid()) {
        res.status(401).json({ error: 'Invalid or expired enrollment token' });
        return;
      }
    }
    // If mode === 'open', no token needed

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
    });

    if (tokenDoc) {
      tokenDoc.usedAt = new Date();
      tokenDoc.usedByDevice = device._id;
      await tokenDoc.save();
    }

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
