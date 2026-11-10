import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';
import axios from 'axios';
import bcrypt from 'bcryptjs';

const AGENT_VERSION = '0.2.0';

export interface AgentConfig {
  serverUrl: string;
  enrollmentToken?: string;
  deviceName?: string;
  /** Hashed password to protect settings from unauthorized changes. */
  passwordHash?: string;
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
  publicKeyPem?: string;
  privateKeyPem?: string;
}

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
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveAgentConfig(cfg: AgentConfig): void {
  ensureDir(getConfigDir());
  writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
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
  const { publicKeyPem } = loadOrCreateKeyPair();
  const hostname = (await import('node:os')).hostname();

  console.log(`Enrolling with ${cfg.serverUrl}…`);

  const resp = await axios.post(
    `${cfg.serverUrl}/api/enrollment/enroll`,
    {
      enrollmentToken: cfg.enrollmentToken,
      hostname,
      platform: process.platform,
      arch: process.arch,
      agentVersion: AGENT_VERSION,
      publicKeyPem,
    },
    { timeout: 15_000 },
  );

  const credentials = resp.data as DeviceCredentials;
  const state: AgentState = {
    enrolled: true,
    credentials,
    publicKeyPem,
  };
  saveAgentState(state);

  console.log(`Enrolled as device: ${credentials.deviceName} (${credentials.deviceId})`);
  return credentials;
}

/**
 * Verify the server's certificate hash matches what we expect (pinning).
 */
export function verifyServerCertHash(expectedHash: string, actualCertPem: string): boolean {
  const actualHash = createHash('sha256').update(actualCertPem).digest('hex');
  return actualHash === expectedHash;
}

export function getAgentVersion(): string {
  return AGENT_VERSION;
}
