/**
 * Lock screen capture helper — runs as SYSTEM in the console session.
 * Captures the Winlogon (secure) desktop using GDI DIB-section via koffi.
 * Writes JPEG frames to an output directory for the agent to relay.
 *
 * Usage: node lockCaptureHelper.js --desktop Winlogon --output %TEMP%\monitour-lock --fps 10
 */
import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';

// ---- Parse CLI args ----
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}
const targetDesktop = getArg('desktop', 'Winlogon');
const outputDir = getArg('output', path.join(process.env.TEMP || '.', 'monitour-lock'));
const fps = parseInt(getArg('fps', '10'), 10);
const intervalMs = Math.max(50, Math.round(1000 / fps));

// ---- Win32 types ----
const BOOL = koffi.types.int32;
const DWORD = koffi.types.uint32;
const HDC = koffi.types.uint64;
const HGDIOBJ = koffi.types.uint64;
const HWND = koffi.types.uint64;
const HANDLE = koffi.types.uint64;
const HDESK = koffi.types.uint64;
const LONG = koffi.types.int32;
const WORD = koffi.types.uint16;

// ---- Load DLLs ----
const user32 = koffi.load('user32');
const gdi32 = koffi.load('gdi32');

// ---- User32 functions ----
const OpenInputDesktop = user32.func('OpenInputDesktop', HDESK, [DWORD, BOOL, DWORD]) as (f: number, i: number, a: number) => number;
const OpenDesktopW = user32.func('OpenDesktopW', HDESK, [koffi.types.str16, DWORD, BOOL, DWORD]) as (n: string, f: number, i: number, a: number) => number;
const SetThreadDesktop = user32.func('SetThreadDesktop', BOOL, [HDESK]) as (h: number) => boolean;
const CloseDesktop = user32.func('CloseDesktop', BOOL, [HDESK]) as (h: number) => boolean;
const GetDesktopWindow = user32.func('GetDesktopWindow', HWND, []) as () => number;
const GetWindowDC = user32.func('GetWindowDC', HDC, [HWND]) as (h: number) => number;
const ReleaseDC = user32.func('ReleaseDC', BOOL, [HWND, HDC]) as (h: number, dc: number) => boolean;
const GetSystemMetrics = user32.func('GetSystemMetrics', LONG, [LONG]) as (i: number) => number;

// ---- GDI functions ----
const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', HDC, [HDC]) as (hdc: number) => number;
const DeleteDC = gdi32.func('DeleteDC', BOOL, [HDC]) as (hdc: number) => boolean;
const CreateDIBSection = gdi32.func('CreateDIBSection', HGDIOBJ, [HDC, koffi.pointer(koffi.types.void), DWORD, koffi.pointer(koffi.pointer(koffi.types.void)), HANDLE, DWORD]) as (
  hdc: number, bmi: unknown, usage: number, bits: unknown, section: number, offset: number,
) => number;
const SelectObject = gdi32.func('SelectObject', HGDIOBJ, [HDC, HGDIOBJ]) as (dc: number, obj: number) => number;
const DeleteObject = gdi32.func('DeleteObject', BOOL, [HGDIOBJ]) as (obj: number) => boolean;
const BitBlt = gdi32.func('BitBlt', BOOL, [HDC, LONG, LONG, LONG, LONG, HDC, LONG, LONG, DWORD]) as (
  dst: number, dx: number, dy: number, w: number, h: number, src: number, sx: number, sy: number, rop: number,
) => boolean;
const GetDIBits = gdi32.func('GetDIBits', BOOL, [HDC, HGDIOBJ, DWORD, DWORD, koffi.pointer(koffi.types.void), koffi.pointer(koffi.types.void), DWORD]) as (
  dc: number, bmp: number, start: number, lines: number, bits: unknown, bmi: unknown, usage: number,
) => boolean;

// ---- Constants ----
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SRCCOPY = 0x00CC0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_SWITCHDESKTOP = 0x0100;
const UOI_NAME = 2;

// ---- BITMAPINFOHEADER struct (40 bytes) ----
// We build it manually in a Buffer to avoid complex koffi struct definitions
function buildBitmapInfo(width: number, height: number): Buffer {
  const bmi = Buffer.alloc(40); // BITMAPINFOHEADER size
  bmi.writeUInt32LE(40, 0);      // biSize
  bmi.writeInt32LE(width, 4);    // biWidth
  bmi.writeInt32LE(-height, 8);  // biHeight (negative = top-down)
  bmi.writeUInt16LE(1, 12);      // biPlanes
  bmi.writeUInt16LE(32, 14);     // biBitCount (BGRA)
  bmi.writeUInt32LE(BI_RGB, 16); // biCompression
  bmi.writeUInt32LE(width * height * 4, 20); // biSizeImage
  bmi.writeInt32LE(0, 24);       // biXPelsPerMeter
  bmi.writeInt32LE(0, 28);       // biYPelsPerMeter
  bmi.writeUInt32LE(0, 32);       // biClrUsed
  bmi.writeUInt32LE(0, 36);       // biClrImportant
  return bmi;
}

