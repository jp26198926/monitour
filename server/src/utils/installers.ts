import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallerInfo } from '@monitour/shared';

/** Installer file extension per platform. */
export const INSTALLER_EXT: Record<string, string> = {
  win32: '.exe',
  darwin: '.dmg',
  linux: '.AppImage',
};

export function getAgentPackagesDir(): string {
  return join(process.cwd(), 'agent-packages');
}

export function slotDir(platform: string, arch: string): string {
  return join(getAgentPackagesDir(), `${platform}-${arch}`);
}

export function installerInfo(path: string, name: string): InstallerInfo {
  const st = statSync(path);
  return { name, size: st.size, modifiedAt: st.mtime.toISOString() };
}

/** All installer files (matching the platform extension) currently in a slot. */
export function listSlotInstallers(platform: string, arch: string): string[] {
  const dir = slotDir(platform, arch);
  const ext = INSTALLER_EXT[platform]?.toLowerCase();
  if (!ext || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
}

export function findInstaller(platform: string, arch: string): { path: string; name: string } | null {
  const files = listSlotInstallers(platform, arch);
  if (files.length === 0) return null;
  return { path: join(slotDir(platform, arch), files[0]), name: files[0] };
}
