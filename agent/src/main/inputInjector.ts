import { mouse, keyboard, Button, Key, Point } from '@nut-tree-fork/nut-js';
import type { InputEvent } from '@monitour/shared';
import { sendInputEvent as sendWinInput, attachToInputDesktop, detachFromDesktop } from './winInput.js';

let sessionLocked = false;

/** Set session lock state — routes input to WinInput when locked. */
export function setSessionState(locked: boolean): void {
  if (locked && !sessionLocked) {
    sessionLocked = true;
    // Try to attach to the Winlogon desktop for input injection
    attachToInputDesktop();
  } else if (!locked && sessionLocked) {
    sessionLocked = false;
    detachFromDesktop();
  }
}

// nut.js is async; we queue events to avoid race conditions.
// mousemove events are coalesced — only the latest position is kept,
// since intermediate positions are irrelevant for remote desktop.
const inputQueue: Array<() => Promise<void>> = [];
let pendingMouseMove: (() => Promise<void>) | null = null;
let processing = false;

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  for (;;) {
    // Prioritize the latest mousemove over queued events
    const moveFn = pendingMouseMove;
    pendingMouseMove = null;
    const fn = moveFn ?? inputQueue.shift();
    if (!fn) break;
    try {
      await fn();
    } catch (err) {
      console.error('Input injection error:', err);
    }
  }
  processing = false;
}

function enqueue(fn: () => Promise<void>): void {
  inputQueue.push(fn);
  void drainQueue();
}

function enqueueMouseMove(fn: () => Promise<void>): void {
  pendingMouseMove = fn;
  void drainQueue();
}

// Map percentage coords (0-100) to screen pixels
function toScreenPoint(xPct: number, yPct: number): Point {
  const screenW = screenWidth || 1920;
  const screenH = screenHeight || 1080;
  return new Point(
    Math.round((xPct / 100) * screenW),
    Math.round((yPct / 100) * screenH),
  );
}

let screenWidth = 0;
let screenHeight = 0;

/** Set the screen dimensions (used for coordinate mapping). */
export function setScreenDimensions(w: number, h: number): void {
  screenWidth = w;
  screenHeight = h;
}

/** Get current screen dimensions (fallback to 1920x1080). */
export function getScreenDimensions(): { width: number; height: number } {
  return { width: screenWidth || 1920, height: screenHeight || 1080 };
}

// Map React keyboard code to nut.js Key
const codeToKey: Record<string, Key> = {
  Enter: Key.Enter,
  Escape: Key.Escape,
  Backspace: Key.Backspace,
  Tab: Key.Tab,
  Space: Key.Space,
  ArrowUp: Key.Up,
  ArrowDown: Key.Down,
  ArrowLeft: Key.Left,
  ArrowRight: Key.Right,
  Home: Key.Home,
  End: Key.End,
  PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  Delete: Key.Delete,
  Insert: Key.Insert,
  ShiftLeft: Key.LeftShift,
  ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl,
  ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt,
  AltRight: Key.RightAlt,
  MetaLeft: Key.LeftSuper,
  MetaRight: Key.RightSuper,
  CapsLock: Key.CapsLock,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,
  Digit0: Key.Num0,
  Digit1: Key.Num1,
  Digit2: Key.Num2,
  Digit3: Key.Num3,
  Digit4: Key.Num4,
  Digit5: Key.Num5,
  Digit6: Key.Num6,
  Digit7: Key.Num7,
  Digit8: Key.Num8,
  Digit9: Key.Num9,
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,
};

function resolveKey(code: string, key: string): Key | null {
  // Try the code mapping first
  if (codeToKey[code]) return codeToKey[code];
  // Try single-char keys
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const idx = Key[upper as keyof typeof Key];
    if (typeof idx === 'number') return idx;
  }
  return null;
}

const buttonMap: Record<number, Button> = {
  0: Button.LEFT,
  1: Button.MIDDLE,
  2: Button.RIGHT,
};

/**
 * Handle a single input event and inject it into the OS.
 * Routes to WinInput (koffi SendInput) when the screen is locked,
 * or nut.js when unlocked.
 */
export function handleInputEvent(event: InputEvent): void {
  // When locked, use WinInput (koffi SendInput on Winlogon desktop)
  if (sessionLocked) {
    try {
      sendWinInput(event);
    } catch (err) {
      console.error('WinInput injection error:', err);
    }
    return;
  }

  switch (event.type) {
    case 'mousemove': {
      enqueueMouseMove(async () => {
        const pt = toScreenPoint(event.x, event.y);
        await mouse.setPosition(pt);
      });
      break;
    }

    case 'mousedown': {
      enqueue(async () => {
        const pt = toScreenPoint(event.x, event.y);
        await mouse.setPosition(pt);
        await mouse.pressButton(buttonMap[event.button] ?? Button.LEFT);
      });
      break;
    }

    case 'mouseup': {
      enqueue(async () => {
        const pt = toScreenPoint(event.x, event.y);
        await mouse.setPosition(pt);
        await mouse.releaseButton(buttonMap[event.button] ?? Button.LEFT);
      });
      break;
    }

    case 'wheel': {
      enqueue(async () => {
        const amount = Math.round(event.deltaY / 100) || 1;
        if (amount > 0) {
          await mouse.scrollUp(Math.abs(amount));
        } else {
          await mouse.scrollDown(Math.abs(amount));
        }
      });
      break;
    }

    case 'keydown': {
      enqueue(async () => {
        // Handle modifiers first
        if (event.ctrl) await keyboard.pressKey(Key.LeftControl);
        if (event.alt) await keyboard.pressKey(Key.LeftAlt);
        if (event.shift) await keyboard.pressKey(Key.LeftShift);
        if (event.meta) await keyboard.pressKey(Key.LeftSuper);

        const nutKey = resolveKey(event.code, event.key);
        if (nutKey !== null) {
          await keyboard.pressKey(nutKey);
        } else if (event.key.length === 1) {
          await keyboard.type(event.key);
        }

        // Release modifiers (after key press)
        if (event.ctrl) await keyboard.releaseKey(Key.LeftControl);
        if (event.alt) await keyboard.releaseKey(Key.LeftAlt);
        if (event.shift) await keyboard.releaseKey(Key.LeftShift);
        if (event.meta) await keyboard.releaseKey(Key.LeftSuper);
      });
      break;
    }

    case 'keyup': {
      enqueue(async () => {
        const nutKey = resolveKey(event.code, event.key);
        if (nutKey !== null) {
          await keyboard.releaseKey(nutKey);
        }
      });
      break;
    }
  }
}