// ---- Desktop attachment ----
function attachToDesktop(name: string): boolean {
  try {
    let hDesk: number;
    if (name === 'Default') {
      hDesk = OpenDesktopW('Default', 0, 0, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
    } else {
      hDesk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
    }
    if (!hDesk || hDesk === 0) {
      console.error(`Failed to open desktop "${name}"`);
      return false;
    }
    const ok = SetThreadDesktop(hDesk);
    if (!ok) {
      console.error(`SetThreadDesktop failed for "${name}"`);
      CloseDesktop(hDesk);
      return false;
    }
    // Keep the handle open — SetThreadDesktop requires it to stay valid
    console.log(`Attached to desktop "${name}" (handle=${hDesk})`);
    return true;
  } catch (err) {
    console.error(`Desktop attach error:`, err);
    return false;
  }
}

// ---- GDI DIB-section capture ----
function captureScreen(width: number, height: number): Buffer | null {
  const hwndDesktop = GetDesktopWindow();
  const screenDC = GetWindowDC(hwndDesktop);
  if (!screenDC) return null;

  const memDC = CreateCompatibleDC(screenDC);
  if (!memDC) {
    ReleaseDC(hwndDesktop, screenDC);
    return null;
  }

  const bmi = buildBitmapInfo(width, height);
  const bitsPtr = Buffer.alloc(8); // pointer output
  const hDib = CreateDIBSection(screenDC, bmi, DIB_RGB_COLORS, bitsPtr, 0, 0);
  if (!hDib) {
    DeleteDC(memDC);
    ReleaseDC(hwndDesktop, screenDC);
    return null;
  }

  const oldObj = SelectObject(memDC, hDib);
  const ok = BitBlt(memDC, 0, 0, width, height, screenDC, 0, 0, SRCCOPY);

  let pixels: Buffer | null = null;
  if (ok) {
    // Use GetDIBits to read from our DIB section into a buffer.
    // This works on DIB sections even on Winlogon (unlike CreateCompatibleBitmap).
    pixels = Buffer.alloc(width * height * 4);
    const readOk = GetDIBits(memDC, hDib, 0, height, pixels, bmi, DIB_RGB_COLORS);
    if (readOk) {
      // Convert BGRA → RGBA for JPEG encoder
      const pixelSize = width * height * 4;
      for (let i = 0; i < pixelSize; i += 4) {
        const b = pixels[i];
        const r = pixels[i + 2];
        pixels[i] = r;
        pixels[i + 2] = b;
      }
    } else {
      pixels = null;
    }
  }

  SelectObject(memDC, oldObj);
  DeleteObject(hDib);
  DeleteDC(memDC);
  ReleaseDC(hwndDesktop, screenDC);
  return pixels;
}

// ---- Main capture loop ----
async function main(): Promise<void> {
  console.log(`Lock capture helper starting (desktop=${targetDesktop}, output=${outputDir}, fps=${fps})`);

  // Attach to the target desktop
  if (!attachToDesktop(targetDesktop)) {
    console.error('Failed to attach to target desktop, exiting');
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const width = GetSystemMetrics(SM_CXSCREEN);
  const height = GetSystemMetrics(SM_CYSCREEN);
  console.log(`Screen size: ${width}x${height}`);

  let frameNum = 0;
  let running = true;

  // Handle graceful shutdown
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  // Write a ready marker file
  fs.writeFileSync(path.join(outputDir, 'ready'), String(Date.now()));

  while (running) {
    const t0 = Date.now();
    try {
      const pixels = captureScreen(width, height);
      if (pixels) {
        const jpegData = jpeg.encode({ data: pixels, width, height }, 80);
        // Atomic write: write to temp then rename
        const tmpPath = path.join(outputDir, `frame-${frameNum % 2}.tmp`);
        const finalPath = path.join(outputDir, 'frame.jpg');
        fs.writeFileSync(tmpPath, jpegData.data);
        fs.renameSync(tmpPath, finalPath);
        frameNum++;
      }
    } catch (err) {
      console.error('Capture error:', err);
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, intervalMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }

  // Cleanup
  try { fs.unlinkSync(path.join(outputDir, 'ready')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(outputDir, 'frame.jpg')); } catch { /* ignore */ }
  console.log('Lock capture helper stopped');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
