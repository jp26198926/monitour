import koffi from 'koffi';
import type { InputEvent } from '@monitour/shared';

// ---- Win32 types ----
const DWORD = koffi.types.uint32;
const BOOL = koffi.types.int32;
const LONG = koffi.types.int32;
const WORD = koffi.types.uint16;
const HDESK = koffi.types.uint64;

// ---- Win32 constants ----
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const KEYEVENTF_KEYUP = 0x0002;
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_SWITCHDESKTOP = 0x0100;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

// ---- INPUT struct layout (x64) ----
// typedef struct tagINPUT {
//   DWORD type;           // offset 0
//   union {               // offset 8 (x64 alignment)
//     MOUSEINPUT mi;
//     KEYBDINPUT ki;
//   };
// } INPUT;
//
// MOUSEINPUT (32 bytes): dx(4), dy(4), mouseData(4), dwFlags(4), time(4), dwExtraInfo(8) = 28, padded to 32
// KEYBDINPUT (24 bytes): wVk(2), wScan(2), dwFlags(4), time(4), dwExtraInfo(8) = 20, padded to 24
// INPUT total on x64: 4(type) + 4(pad) + 32(union) = 40 bytes

const INPUT_SIZE = 40;
const MOUSEINPUT_OFFSET = 8;
const KEYBDINPUT_OFFSET = 8;

function buildMouseInput(dx: number, dy: number, flags: number, mouseData = 0): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_MOUSE, 0); // type
  buf.writeInt32LE(dx, MOUSEINPUT_OFFSET + 0);   // dx
  buf.writeInt32LE(dy, MOUSEINPUT_OFFSET + 4);   // dy
  buf.writeUInt32LE(mouseData, MOUSEINPUT_OFFSET + 8); // mouseData
  buf.writeUInt32LE(flags, MOUSEINPUT_OFFSET + 12);    // dwFlags
  buf.writeUInt32LE(0, MOUSEINPUT_OFFSET + 16);        // time
  buf.writeBigUInt64LE(0n, MOUSEINPUT_OFFSET + 20);    // dwExtraInfo
  return buf;
}

function buildKeyboardInput(vk: number, flags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_KEYBOARD, 0); // type
  buf.writeUInt16LE(vk, KEYBDINPUT_OFFSET + 0);   // wVk
  buf.writeUInt16LE(0, KEYBDINPUT_OFFSET + 2);     // wScan
  buf.writeUInt32LE(flags, KEYBDINPUT_OFFSET + 4); // dwFlags
  buf.writeUInt32LE(0, KEYBDINPUT_OFFSET + 8);     // time
  buf.writeBigUInt64LE(0n, KEYBDINPUT_OFFSET + 12); // dwExtraInfo
  return buf;
}

// ---- Virtual key codes (Windows) ----
const VK: Record<string, number> = {
  Enter: 0x0D,
  Escape: 0x1B,
  Backspace: 0x08,
  Tab: 0x09,
  Space: 0x20,
  ArrowUp: 0x26,
  ArrowDown: 0x28,
  ArrowLeft: 0x25,
  ArrowRight: 0x27,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Delete: 0x2E,
  Insert: 0x2D,
  ShiftLeft: 0xA0,
  ShiftRight: 0xA1,
  ControlLeft: 0xA2,
  ControlRight: 0xA3,
  AltLeft: 0xA4,
  AltRight: 0xA5,
  MetaLeft: 0x5B,
  MetaRight: 0x5C,
  CapsLock: 0x14,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73,
  F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
  F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33,
  Digit4: 0x34, Digit5: 0x35, Digit6: 0x36, Digit7: 0x37,
  Digit8: 0x38, Digit9: 0x39,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45,
  KeyF: 0x46, KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A,
  KeyK: 0x4B, KeyL: 0x4C, KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F,
  KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54,
  KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59,
  KeyZ: 0x5A,
};

function resolveVk(code: string, key: string): number | null {
  if (VK[code]) return VK[code];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code2 = `Key${upper}`;
    if (VK[code2]) return VK[code2];
    // Digits
    if (upper >= '0' && upper <= '9') {
      return 0x30 + (upper.charCodeAt(0) - 0x30);
    }
  }
  return null;
}

