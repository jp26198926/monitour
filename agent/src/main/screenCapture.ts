import screenshot from 'screenshot-desktop';
import os from 'node:os';

export interface ScreenFrame {
  data: Buffer;
  width: number;
  height: number;
  seq: number;
  timestamp: number;
}

export interface CaptureOptions {
  quality: number; // 1-100 JPEG quality
  fps: number; // target frames per second
  maxWidth?: number;
}

let captureInterval: ReturnType<typeof setInterval> | null = null;
let frameSeq = 0;

/**
 * Capture a single screenshot as JPEG.
 */
export async function captureFrame(options: CaptureOptions): Promise<ScreenFrame> {
  // screenshot-desktop types don't expose quality; cast options
  const raw = await screenshot({ format: 'jpg' } as Parameters<typeof screenshot>[0]);

  // Detect screen dimensions from the first display
  const displays = await screenshot.listDisplays();
  const primary = displays[0];
  const width = primary?.width ?? 1920;
  const height = primary?.height ?? 1080;

  frameSeq++;
  return {
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as ArrayBuffer),
    width: options.maxWidth ? Math.min(width, options.maxWidth) : width,
    height: options.maxWidth ? Math.round((height * Math.min(width, options.maxWidth)) / width) : height,
    seq: frameSeq,
    timestamp: Date.now(),
  };
}

/**
 * Start continuous screen capture. Calls `onFrame` at the target FPS.
 * Returns a stop function.
 */
export function startCapture(options: CaptureOptions, onFrame: (frame: ScreenFrame) => void): () => void {
  if (captureInterval) clearInterval(captureInterval);

  const intervalMs = Math.max(50, Math.round(1000 / options.fps));
  let busy = false;

  captureInterval = setInterval(async () => {
    if (busy) return; // skip frame if capture is slow
    busy = true;
    try {
      const frame = await captureFrame(options);
      onFrame(frame);
    } catch (err) {
      console.error('Screen capture error:', err);
    } finally {
      busy = false;
    }
  }, intervalMs);

  return () => {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
  };
}

/**
 * Get the raw screen dimensions of the primary display.
 */
export async function getRawScreenDimensions(): Promise<{ width: number; height: number }> {
  const displays = await screenshot.listDisplays();
  const primary = displays[0];
  return {
    width: primary?.width ?? 1920,
    height: primary?.height ?? 1080,
  };
}

/**
 * Get basic screen info for the system info payload.
 */
export function getScreenInfo() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    uptimeSec: Math.round(os.uptime()),
    loadAvg: os.loadavg(),
    osVersion: os.release(),
  };
}
