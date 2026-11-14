import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AgentBootstrap } from '@monitour/shared';

function configDir(): string {
  return join(homedir(), '.monitour-agent');
}

/** All locations a bootstrap file may occupy, in discovery order. */
function candidatePaths(): string[] {
  const names = ['bootstrap.json', 'monitour-bootstrap.json'];
  const dirs: string[] = [];

  const envPath = process.env.MONITOUR_BOOTSTRAP;
  if (envPath) return [envPath]; // explicit path wins outright

  if (process.platform === 'win32') {
    dirs.push(join(process.env.ProgramData ?? 'C:\\ProgramData', 'Monitour'));
  }
  dirs.push(configDir());
  dirs.push(dirname(process.execPath));
  dirs.push(process.cwd());

  return dirs.flatMap((d) => names.map((n) => join(d, n)));
}

/**
 * Find and read the server-generated bootstrap file, if any.
 * Only used on first run (no config.json yet).
 */
export function discoverBootstrap(): { bootstrap: AgentBootstrap; path: string } | null {
  for (const p of candidatePaths()) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as AgentBootstrap;
      if (parsed && parsed.v === 1 && parsed.serverUrl && parsed.enrollmentKey) {
        return { bootstrap: parsed, path: p };
      }
    } catch {
      // unreadable/invalid candidate — keep looking
    }
  }
  return null;
}

/** Delete every bootstrap candidate (called after successful enrollment). */
export function consumeBootstrap(): void {
  for (const p of candidatePaths()) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
