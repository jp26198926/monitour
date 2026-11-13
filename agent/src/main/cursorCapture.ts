import koffi from 'koffi';
import type { CursorShape } from '@monitour/shared';
import { getSessionState } from './lockState.js';
import { attachToInputDesktop } from './winInput.js';

// ---- Win32 types ----
const BOOL = koffi.types.int32;
const LONG = koffi.types.int32;
const INT = koffi.types.int32;
const UINT = koffi.types.uint32;
const HANDLE = koffi.types.uint64;

// ---- Win32 constants ----
const CURSOR_SHOWING = 0x00000001;
const DI_NORMAL = 0x0003;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const BLACKNESS = 0x00000042;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

// ---- FFI (koffi, same pattern as winInput.ts) ----
const user32 = koffi.load('user32');
const gdi32 = koffi.load('gdi32');

const GetCursorInfo = user32.func('GetCursorInfo', BOOL, [koffi.pointer(koffi.types.void)]) as (p: unknown) => number;
const GetIconInfo = user32.func('GetIconInfo', BOOL, [HANDLE, koffi.pointer(koffi.types.void)]) as (h: bigint, p: unknown) => number;
const DrawIconEx = user32.func('DrawIconEx', BOOL, [HANDLE, INT, INT, HANDLE, INT, INT, UINT, HANDLE, UINT]) as (
  dc: bigint, x: number, y: number, h: bigint, w: number, ht: number, step: number, brush: bigint, flags: number,
) => number;
const GetSystemMetrics = user32.func('GetSystemMetrics', LONG, [LONG]) as (i: number) => number;

const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', HANDLE, [HANDLE]) as (h: bigint) => bigint;
const CreateDIBSection = gdi32.func('CreateDIBSection', HANDLE, [
  HANDLE, koffi.pointer(koffi.types.void), UINT, koffi.pointer(koffi.types.void), HANDLE, UINT,
]) as (dc: bigint, bmi: unknown, usage: number, bitsSlot: unknown, sec: bigint, off: number) => bigint;
const SelectObject = gdi32.func('SelectObject', HANDLE, [HANDLE, HANDLE]) as (dc: bigint, obj: bigint) => bigint;
const PatBlt = gdi32.func('PatBlt', BOOL, [HANDLE, INT, INT, INT, INT, UINT]) as (
  dc: bigint, x: number, y: number, w: number, h: number, rop: number,
) => number;
const GetDIBits = gdi32.func('GetDIBits', INT, [
  HANDLE, HANDLE, UINT, UINT, koffi.pointer(koffi.types.void), koffi.pointer(koffi.types.void), UINT,
]) as (dc: bigint, bm: bigint, start: number, lines: number, bits: unknown, bmi: unknown, usage: number) => number;
const GetObjectW = gdi32.func('GetObjectW', INT, [HANDLE, INT, koffi.pointer(koffi.types.void)]) as (h: bigint, n: number, p: unknown) => number;
const DeleteObject = gdi32.func('DeleteObject', BOOL, [HANDLE]) as (h: bigint) => number;
const DeleteDC = gdi32.func('DeleteDC', BOOL, [HANDLE]) as (h: bigint) => number;

function hb(v: bigint | number): bigint {
  return typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
}

/** BITMAPINFOHEADER (40 bytes). positive height = bottom-up; negative = top-down. */
function buildBmi(width: number, height: number, bitCount: number, topDown: boolean): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(topDown ? -height : height, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(bitCount, 14);
  buf.writeUInt32LE(BI_RGB, 16);
  return buf;
}

function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface RawShape {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  pixels: Buffer; // BGRA
}

/**
 * Capture the cursor's pixels via GetIconInfo + DrawIconEx onto a 32bpp DIB.
 * Returns null on any failure — caller keeps the previous shape.
 */
