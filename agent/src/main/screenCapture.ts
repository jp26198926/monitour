import os from 'node:os';
import { getActiveBackend, recordCaptureError, recordCaptureSuccess, type RawCapture } from './captureBackend.js';

export interface ScreenFrame {
  data: Buffer;
  width: number;
  height: number;
  seq: number;
  timestamp: number;
}

export interface CaptureOptions {
  quality: number; // 1-100 JPEG quality (advisory — backend may ignore)
  fps: number; // target frames per second
  maxWidth?: number;
}

let captureInterval: ReturnType<typeof setInterval> | null = null;
let frameSeq = 0;
let active: { options: CaptureOptions; onFrame: (frame: ScreenFrame) => void; busy: boolean } | null = null;
let lastNudge = 0;

/**
 * Capture a single screenshot as JPEG via the active backend.
 */
export async function captureFrame(options: CaptureOptions): Promise<ScreenFrame> {
  const backend = getActiveBackend();
  try {
    const raw: RawCapture = await backend.capture();
    recordCaptureSuccess();
    frameSeq++;
    return {
      data: raw.data,
      width: options.maxWidth ? Math.min(raw.width, options.maxWidth) : raw.width,
      height: options.maxWidth ? Math.round((raw.height * Math.min(raw.width, options.maxWidth)) / raw.width) : raw.height,
      seq: frameSeq,
      timestamp: Date.now(),
    };
  } catch (err) {
    recordCaptureError();
    throw err;
  }
}

/**
 * Start continuous screen capture. Calls `onFrame` at the target FPS.
 * Returns a stop function.
 */
export function startCapture(options: CaptureOptions, onFrame: (frame: ScreenFrame) => void): () => void {
  if (captureInterval) clearInterval(captureInterval);

  const intervalMs = Math.max(33, Math.round(1000 / options.fps));
  active = { options, onFrame, busy: false };

  captureInterval = setInterval(async () => {
    if (!active || active.busy) return; // skip frame if capture is slow
    active.busy = true;
    try {
      const frame = await captureFrame(active.options);
      active.onFrame(frame);
    } catch (err) {
      console.error('Screen capture error:', err);
    } finally {
      if (active) active.busy = false;
    }
  }, intervalMs);

  return () => {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    active = null;
  };
}

/** Capture a frame right away (e.g. after injecting input) so feedback doesn't
 *  wait for the next interval tick. Throttled; no-op while a capture is running. */
export function nudge(): void {
  if (!active || active.busy) return;
  const now = Date.now();
  if (now - lastNudge < 40) return;
  lastNudge = now;
  const { options, onFrame } = active;
  active.busy = true;
  captureFrame(options)
    .then(onFrame)
    .catch((err) => console.error('Nudge capture error:', err))
    .finally(() => {
      if (active) active.busy = false;
    });
}

/**
 * Get the raw screen dimensions of the primary display.
 */
export async function getRawScreenDimensions(): Promise<{ width: number; height: number }> {
  return getActiveBackend().getScreenSize();
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
