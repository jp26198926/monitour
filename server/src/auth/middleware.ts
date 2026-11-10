import type { Request, Response, NextFunction } from 'express';
import { verifyToken, isUserPayload, type UserTokenPayload, type DeviceTokenPayload } from './jwt.js';
import type { Config } from '../config.js';

export interface AuthedRequest extends Request {
  user?: UserTokenPayload;
  device?: DeviceTokenPayload;
}

export function requireAuth(cfg: Config) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    try {
      const payload = verifyToken(header.slice(7), cfg);
      if (!isUserPayload(payload)) {
        res.status(403).json({ error: 'User token required' });
        return;
      }
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

export function requireRole(...roles: UserTokenPayload['role'][]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
      return;
    }
    next();
  };
}