function captureShape(hCursor: bigint): RawShape | null {
  // CURSORINFO/ICONINFO layouts (x64): see notes on offsets below
  const ii = Buffer.alloc(32); // ICONINFO: fIcon@0, xHotspot@4, yHotspot@8, pad@12, hbmMask@16, hbmColor@24
  if (!GetIconInfo(hCursor, ii)) return null;
  const hotspotX = ii.readUInt32LE(4);
  const hotspotY = ii.readUInt32LE(8);
  const hbmMask = ii.readBigUInt64LE(16);
  const hbmColor = ii.readBigUInt64LE(24);

  let memDc = 0n;
  let hDib = 0n;
  let oldObj = 0n;
  try {
    // BITMAP struct (32 bytes): bmType@0, bmWidth@4, bmHeight@8
    const src = hbmColor !== 0n ? hbmColor : hbmMask;
    const bm = Buffer.alloc(32);
    if (src === 0n || !GetObjectW(src, 32, bm)) return null;
    const width = bm.readInt32LE(4);
    let height = bm.readInt32LE(8);
    if (width <= 0 || height <= 0) return null;
    if (hbmColor === 0n) height = Math.trunc(height / 2); // monochrome mask = AND + XOR stacked
    if (width > 256 || height > 256) return null;

    memDc = hb(CreateCompatibleDC(0n));
    if (!memDc) return null;

    const bitsSlot = Buffer.alloc(8); // CreateDIBSection writes the bits pointer here; we read pixels via GetDIBits instead
    const bmi = buildBmi(width, height, 32, true);
    hDib = hb(CreateDIBSection(memDc, bmi, DIB_RGB_COLORS, bitsSlot, 0n, 0));
    if (!hDib) return null;
    oldObj = hb(SelectObject(memDc, hDib));

    PatBlt(memDc, 0, 0, width, height, BLACKNESS); // zero incl. alpha so uncovered pixels stay transparent
    DrawIconEx(memDc, 0, 0, hCursor, width, height, 0, 0n, DI_NORMAL);

    const pixels = Buffer.alloc(width * height * 4);
    const outBmi = buildBmi(width, height, 32, true);
    const got = GetDIBits(memDc, hDib, 0, height, pixels, outBmi, DIB_RGB_COLORS);
    if (got !== height) return null;

    // Alpha normalize. Three cases:
    //  - partial alpha present     -> true ARGB cursor, keep as-is
    //  - only 0/255 alpha          -> mask-style render by GDI, keep as-is
    //  - all alpha zero            -> alpha was stripped; recover via the AND mask
    let hasOpaque = false;
    let hasPartial = false;
    for (let i = 3; i < pixels.length; i += 4) {
      const a = pixels[i];
      if (a === 255) hasOpaque = true;
      else if (a > 0) { hasPartial = true; break; }
    }
    if (!hasOpaque && !hasPartial) {
      let recovered = false;
      if (hbmMask !== 0n) {
        // Read the AND mask (top `height` rows; the mono mask is 2x tall when there is no color bitmap).
        // Requesting 32bpp converts 1bpp mask bits to black/white pixels; bright = transparent.
        const maskH = hbmColor !== 0n ? height : height * 2;
        const maskBmi = buildBmi(width, maskH, 32, true);
        const maskBuf = Buffer.alloc(width * maskH * 4);
        const gotMask = GetDIBits(memDc, hbmMask, 0, maskH, maskBuf, maskBmi, DIB_RGB_COLORS);
        if (gotMask === maskH) {
          recovered = true;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const m = (y * width + x) * 4;
              pixels[m + 3] = maskBuf[m + 1] > 127 ? 0 : 255;
            }
          }
        }
      }
      if (!recovered) {
        for (let i = 3; i < pixels.length; i += 4) {
          const o = i - 3;
          pixels[i] = pixels[o] | pixels[o + 1] | pixels[o + 2] ? 255 : 0;
        }
      }
    }

    return { width, height, hotspotX, hotspotY, pixels };
  } catch {
    return null;
  } finally {
    if (oldObj) SelectObject(memDc, oldObj);
    if (hDib) DeleteObject(hDib);
    if (memDc) DeleteDC(memDc);
    if (hbmMask) DeleteObject(hbmMask);
    if (hbmColor) DeleteObject(hbmColor);
  }
}

