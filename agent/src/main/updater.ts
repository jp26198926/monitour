import axios from 'axios';
import { mkdirSync, existsSync, createWriteStream, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { exec } from 'node:child_process';
import { getAgentVersion } from './enrollment.js';
import type { UpdateManifest } from '@monitour/shared';

const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

function getUpdateDir(): string {
  const dir = join(homedir(), '.monitour-agent', 'updates');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * Check the server for an available update.
 */
export async function checkForUpdates(serverUrl: string): Promise<UpdateManifest | null> {
  try {
    const currentVersion = getAgentVersion();
    const resp = await axios.get(`${serverUrl}/api/agent/update-check`, {
      params: { version: currentVersion, platform: platform(), arch: arch() },
      timeout: 10_000,
    });

    const data = resp.data as { hasUpdate: boolean; manifest: UpdateManifest | null };
    if (data.hasUpdate && data.manifest) {
      console.log(`Update available: ${currentVersion} -> ${data.manifest.version}`);
      return data.manifest;
    }
    return null;
  } catch (err) {
    console.error('Update check failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Download the update package to the local updates directory.
 */
export async function downloadUpdate(serverUrl: string, manifest: UpdateManifest): Promise<string> {
  const filename = basename(new URL(manifest.downloadUrl, serverUrl).pathname) || `monitour-agent-${manifest.version}`;
  const filepath = join(getUpdateDir(), filename);

  console.log(`Downloading update ${manifest.version} from ${manifest.downloadUrl}`);
  const resp = await axios.get(manifest.downloadUrl.startsWith('http') ? manifest.downloadUrl : `${serverUrl}${manifest.downloadUrl}`, {
    responseType: 'stream',
    timeout: 0, // no cap — a 500MB+ package on a slow link legitimately takes a long time
  });

  try {
    await pipeline(resp.data, createWriteStream(filepath));
  } catch (err) {
    rmSync(filepath, { force: true }); // never leave a truncated installer behind (applyUpdate executes it)
    throw err;
  }

  // Verify integrity when the server published a checksum
  if (manifest.sha256) {
    const { createHash } = await import('node:crypto');
    const { createReadStream } = await import('node:fs');
    const actual = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(filepath)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
    if (actual !== manifest.sha256) {
      rmSync(filepath, { force: true });
      throw new Error(`Update checksum mismatch (expected ${manifest.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    }
    console.log('Update checksum verified');
  }

  console.log(`Update downloaded: ${filepath}`);
  return filepath;
}

/**
 * Apply the downloaded update and restart.
 */
export function applyUpdate(filepath: string): void {
  const plat = platform();
  console.log(`Applying update: ${filepath}`);

  switch (plat) {
    case 'win32':
      // Run the NSIS installer silently
      exec(`"${filepath}" /S`, (err) => {
        if (err) {
          console.error('Update failed:', err);
        } else {
          console.log('Update installed. Restarting...');
          setTimeout(() => {
            // Restart the Electron app or Node process
            process.exit(0);
          }, 2000);
        }
      });
      break;

    case 'linux':
      // Make AppImage executable and replace
      exec(`chmod +x "${filepath}" && cp "${filepath}" "${process.execPath}" && echo "Update applied"`, (err) => {
        if (err) {
          console.error('Update failed:', err);
        } else {
          console.log('Update applied. Restarting...');
          setTimeout(() => process.exit(0), 2000);
        }
      });
      break;

    case 'darwin':
      // Mount DMG and copy
      exec(`hdiutil attach "${filepath}" -nobrowse && cp -R "/Volumes/Monitour Agent/Monitour Agent.app" "/Applications/" && hdiutil detach "/Volumes/Monitour Agent"`, (err) => {
        if (err) {
          console.error('Update failed:', err);
        } else {
          console.log('Update applied. Restarting...');
          setTimeout(() => process.exit(0), 2000);
        }
      });
      break;
  }
}

/**
 * Start periodic update checks.
 * With autoUpdate the download+install runs automatically; otherwise the
 * caller is only notified (GUI banner / manual button).
 */
export interface UpdateCheckerOptions {
  autoUpdate: boolean;
  onUpdateAvailable?: (manifest: UpdateManifest) => void;
  onProgress?: (progress: { stage: string; message: string; version?: string }) => void;
}

export function startUpdateChecker(
  serverUrl: string,
  opts: UpdateCheckerOptions,
): { stop: () => void; checkNow: () => Promise<void> } {
  async function runCheck(): Promise<void> {
    const manifest = await checkForUpdates(serverUrl);
    if (!manifest) return;
    opts.onUpdateAvailable?.(manifest);
    if (!opts.autoUpdate) return;

    opts.onProgress?.({ stage: 'downloading', message: `Downloading ${manifest.version}`, version: manifest.version });
    try {
      const filepath = await downloadUpdate(serverUrl, manifest);
      opts.onProgress?.({ stage: 'installing', message: `Installing ${manifest.version}`, version: manifest.version });
      applyUpdate(filepath);
      opts.onProgress?.({ stage: 'done', message: `Update ${manifest.version} applied`, version: manifest.version });
    } catch (err) {
      opts.onProgress?.({
        stage: 'error',
        message: err instanceof Error ? err.message : String(err),
        version: manifest.version,
      });
    }
  }

  // Check immediately
  void runCheck();

  // Check periodically
  const timer = setInterval(() => void runCheck(), UPDATE_CHECK_INTERVAL);

  return { stop: () => clearInterval(timer), checkNow: runCheck };
}
