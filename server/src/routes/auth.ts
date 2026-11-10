import { Router } from 'express';
import { z } from 'zod';
import { User } from '../db/index.js';
import { signUserToken } from '../auth/jwt.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

const loginSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
});

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-z0-9_.-]+$/),
  password: z.string().min(8).max(128),
  displayName: z.string().max(64).optional(),
});

export function authRoutes(cfg: Config): Router {
  const router = Router();

  // POST /api/auth/register — first user becomes admin; afterwards admin-only
  router.post('/register', async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { username, password, displayName } = parsed.data;

    const existingCount = await User.countDocuments();
    if (existingCount > 0) {
      // Only an admin can create additional users
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        res.status(403).json({ error: 'Server already initialized. Admin access required to create users.' });
        return;
      }
      try {
        const { verifyToken, isUserPayload } = await import('../auth/jwt.js');
        const payload = verifyToken(header.slice(7), cfg);
        if (!isUserPayload(payload) || payload.role !== 'admin') {
          res.status(403).json({ error: 'Only admins can create new users' });
          return;
        }
      } catch {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const passwordHash = await User.hashPassword(password);
    const role = existingCount === 0 ? 'admin' : 'operator';
    const user = await User.create({
      username: username.toLowerCase(),
      passwordHash,
      displayName: displayName || username,
      role,
    });

    log.info(`User created: ${user.username} (role=${role})`);
    const token = signUserToken({ sub: user._id.toString(), username: user.username, role, typ: 'user' }, cfg);
    res.status(201).json({
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        createdAt: (user as { createdAt?: Date }).createdAt?.toISOString() ?? new Date().toISOString(),
      },
    });
  });

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input' });
      return;
    }
    const { username, password } = parsed.data;

    const user = await User.findOne({ username: username.toLowerCase() }).select('+passwordHash');
    if (!user || !(await user.comparePassword(password))) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    user.lastLoginAt = new Date();
    await user.save();

    const role = user.role as 'admin' | 'operator' | 'viewer';
    const token = signUserToken({ sub: user._id.toString(), username: user.username, role, typ: 'user' }, cfg);
    log.info(`User logged in: ${user.username}`);
    res.json({
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        displayName: user.displayName,
        role,
        createdAt: (user as { createdAt?: Date }).createdAt?.toISOString() ?? new Date().toISOString(),
      },
    });
  });

  // GET /api/auth/me
  router.get('/me', requireAuth(cfg), async (req: AuthedRequest, res) => {
    const user = await User.findById(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      createdAt: (user as { createdAt?: Date }).createdAt?.toISOString(),
    });
  });

  return router;
}