// ---- Load user32 ----
const user32 = koffi.load('user32');
const SendInput = user32.func('SendInput', DWORD, [DWORD, koffi.pointer(koffi.types.void), DWORD]) as (n: number, inputs: unknown, size: number) => number;
const OpenInputDesktop = user32.func('OpenInputDesktop', HDESK, [DWORD, BOOL, DWORD]) as (f: number, i: number, a: number) => number;
const SetThreadDesktop = user32.func('SetThreadDesktop', BOOL, [HDESK]) as (h: number) => boolean;
const CloseDesktop = user32.func('CloseDesktop', BOOL, [HDESK]) as (h: number) => boolean;
const GetSystemMetrics = user32.func('GetSystemMetrics', LONG, [LONG]) as (i: number) => number;

let attachedDesktop = 0;
let attachedToWinlogon = false;

/**
 * Attach the current thread to the input desktop (Winlogon if locked).
 * Must be called before sending input when the screen is locked.
 */
export function attachToInputDesktop(): boolean {
  try {
    const hDesk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
    if (!hDesk || hDesk === 0) {
      // Can't open input desktop (secure desktop owns it) — try Winlogon directly
      return false;
    }
    const ok = SetThreadDesktop(hDesk);
    if (ok) {
      if (attachedDesktop && attachedDesktop !== hDesk) {
        try { CloseDesktop(attachedDesktop); } catch { /* ignore */ }
      }
      attachedDesktop = hDesk;
      attachedToWinlogon = true;
      return true;
    }
    CloseDesktop(hDesk);
    return false;
  } catch {
    return false;
  }
}

function sendInputs(inputs: Buffer[]): boolean {
  const total = Buffer.concat(inputs);
  const count = inputs.length;
  const sent = SendInput(count, total, INPUT_SIZE);
  return sent === count;
}

function toAbsoluteCoords(xPct: number, yPct: number): { x: number; y: number } {
  // Map percentage (0-100) to absolute screen coords (0-65535)
  return {
    x: Math.round((xPct / 100) * 65535),
    y: Math.round((yPct / 100) * 65535),
  };
}

const buttonFlagMap: Record<number, { down: number; up: number }> = {
  0: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  1: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
  2: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
};

/**
 * Send an input event to the current input desktop.
 * Call attachToInputDesktop() first when the screen is locked.
 */
export function sendInputEvent(event: InputEvent): boolean {
  switch (event.type) {
    case 'mousemove': {
      const { x, y } = toAbsoluteCoords(event.x, event.y);
      return sendInputs([buildMouseInput(x, y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)]);
    }
    case 'mousedown': {
      const { x, y } = toAbsoluteCoords(event.x, event.y);
      const flags = buttonFlagMap[event.button] ?? buttonFlagMap[0];
      return sendInputs([
        buildMouseInput(x, y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE),
        buildMouseInput(x, y, flags.down | MOUSEEVENTF_ABSOLUTE),
      ]);
    }
    case 'mouseup': {
      const { x, y } = toAbsoluteCoords(event.x, event.y);
      const flags = buttonFlagMap[event.button] ?? buttonFlagMap[0];
      return sendInputs([
        buildMouseInput(x, y, flags.up | MOUSEEVENTF_ABSOLUTE),
      ]);
    }
    case 'wheel': {
      const delta = event.deltaY > 0 ? 120 : -120;
      return sendInputs([buildMouseInput(0, 0, MOUSEEVENTF_WHEEL, delta)]);
    }
    case 'keydown': {
      const inputs: Buffer[] = [];
      if (event.ctrl) inputs.push(buildKeyboardInput(VK.ControlLeft, 0));
      if (event.alt) inputs.push(buildKeyboardInput(VK.AltLeft, 0));
      if (event.shift) inputs.push(buildKeyboardInput(VK.ShiftLeft, 0));
      if (event.meta) inputs.push(buildKeyboardInput(VK.MetaLeft, 0));
      const vk = resolveVk(event.code, event.key);
      if (vk !== null) inputs.push(buildKeyboardInput(vk, 0));
      return sendInputs(inputs);
    }
    case 'keyup': {
      const inputs: Buffer[] = [];
      const vk = resolveVk(event.code, event.key);
      if (vk !== null) inputs.push(buildKeyboardInput(vk, KEYEVENTF_KEYUP));
      return sendInputs(inputs);
    }
    default:
      return false;
  }
}

export function isAttachedToWinlogon(): boolean {
  return attachedToWinlogon;
}

export function detachFromDesktop(): void {
  if (attachedDesktop) {
    try { CloseDesktop(attachedDesktop); } catch { /* ignore */ }
    attachedDesktop = 0;
    attachedToWinlogon = false;
  }
}
