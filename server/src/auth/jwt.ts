import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';

export interface UserTokenPayload {
  sub: string; // user id
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  typ: 'user';
}

export interface DeviceTokenPayload {
  sub: string; // device id
  deviceId: string;
  fingerprint: string;
  typ: 'device';
}

export type TokenPayload = UserTokenPayload | DeviceTokenPayload;

export function signUserToken(payload: UserTokenPayload, cfg: Config): string {
  return jwt.sign({ ...payload, typ: 'user' }, cfg.JWT_SECRET, {
    expiresIn: cfg.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function signDeviceToken(payload: DeviceTokenPayload, cfg: Config): string {
  return jwt.sign({ ...payload, typ: 'device' }, cfg.JWT_SECRET, {
    expiresIn: cfg.DEVICE_JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken<T extends TokenPayload>(token: string, cfg: Config): T {
  return jwt.verify(token, cfg.JWT_SECRET) as T;
}

export function isUserPayload(p: TokenPayload): p is UserTokenPayload {
  return p.typ === 'user';
}

export function isDevicePayload(p: TokenPayload): p is DeviceTokenPayload {
  return p.typ === 'device';
}