function getCursorPos(): { flags: number; hCursor: bigint; x: number; y: number } | null {
  // CURSORINFO (24 bytes, x64): cbSize@0, flags@4, hCursor@8, pt.x@16, pt.y@20
  const ci = Buffer.alloc(24);
  ci.writeUInt32LE(24, 0);
  if (!GetCursorInfo(ci)) return null;
  return {
    flags: ci.readUInt32LE(4),
    hCursor: ci.readBigUInt64LE(8),
    x: ci.readInt32LE(16),
    y: ci.readInt32LE(20),
  };
}

export interface CursorSample {
  x: number; // percent 0-100 of primary monitor
  y: number;
  visible: boolean;
  shapeId: number;
}

export interface CursorCaptureHandlers {
  onState: (s: CursorSample) => void;
  onShape: (shape: CursorShape) => void;
}

const POLL_MS = 33; // 30 Hz
const REHASH_MS = 500; // catch animated cursors that keep the same handle

let shapeIdCounter = 0;

/**
 * Poll the OS cursor (position + shape) while a desktop session is live.
 * Emits onState on position/visibility change and onShape once per shape change.
 * Returns a stop function. Never throws — FFI errors degrade to visible:false.
 */
export function startCursorCapture(h: CursorCaptureHandlers): () => void {
  let lastX = 0;
  let lastY = 0;
  let lastVisible: boolean | null = null;
  let currentShapeId = 0;
  let lastHCursor = 0n;
  let lastHash = 0;
  let lastShapeCheck = 0;
  let triedAttach = false;

  const emitShape = (raw: RawShape): void => {
    currentShapeId = ++shapeIdCounter;
    lastHash = fnv1a(raw.pixels);
    h.onShape({
      shapeId: currentShapeId,
      width: raw.width,
      height: raw.height,
      hotspotX: raw.hotspotX,
      hotspotY: raw.hotspotY,
      pixels: raw.pixels,
    });
  };

  const tick = (): void => {
    try {
      // Best-effort: read the Winlogon desktop's cursor when the session is locked.
      if (!triedAttach && getSessionState().locked) {
        triedAttach = true;
        attachToInputDesktop();
      }

      const screenW = GetSystemMetrics(SM_CXSCREEN);
      const screenH = GetSystemMetrics(SM_CYSCREEN);
      const info = getCursorPos();
      const inPrimary = !!info && info.x >= 0 && info.y >= 0 && info.x < screenW && info.y < screenH;
      const visible = !!info && (info.flags & CURSOR_SHOWING) !== 0 && inPrimary;

      const x = visible ? (info!.x / screenW) * 100 : lastX;
      const y = visible ? (info!.y / screenH) * 100 : lastY;

      if (visible && info && (info.hCursor !== lastHCursor || Date.now() - lastShapeCheck > REHASH_MS)) {
        lastShapeCheck = Date.now();
        lastHCursor = info.hCursor;
        const raw = captureShape(info.hCursor);
        if (raw) {
          const hash = fnv1a(raw.pixels);
          if (hash !== lastHash || currentShapeId === 0) emitShape(raw);
        }
      }

      const rx = Math.round(x * 100) / 100;
      const ry = Math.round(y * 100) / 100;
      if (rx !== lastX || ry !== lastY || visible !== lastVisible) {
        lastX = rx;
        lastY = ry;
        lastVisible = visible;
        h.onState({ x: rx, y: ry, visible, shapeId: currentShapeId });
      }
    } catch (err) {
      console.error('Cursor capture error:', err);
    }
  };

  const timer = setInterval(tick, POLL_MS);
  tick();
  return () => clearInterval(timer);
}
