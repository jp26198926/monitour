#!/usr/bin/env node
/**
 * Copy built agent installers from agent/dist/ into the server's
 * agent-packages/<platform>-<arch>/ slot tree.
 *
 * Usage:  node deploy/assemble-agent-packages.mjs   (or: npm run assemble:packages)
 *
 * Matching is by pattern, not exact name (electron-builder names vary slightly
 * with version/platform). Exactly one installer per slot: existing same-
 * extension files in a slot are replaced.
 */
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'agent', 'dist');
const slotsDir = join(repoRoot, 'server', 'agent-packages');

const SLOTS = [
  'win32-x64', 'win32-arm64',
  'darwin-x64', 'darwin-arm64',
  'linux-x64', 'linux-arm64',
];
const SLOT_EXT = {
  win32: '.exe',
  darwin: '.dmg',
  linux: '.AppImage',
};
const IGNORE = new Set(['.blockmap', '.yml', '.zip', '.json', '.txt', '.map']);

/** arm64 marker at the end of the name stem (e.g. "App-1.2.3-arm64.dmg"). */
function hasArm64Marker(name) {
  const stem = basename(name, extname(name)).toLowerCase();
  return /(-arm64|_arm64| arm64)$/.test(stem);
}

/** Map a dist artifact to its slot, or null if not an installer we know. */
function slotFor(name) {
  const lower = name.toLowerCase();
  const ext = extname(name);
  if (IGNORE.has(ext.toLowerCase())) return null;
  if (lower.endsWith('.exe') && /setup|install/i.test(name)) {
    return hasArm64Marker(name) ? 'win32-arm64' : 'win32-x64';
  }
  if (lower.endsWith('.dmg')) {
    return hasArm64Marker(name) ? 'darwin-arm64' : 'darwin-x64';
  }
  if (lower.endsWith('.appimage')) {
    return hasArm64Marker(name) ? 'linux-arm64' : 'linux-x64';
  }
  return null;
}

function main() {
  if (!existsSync(distDir)) {
    console.error(`No build output at ${distDir}`);
    console.error('Run "npm run clean && npm run dist -- --win|--mac|--linux" in agent/ first.');
    process.exit(1);
  }

  // Group candidates per slot
  const candidates = Object.fromEntries(SLOTS.map((s) => [s, []]));
  for (const name of readdirSync(distDir)) {
    const slot = slotFor(name);
    if (slot) candidates[slot].push(name);
  }

  const rows = [];
  const missing = [];

  for (const slot of SLOTS) {
    const [platform] = slot.split('-');
    const ext = SLOT_EXT[platform].toLowerCase();
    const files = candidates[slot];
    const targetDir = join(slotsDir, slot);

    if (files.length === 0) {
      missing.push(slot);
      rows.push([slot, '—', 'MISSING', '']);
      continue;
    }

    // Newest by mtime wins when several candidates match one slot
    files.sort((a, b) => statSync(join(distDir, b)).mtimeMs - statSync(join(distDir, a)).mtimeMs);
    const pick = files[0];
    if (files.length > 1) {
      console.warn(`warning: ${files.length} candidates for ${slot} — keeping newest: ${pick}`);
      console.warn(`         (also found: ${files.slice(1).join(', ')})`);
    }

    mkdirSync(targetDir, { recursive: true });

    // Replace semantics: exactly one installer per slot
    const replaced = [];
    for (const old of readdirSync(targetDir)) {
      if (old.toLowerCase().endsWith(ext)) {
        unlinkSync(join(targetDir, old));
        replaced.push(old);
      }
    }

    copyFileSync(join(distDir, pick), join(targetDir, pick));
    rows.push([slot, pick, replaced.length ? `replaced ${replaced.join(', ')}` : 'copied', '']);
  }

  // Summary
  const w = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(`${w('SLOT', 14)} ${w('ARTIFACT', 42)} ACTION`);
  console.log('-'.repeat(80));
  for (const [slot, artifact, action] of rows) {
    console.log(`${w(slot, 14)} ${w(artifact, 42)} ${action}`);
  }
  console.log('');
  if (missing.length > 0) {
    console.log(`Still missing: ${missing.join(', ')}`);
    console.log('Build those on their target OS (native modules are prebuilt — no cross-building).');
    console.log('See deploy/README.md → "Packaging the Agent".');
  } else {
    console.log('All slots populated.');
  }
  console.log(`\nSlots are under ${slotsDir}`);
  console.log('Remote server? Upload the files via dashboard Settings → Add Agent, or scp this folder.');
}

main();
