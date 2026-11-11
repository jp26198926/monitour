import screenshot from 'screenshot-desktop';
import os from 'node:os';

export interface RawCapture {
  data: Buffer;
  width: number;
  height: number;
}

export interface CaptureBackend {
  readonly name: 'dxgi' | 'gdi';
  isAvailable(): Promise<boolean>;
  capture(): Promise<RawCapture>;
  getScreenSize(): Promise<{ width: number; height: number }>;
}

// ---- DXGI backend (node-screenshots, in-process, no csc.exe recompile) ----
class DxgiBackend implements CaptureBackend {
  readonly name = 'dxgi' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mod: any = null;
  private loaded = false;

  async isAvailable(): Promise<boolean> {
    if (this.loaded) return this.mod !== null;
    this.loaded = true;
    try {
      this.mod = await import('node-screenshots');
      return true;
    } catch (err) {
      console.warn('captureBackend: node-screenshots unavailable:', err);
      this.mod = null;
      return false;
    }
  }

  private getMonitor() {
    const monitors = this.mod.Monitor.all();
    return monitors.find((m: { isPrimary(): boolean }) => m.isPrimary()) ?? monitors[0];
  }

  async capture(): Promise<RawCapture> {
    const monitor = this.getMonitor();
    const img = await monitor.captureImage();
    // copyOutputData=true is REQUIRED under Electron (napi-rs/napi-rs#1346)
    const isElectron = !!process.versions.electron;
    const data: Buffer = img.toJpegSync(isElectron);
    return {
      data,
      width: monitor.width(),
      height: monitor.height(),
    };
  }

  async getScreenSize(): Promise<{ width: number; height: number }> {
    const monitor = this.getMonitor();
    return { width: monitor.width(), height: monitor.height() };
  }
}

// ---- GDI backend (screenshot-desktop, fallback) ----
class GdiBackend implements CaptureBackend {
  readonly name = 'gdi' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async capture(): Promise<RawCapture> {
    const raw = await screenshot({ format: 'jpg' } as Parameters<typeof screenshot>[0]);
    const displays = await screenshot.listDisplays();
    const primary = displays[0];
    return {
      data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as ArrayBuffer),
      width: primary?.width ?? 1920,
      height: primary?.height ?? 1080,
    };
  }

  async getScreenSize(): Promise<{ width: number; height: number }> {
    const displays = await screenshot.listDisplays();
    const primary = displays[0];
    return { width: primary?.width ?? 1920, height: primary?.height ?? 1080 };
  }
}

// ---- Backend selection with auto-fallback ----
let activeBackend: CaptureBackend = new GdiBackend();
let consecutiveErrors = 0;
let reprobeTimer: ReturnType<typeof setInterval> | null = null;
const ERROR_THRESHOLD = 3;

export async function selectBackend(): Promise<CaptureBackend> {
  const dxgi = new DxgiBackend();
  if (await dxgi.isAvailable()) {
    // Verify it actually captures
    try {
      await dxgi.capture();
      activeBackend = dxgi;
      console.log('captureBackend: using DXGI (node-screenshots)');
    } catch (err) {
      console.warn('captureBackend: DXGI capture failed, using GDI:', err);
      activeBackend = new GdiBackend();
    }
  } else {
    activeBackend = new GdiBackend();
    console.log('captureBackend: using GDI (screenshot-desktop)');
  }

  // Periodic re-probe to try swapping back to DXGI after fallback
  if (reprobeTimer) clearInterval(reprobeTimer);
  reprobeTimer = setInterval(async () => {
    if (activeBackend.name === 'dxgi') return;
    const dxgi = new DxgiBackend();
    if (await dxgi.isAvailable()) {
      try {
        await dxgi.capture();
        activeBackend = dxgi;
        consecutiveErrors = 0;
        console.log('captureBackend: swapped back to DXGI');
      } catch { /* still failing */ }
    }
  }, 60_000);

  return activeBackend;
}

export function getActiveBackend(): CaptureBackend {
  return activeBackend;
}

export async function forceFallback(reason: string): Promise<void> {
  console.warn(`captureBackend: forcing GDI fallback — ${reason}`);
  activeBackend = new GdiBackend();
}

export function recordCaptureError(): boolean {
  consecutiveErrors++;
  if (consecutiveErrors >= ERROR_THRESHOLD && activeBackend.name === 'dxgi') {
    forceFallback(`${consecutiveErrors} consecutive capture errors`);
    return true;
  }
  return false;
}

export function recordCaptureSuccess(): void {
  consecutiveErrors = 0;
}

// Initialize on module load
void selectBackend();
