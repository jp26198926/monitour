import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Reversible obfuscation for secrets at rest in config.json (server URL,
 * enrollment material). This is OBSURITY, NOT SECURITY — anyone with the
 * agent binary can recover the app salt and decrypt the values. It exists to
 * stop casual inspection/copying of the config file, nothing more.
 */

const PREFIX = 'obf:v1:';
const APP_OBF_SALT = 'monitour-obf-salt-9f2c1d';

const key = createHash('sha256')
  .update('monitour-agent-obf-v1' + APP_OBF_SALT)
  .digest();

export function isObfuscated(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function obfuscate(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function deobfuscate(value: string): string {
  if (!isObfuscated(value)) return value; // legacy plaintext — pass through
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}
