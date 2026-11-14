import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import forge from 'node-forge';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { obfuscate, deobfuscate } from './obfuscation.js';
import { verifyTlsIdentity } from './pinning.js';
import { discoverBootstrap, consumeBootstrap } from './bootstrap.js';
import type { AgentBootstrap } from '@monitour/shared';

export interface AgentConfig {
  serverUrl: string;
  /** Reusable key — the only enrollment credential. */
  enrollmentKey?: string;
  deviceName?: string;
  /** Hashed password to protect settings from unauthorized changes. */
  passwordHash?: string;
  /** Pinned hashes delivered via the bootstrap. */
  serverCertHash?: string;
  webCertHash?: string;
  /** Auto-download and apply server updates (default true). */
  autoUpdate?: boolean;
  /** Show the system tray icon (default true). */
  showInTray?: boolean;
}

export interface DeviceCredentials {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  serverCertHash: string;
  serverUrl: string;
}

export interface AgentState {
  enrolled: boolean;
  credentials?: DeviceCredentials;
}

/** Config fields stored obfuscated at rest (obscurity, not security). */
const OBFUSCATED_FIELDS = ['serverUrl', 'enrollmentKey'] as const;

// Config directory: ~/.monitour-agent on all platforms
function getConfigDir(): string {
  return join(homedir(), '.monitour-agent');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

function getStatePath(): string {
  return join(getConfigDir(), 'state.json');
}

function getKeysDir(): string {
  return join(getConfigDir(), 'keys');
}

export function loadAgentConfig(): AgentConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    let legacyPlaintext = false;
    for (const field of OBFUSCATED_FIELDS) {
      const value = cfg[field];
      if (typeof value === 'string' && value.length > 0) {
        if (value.startsWith('obf:v1:')) {
          cfg[field] = deobfuscate(value);
        } else {
          legacyPlaintext = true; // pre-obfuscation config — migrate on next save
        }
      }
    }
    const parsed = cfg as unknown as AgentConfig;
    // Legacy cleanup: one-time tokens no longer exist
    if ((cfg as Record<string, unknown>).enrollmentToken !== undefined) {
      delete (cfg as Record<string, unknown>).enrollmentToken;
      legacyPlaintext = true;
    }
    if (legacyPlaintext) saveAgentConfig(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function saveAgentConfig(cfg: AgentConfig): void {
  ensureDir(getConfigDir());
  const out: Record<string, unknown> = { ...cfg };
  for (const field of OBFUSCATED_FIELDS) {
    const value = out[field];
    if (typeof value === 'string' && value.length > 0 && !value.startsWith('obf:v1:')) {
      out[field] = obfuscate(value);
    }
  }
  writeFileSync(getConfigPath(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

// ---- Settings password protection ----

export function isPasswordSet(): boolean {
  const cfg = loadAgentConfig();
  return !!(cfg?.passwordHash);
}

export function setConfigPassword(plain: string): void {
  const cfg = loadAgentConfig();
  if (!cfg) throw new Error('No configuration found');
  cfg.passwordHash = bcrypt.hashSync(plain, 12);
  saveAgentConfig(cfg);
}

export function verifyConfigPassword(plain: string): boolean {
  const cfg = loadAgentConfig();
  if (!cfg?.passwordHash) return true; // no password set — allow
  return bcrypt.compareSync(plain, cfg.passwordHash);
}

export function removeConfigPassword(): void {
  const cfg = loadAgentConfig();
  if (!cfg) return;
  delete cfg.passwordHash;
  saveAgentConfig(cfg);
}

export function loadAgentState(): AgentState {
  try {
    const raw = readFileSync(getStatePath(), 'utf-8');
    return JSON.parse(raw) as AgentState;
  } catch {
    return { enrolled: false };
  }
}

function saveAgentState(state: AgentState): void {
  ensureDir(getConfigDir());
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Generate (or load) the agent's RSA keypair.
 */
export function loadOrCreateKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const keysDir = getKeysDir();
  const privPath = join(keysDir, 'agent-key.pem');
  const pubPath = join(keysDir, 'agent-pub.pem');

  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKeyPem: readFileSync(privPath, 'utf-8'),
      publicKeyPem: readFileSync(pubPath, 'utf-8'),
    };
  }

  ensureDir(keysDir);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const publicKeyPem = forge.pki.publicKeyToPem(keys.publicKey);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

  writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, publicKeyPem);
  return { publicKeyPem, privateKeyPem };
}

/**
 * Enroll this agent with the server.
 */
export async function enroll(cfg: AgentConfig): Promise<DeviceCredentials> {
  if (!cfg.enrollmentKey) {
    throw new Error('Enrollment key is required');
  }
  const { publicKeyPem } = loadOrCreateKeyPair();
  const hostname = (await import('node:os')).hostname();

  console.log(`Enrolling with ${cfg.serverUrl}…`);

  // Transport pin for https deployments (no-op over plain http)
  await verifyTlsIdentity(cfg.serverUrl, cfg.webCertHash);

  const resp = await axios.post(
    `${cfg.serverUrl}/api/enrollment/enroll`,
    {
      enrollmentKey: cfg.enrollmentKey,
      hostname,
      platform: process.platform,
      arch: process.arch,
      agentVersion: getAgentVersion(),
      publicKeyPem,
    },
    { timeout: 15_000 },
  );

  const credentials = resp.data as DeviceCredentials;

  // Identity pin: the bootstrap's serverCertHash must match what the server says
  if (cfg.serverCertHash && credentials.serverCertHash !== cfg.serverCertHash) {
    throw new Error('Server identity mismatch — enrollment aborted');
  }

  const state: AgentState = {
    enrolled: true,
    credentials,
  };
  saveAgentState(state);

  console.log(`Enrolled as device: ${credentials.deviceName} (${credentials.deviceId})`);
  return credentials;
}

/**
 * Wipe the device identity (credentials + keypair) and any enrollment material.
 * Preserves config.json — including the settings password, server URL and
 * the autoUpdate preference.
 */
export function wipeDeviceIdentity(): void {
  const dir = getConfigDir();
  if (existsSync(join(dir, 'state.json'))) rmSync(join(dir, 'state.json'), { force: true });
  const keysDir = getKeysDir();
  if (existsSync(join(keysDir, 'agent-key.pem'))) rmSync(join(keysDir, 'agent-key.pem'), { force: true });
  if (existsSync(join(keysDir, 'agent-pub.pem'))) rmSync(join(keysDir, 'agent-pub.pem'), { force: true });
  const cfg = loadAgentConfig();
  if (cfg) {
    delete cfg.enrollmentKey;
    saveAgentConfig(cfg);
  }
}

/**
 * Change the server URL: wipe identity, rotate the keypair, re-enroll.
 * Preserves passwordHash and the autoUpdate preference.
 * The enrollment key is required for the new server — pass one explicitly, or
 * leave it blank to reuse the current key when the URL is unchanged.
 */
export async function changeServerUrl(newServerUrl: string, enrollmentKey?: string): Promise<DeviceCredentials> {
  const cfg = loadAgentConfig() ?? { serverUrl: newServerUrl };
  const normalized = newServerUrl.replace(/\/+$/, '');
  const sameServer = normalized === (cfg.serverUrl ?? '').replace(/\/+$/, '');

  const key = enrollmentKey?.trim() || (sameServer ? cfg.enrollmentKey : undefined);
  if (!key) {
    throw new Error('Enrollment key is required for the new server');
  }

  wipeDeviceIdentity();
  cfg.serverUrl = normalized;
  cfg.enrollmentKey = key;
  // New server = new trust anchor; the old pins no longer apply
  delete cfg.serverCertHash;
  delete cfg.webCertHash;
  saveAgentConfig(cfg);
  return enroll(cfg);
}

export interface AutoEnrollResult {
  credentials: DeviceCredentials;
  bootstrap: AgentBootstrap | null;
}

/**
 * Zero-input enrollment: consume a server-generated bootstrap (first run), or
 * retry when a key-bearing config exists but enrollment never completed.
 * Returns null when there is nothing to auto-enroll — the caller falls back to
 * the manual GUI/CLI flow.
 */
export async function autoEnrollIfPossible(): Promise<AutoEnrollResult | null> {
  const state = loadAgentState();
  if (state.enrolled && state.credentials) {
    return { credentials: state.credentials, bootstrap: null };
  }

  let cfg = loadAgentConfig();
  let bootstrap: AgentBootstrap | null = null;

  if (!cfg) {
    const found = discoverBootstrap();
    if (!found) return null;
    bootstrap = found.bootstrap;
    cfg = {
      serverUrl: bootstrap.serverUrl.replace(/\/+$/, ''),
      enrollmentKey: bootstrap.enrollmentKey,
      serverCertHash: bootstrap.serverCertHash,
      webCertHash: bootstrap.webCertHash,
      autoUpdate: bootstrap.autoUpdate ?? true,
    };
  } else if (!cfg.enrollmentKey) {
    return null; // manual enrollment territory (form / CLI env)
  }

  const credentials = await enroll(cfg);
  saveAgentConfig(cfg);
  consumeBootstrap();
  return { credentials, bootstrap };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
let cachedVersion: string | null = null;

export function getAgentVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(join(moduleDir, '../../package.json'), 'utf8')) as { version?: string };
      cachedVersion = pkg.version || '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}
