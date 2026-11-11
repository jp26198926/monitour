import koffi from 'koffi';

// ---- Win32 types (handles are pointer-sized integers, not opaque structs) ----
const HDESK = koffi.types.uint64;
const DWORD = koffi.types.uint32;
const BOOL = koffi.types.int32;

// ---- Win32 constants ----
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_SWITCHDESKTOP = 0x0100;
const UOI_NAME = 2;

// ---- Win32 functions (user32) ----
let ffiAvailable = false;
let _OpenInputDesktop: ((dwFlags: number, fInherit: number, dwDesiredAccess: number) => number) | null = null;
let _GetUserObjectInformationW: ((h: number, n: number, pv: unknown, nLen: number, lpnLen: unknown) => boolean) | null = null;
let _CloseDesktop: ((h: number) => boolean) | null = null;

try {
  const user32 = koffi.load('user32');
  _OpenInputDesktop = user32.func('OpenInputDesktop', HDESK, [DWORD, BOOL, DWORD]) as unknown as ((dwFlags: number, fInherit: number, dwDesiredAccess: number) => number) | null;
  _GetUserObjectInformationW = user32.func('GetUserObjectInformationW', BOOL, [HDESK, DWORD, koffi.pointer(koffi.types.void), DWORD, koffi.pointer(DWORD)]) as never;
  _CloseDesktop = user32.func('CloseDesktop', BOOL, [HDESK]) as never;
  ffiAvailable = true;
} catch (err) {
  console.warn('lockState: koffi user32 unavailable, falling back to heuristic:', err);
}

export interface SessionState {
  locked: boolean;
  secureDesktop: boolean;
  inputDesktop: string | null;
  confidence: 'ffi' | 'heuristic';
  checkedAt: number;
}

let cached: SessionState = {
  locked: false,
  secureDesktop: false,
  inputDesktop: null,
  confidence: 'ffi',
  checkedAt: 0,
};

const listeners = new Set<(s: SessionState) => void>();

function probeDesktopName(handle: number): string | null {
  if (!_GetUserObjectInformationW) return null;
  // Get required size first
  const lenBuf = Buffer.alloc(4);
  _GetUserObjectInformationW(handle, UOI_NAME, null, 0, lenBuf as never);
  const charCount = lenBuf.readUInt32LE(0);
  if (charCount === 0) return null;
  // Buffer for wide string
  const buf = Buffer.alloc(charCount * 2);
  const ok = _GetUserObjectInformationW(handle, UOI_NAME, buf, charCount * 2, lenBuf as never);
  if (!ok) return null;
  // Decode UTF-16LE
  return buf.toString('utf16le').replace(/\0+$/, '');
}

function probeFfi(): SessionState | null {
  if (!ffiAvailable || !_OpenInputDesktop || !_CloseDesktop) return null;
  try {
    const hDesk = _OpenInputDesktop(0, 0, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
    if (!hDesk || hDesk === 0) {
      // NULL handle — secure desktop owns input (locked or UAC)
      return {
        locked: true,
        secureDesktop: true,
        inputDesktop: null,
        confidence: 'ffi',
        checkedAt: Date.now(),
      };
    }
    const name = probeDesktopName(hDesk);
    _CloseDesktop(hDesk);
    return {
      locked: name === 'Winlogon',
      secureDesktop: name === 'Winlogon',
      inputDesktop: name,
      confidence: 'ffi',
      checkedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function refreshSessionState(): SessionState {
  const probe = probeFfi();
  if (probe) {
    const changed = probe.locked !== cached.locked || probe.secureDesktop !== cached.secureDesktop;
    cached = probe;
    if (changed) {
      for (const cb of listeners) {
        try { cb(cached); } catch { /* ignore */ }
      }
    }
    return cached;
  }
  // Heuristic fallback: assume unlocked (we can't detect without FFI)
  cached = { ...cached, confidence: 'heuristic', checkedAt: Date.now() };
  return cached;
}

export function getSessionState(): SessionState {
  return cached;
}

export function onSessionStateChange(cb: (s: SessionState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function isFfiAvailable(): boolean {
  return ffiAvailable;
}
