import { readdir, stat, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import os from 'node:os';

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/**
 * List directory contents.
 */
export async function listDirectory(dirPath: string): Promise<FileListEntry[]> {
  const resolved = safePath(dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });

  const results: FileListEntry[] = [];
  for (const entry of entries) {
    try {
      const full = join(resolved, entry.name);
      const st = await stat(full);
      results.push({
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    } catch {
      // skip inaccessible entries
    }
  }

  results.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Read a file as a buffer (for download).
 */
export async function readFile(filePath: string): Promise<Buffer> {
  const { readFile: fsRead } = await import('node:fs/promises');
  return fsRead(safePath(filePath));
}

/**
 * Write a file (for upload).
 */
export async function writeFileBuffer(filePath: string, data: Buffer): Promise<void> {
  const resolved = safePath(filePath);
  await mkdir(join(resolved, '..'), { recursive: true }).catch(() => {});
  await writeFile(resolved, data);
}

/**
 * Delete a file or empty directory.
 */
export async function deleteFile(filePath: string): Promise<void> {
  await unlink(safePath(filePath));
}

/**
 * Create a directory.
 */
export async function createDirectory(dirPath: string): Promise<void> {
  await mkdir(safePath(dirPath), { recursive: true });
}

/**
 * Remove directory recursively.
 */
export async function removeDirectory(dirPath: string): Promise<void> {
  await rm(safePath(dirPath), { recursive: true, force: true });
}

/**
 * Resolve a path safely — prevent directory traversal outside of the home directory.
 */
function safePath(input: string): string {
  const resolved = resolve(input);
  const home = resolve(os.homedir());
  if (!resolved.startsWith(home) && !resolved.startsWith(sep)) {
    throw new Error(`Access denied: path outside home directory`);
  }
  return resolved;
}

export function getHomeDir(): string {
  return os.homedir();
}
