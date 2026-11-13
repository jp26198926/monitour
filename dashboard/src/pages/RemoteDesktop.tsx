import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store';
import { api } from '../api/client';
import type { InputEvent, CommandPayload, CursorShape, CursorState } from '@monitour/shared';
import { DashboardEvent } from '@monitour/shared';

interface DesktopState {
  status: 'idle' | 'connecting' | 'connected' | 'disconnected';
  fps: number;
  resolution: string;
  lastFrameAt: number | null;
  deviceOnline: boolean;
}

export function RemoteDesktopPage() {
  const { id: deviceId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { token } = useAuthStore();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const remoteCursorRef = useRef<HTMLCanvasElement>(null);
  const shapeRef = useRef<CursorShape | null>(null);
  const remotePosRef = useRef<{ x: number; y: number; visible: boolean }>({ x: 50, y: 50, visible: true });
  const controlRef = useRef(false);
  const socketRef = useRef<Socket | null>(null);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());
  const pendingFrameRef = useRef<ArrayBuffer | Uint8Array | null>(null);
  const decodingRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);

  const [rtc, setRtc] = useState<DesktopState>({ status: 'idle', fps: 0, resolution: '', lastFrameAt: null, deviceOnline: false });
  const [controlEnabled, setControlEnabled] = useState(false);
  const [remoteCursorActive, setRemoteCursorActive] = useState(false);
  const [sessionState, setSessionState] = useState<{ locked: boolean; secureDesktop: boolean }>({ locked: false, secureDesktop: false });
  const [sessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  controlRef.current = controlEnabled;

  // ---- Frame rendering (latest-frame-wins: only the newest frame is decoded) ----
  const pump = useCallback(() => {
    if (decodingRef.current) return;
    const data = pendingFrameRef.current;
    if (!data) return;
    pendingFrameRef.current = null;
    decodingRef.current = true;

    const img = imgRef.current;
    if (!img) {
      decodingRef.current = false;
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/jpeg' }));
    objectUrlRef.current = url;

    img.onload = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        ctx.drawImage(img, 0, 0);
      }
      decodingRef.current = false;
      pump();
    };
    img.src = url;
  }, []);

  const renderFrame = useCallback((data: ArrayBuffer | Uint8Array) => {
    pendingFrameRef.current = data;
    pump();

    frameCountRef.current++;
    const now = Date.now();
    if (now - lastFpsTimeRef.current >= 1000) {
      setRtc((s) => ({
        ...s,
        fps: Math.round((frameCountRef.current * 1000) / (now - lastFpsTimeRef.current)),
        lastFrameAt: now,
      }));
      frameCountRef.current = 0;
      lastFpsTimeRef.current = now;
    }
  }, [pump]);

  // Hide cursor when control is disabled
  useEffect(() => {
    if (!controlEnabled) hideCursor();
  }, [controlEnabled]);

  // Hide the remote cursor whenever the stream is not live
  useEffect(() => {
    if (rtc.status !== 'connected') hideRemoteCursor();
  }, [rtc.status]);

  // ---- Setup Socket.IO connection ----
  useEffect(() => {
    if (!deviceId || !token) return;

    let cancelled = false;
    const socket = io('/dashboard', { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    setRtc((s) => ({ ...s, status: 'connecting' }));

    // Fetch current device status immediately on mount
    api.get<{ status: string }>(`/devices/${deviceId}`).then((d) => {
      if (!cancelled) {
        setRtc((s) => ({ ...s, deviceOnline: d.status === 'online' }));
      }
    }).catch(() => {});

    socket.on('connect', () => {
      // Don't set status to 'connected' yet — wait for frames
      sendCommand('desktop:start', { quality: 70, fps: 30 });
      socket.emit('dash:request-cursor-shape', deviceId);
    });

    // Receive frames via Socket.IO (server relays agent frames here)
    socket.on('device:frame-update', (payload: { deviceId: string; header: unknown; data: ArrayBuffer | Uint8Array }) => {
      if (payload.deviceId !== deviceId) return;

      // Mark stream as active when frames arrive
      setRtc((s) => (s.status !== 'connected' ? { ...s, status: 'connected' } : s));

      // Update resolution from header if present
      const header = payload.header as { payload?: { width?: number; height?: number } } | null;
      if (header?.payload?.width && header?.payload?.height) {
        setRtc((s) => ({ ...s, resolution: `${header.payload!.width}x${header.payload!.height}` }));
      }

      renderFrame(payload.data);
    });

    // ---- Remote cursor (position + shape) ----
    socket.on(DashboardEvent.CursorUpdate, (payload: CursorState) => {
      if (payload.deviceId !== deviceId) return;
      remotePosRef.current = { x: payload.x, y: payload.y, visible: payload.visible };
      // While controlling, position is predicted locally — only visibility comes from the agent.
      if (!controlRef.current) placeRemoteCursor(payload.x, payload.y);
    });

    socket.on(DashboardEvent.CursorShape, (payload: { deviceId: string; shape: CursorShape }) => {
      if (payload.deviceId !== deviceId) return;
      const shape = payload.shape;
      if (shapeRef.current && shape.shapeId <= shapeRef.current.shapeId) return;

      const raw = shape.pixels instanceof Uint8Array ? shape.pixels : new Uint8Array(shape.pixels as unknown as ArrayBuffer);
      const rgba = new Uint8ClampedArray(raw.length);
      for (let i = 0; i < raw.length; i += 4) {
        rgba[i] = raw[i + 2]; // BGRA -> RGBA
        rgba[i + 1] = raw[i + 1];
        rgba[i + 2] = raw[i];
        rgba[i + 3] = raw[i + 3];
      }
      const el = remoteCursorRef.current;
      const ctx = el?.getContext('2d');
      if (el && ctx && rgba.length === shape.width * shape.height * 4) {
        el.width = shape.width;
        el.height = shape.height;
        ctx.putImageData(new ImageData(rgba, shape.width, shape.height), 0, 0);
      }
      shapeRef.current = shape;
      setRemoteCursorActive(true);
    });

    socket.on('connect_error', () => {
      setRtc((s) => ({ ...s, status: 'disconnected', deviceOnline: false }));
    });

    socket.on('disconnect', () => {
      setRtc((s) => ({ ...s, status: 'disconnected', deviceOnline: false }));
    });

    // Live device status (agent online/offline)
    socket.on('device:status-update', (payload: { deviceId: string; status: string; sessionState?: { locked: boolean; secureDesktop: boolean } }) => {
      if (payload.deviceId !== deviceId) return;
      const online = payload.status === 'online';
      if (payload.sessionState) {
        setSessionState({ locked: payload.sessionState.locked, secureDesktop: payload.sessionState.secureDesktop });
      }
      setRtc((s) => ({
        ...s,
        deviceOnline: online,
        ...(online ? {} : { status: 'disconnected' as const, fps: 0 }),
      }));
      if (!online) {
        setControlEnabled(false);
        // A fresh agent run starts shapeIds over — drop any stale cursor data.
        shapeRef.current = null;
        setRemoteCursorActive(false);
        hideRemoteCursor();
      } else {
        // Device just came back online — restart the stream
        setRtc((s) => ({ ...s, lastFrameAt: Date.now(), status: 'connecting' }));
        sendCommand('desktop:start', { quality: 70, fps: 30 });
      }
    });

    // Session lock/desktop state updates
    socket.on('device:session-state-update', (payload: { deviceId: string; sessionState: { locked: boolean; secureDesktop: boolean } }) => {
      if (payload.deviceId !== deviceId) return;
      setSessionState({ locked: payload.sessionState.locked, secureDesktop: payload.sessionState.secureDesktop });
    });

    // Tick every second: update "last frame Xs ago" and detect stale streams
    const tick = setInterval(() => {
      setRtc((s) => {
        // If we were connected but no frames for 5s, consider the stream lost
        if (s.status === 'connected' && s.lastFrameAt && Date.now() - s.lastFrameAt > 5000) {
          setControlEnabled(false);
          return { ...s, status: 'disconnected', fps: 0 };
        }
        return { ...s }; // force re-render for "Xs ago" counter
      });
    }, 1000);

    return () => {
      clearInterval(tick);
      sendCommand('desktop:stop', {});
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, token, sessionId, renderFrame]);

  function sendCommand(type: CommandPayload['type'], params: Record<string, unknown>) {
    const socket = socketRef.current;
    if (!socket) return;
    const command: CommandPayload = {
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      sessionId,
      params,
    };
    socket.emit('dash:send-command', { deviceId, command });
  }

  // ---- Send input events to agent via Socket.IO ----
  const sendInput = useCallback(
    (event: InputEvent) => {
      const socket = socketRef.current;
      if (!socket || !controlEnabled) return;
      socket.emit('dash:desktop-input', { deviceId, input: event });
    },
    [controlEnabled, deviceId],
  );

  // ---- Coordinate mapping helpers ----
  function getLetterbox(containerRect: DOMRect) {
    const canvas = canvasRef.current;
    const imgW = canvas?.width || 0;
    const imgH = canvas?.height || 0;
    if (!imgW || !imgH) return { displayW: containerRect.width, displayH: containerRect.height, offsetX: 0, offsetY: 0 };
    const scale = Math.min(containerRect.width / imgW, containerRect.height / imgH);
    const displayW = imgW * scale;
    const displayH = imgH * scale;
    return {
      displayW,
      displayH,
      offsetX: (containerRect.width - displayW) / 2,
      offsetY: (containerRect.height - displayH) / 2,
    };
  }

  function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
  }

  function toPercent(clientX: number, clientY: number): { x: number; y: number; displayW: number; displayH: number; offsetX: number; offsetY: number } | null {
    const container = containerRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const { displayW, displayH, offsetX, offsetY } = getLetterbox(containerRect);
    if (!displayW || !displayH) return null;
    const x = clamp(((clientX - containerRect.left - offsetX) / displayW) * 100, 0, 100);
    const y = clamp(((clientY - containerRect.top - offsetY) / displayH) * 100, 0, 100);
    return { x, y, displayW, displayH, offsetX, offsetY };
  }

  function updateCursor(x: number, y: number, displayW: number, displayH: number, offsetX: number, offsetY: number) {
    const el = cursorRef.current;
    if (!el) return;
    el.style.left = `${offsetX + (x / 100) * displayW}px`;
    el.style.top = `${offsetY + (y / 100) * displayH}px`;
    el.style.display = 'block';
  }

  function hideCursor() {
    if (cursorRef.current) cursorRef.current.style.display = 'none';
  }

  /** Place the remote-cursor overlay so its hotspot lands exactly on (pctX, pctY) of the remote screen. */
  function placeRemoteCursor(pctX: number, pctY: number) {
    const el = remoteCursorRef.current;
    const shape = shapeRef.current;
    const container = containerRef.current;
    if (!el || !shape || !container) return;

    const containerRect = container.getBoundingClientRect();
    const { displayW, displayH, offsetX, offsetY } = getLetterbox(containerRect);
    const scale = displayW / (canvasRef.current?.width || 1);

    el.style.width = `${shape.width * scale}px`;
    el.style.height = `${shape.height * scale}px`;
    el.style.left = `${offsetX + (pctX / 100) * displayW - shape.hotspotX * scale}px`;
    el.style.top = `${offsetY + (pctY / 100) * displayH - shape.hotspotY * scale}px`;
    el.style.display = remotePosRef.current.visible ? 'block' : 'none';
  }

  function hideRemoteCursor() {
    if (remoteCursorRef.current) remoteCursorRef.current.style.display = 'none';
  }

  // ---- Mouse/keyboard handlers (only active when controlEnabled) ----
  function handleMouseDown(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const pos = toPercent(e.clientX, e.clientY);
    if (!pos) return;
    if (remoteCursorActive) {
      placeRemoteCursor(pos.x, pos.y);
    } else {
      updateCursor(pos.x, pos.y, pos.displayW, pos.displayH, pos.offsetX, pos.offsetY);
    }
    sendInput({ type: 'mousedown', x: pos.x, y: pos.y, button: e.button });
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const pos = toPercent(e.clientX, e.clientY);
    if (!pos) return;
    sendInput({ type: 'mouseup', x: pos.x, y: pos.y, button: e.button });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const pos = toPercent(e.clientX, e.clientY);
    if (!pos) return;
    if (remoteCursorActive) {
      // Local prediction: the overlay tracks the operator's pointer with zero lag;
      // the agent-supplied shape (which follows after ~1 RTT) is drawn on top.
      hideCursor();
      placeRemoteCursor(pos.x, pos.y);
    } else {
      updateCursor(pos.x, pos.y, pos.displayW, pos.displayH, pos.offsetX, pos.offsetY);
    }
    sendInput({ type: 'mousemove', x: pos.x, y: pos.y });
  }

  function handleMouseLeave() {
    hideCursor();
    // While controlling the overlay tracks the local pointer, so it leaves with it.
    // In view-only it shows the remote user's cursor and must stay.
    if (controlRef.current) hideRemoteCursor();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!controlEnabled) return;
    sendInput({
      type: 'keydown',
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
    });
    e.preventDefault();
  }

  function handleKeyUp(e: React.KeyboardEvent) {
    if (!controlEnabled) return;
    sendInput({
      type: 'keyup',
      key: e.key,
      code: e.code,
    });
    e.preventDefault();
  }

  // Wheel needs a native listener: React's synthetic wheel is passive, so
  // preventDefault() there cannot stop page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!controlRef.current) return;
      const pos = toPercent(e.clientX, e.clientY);
      if (!pos) return;
      sendInput({ type: 'wheel', x: pos.x, y: pos.y, deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendInput]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={() => navigate(-1)}>
          &larr; Back
        </button>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Remote Desktop</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
          <span>
            <span className={`status-dot ${rtc.deviceOnline ? 'online' : 'offline'}`} />
            {rtc.deviceOnline ? 'Device Online' : 'Device Offline'}
          </span>
          <span>
            <span className={`status-dot ${rtc.status === 'connected' ? 'online' : rtc.status === 'connecting' ? 'pending' : 'offline'}`} />
            {rtc.status}
          </span>
          {rtc.fps > 0 && <span>{rtc.fps} FPS</span>}
          {rtc.resolution && <span>{rtc.resolution}</span>}
          {rtc.lastFrameAt && (
            <span style={{ color: 'var(--text-muted)' }}>
              Last frame {Math.round((Date.now() - rtc.lastFrameAt) / 1000)}s ago
            </span>
          )}
        </div>

        {/* View / Control toggle + SAS button */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {(sessionState.locked || sessionState.secureDesktop) && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => sendCommand('desktop:sas', {})}
              title="Send Ctrl+Alt+Del to the remote machine"
            >
              Ctrl+Alt+Del
            </button>
          )}
          {controlEnabled ? (
            <button className="btn btn-control-active btn-sm" onClick={() => setControlEnabled(false)}>
              Stop Control
            </button>
          ) : (
            <button
              className="btn btn-control btn-sm"
              disabled={!rtc.deviceOnline || rtc.status !== 'connected'}
              onClick={() => setControlEnabled(true)}
            >
              Control
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`desktop-container ${controlEnabled ? 'controlling' : 'view-only'}${remoteCursorActive ? ' remote-cursor-active' : ''}`}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <img ref={imgRef} style={{ display: 'none' }} alt="" />
        <canvas ref={canvasRef} />

        {/* Fallback marker (operator's pointer) — only before real cursor data arrives */}
        <div ref={cursorRef} className="desktop-cursor" />

        {/* Remote client's real cursor (position + shape) */}
        <canvas ref={remoteCursorRef} className="desktop-remote-cursor" />

        {/* Overlay badge */}
        <div className="desktop-overlay">
          {sessionState.secureDesktop ? (
            <span className="overlay-badge overlay-badge-secure">Secure Desktop</span>
          ) : sessionState.locked ? (
            <span className="overlay-badge overlay-badge-lock">Session Locked</span>
          ) : controlEnabled ? (
            <span className="overlay-badge overlay-badge-control">Control Active</span>
          ) : (
            <span className="overlay-badge overlay-badge-view">View Only</span>
          )}
        </div>

        {/* Session info (bottom-left) */}
        <div className="desktop-overlay" style={{ top: 'auto', bottom: 12 }}>
          Session: {sessionId.slice(0, 12)}&hellip;
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
        {!rtc.deviceOnline && 'Device is offline — waiting for agent to reconnect...'}
        {rtc.deviceOnline && rtc.status === 'connecting' && 'Connecting to device...'}
        {rtc.deviceOnline && rtc.status === 'connected' && sessionState.locked && 'Screen is locked — use Control to enter the password remotely'}
        {rtc.deviceOnline && rtc.status === 'connected' && !sessionState.locked && controlEnabled && 'Control active — your mouse and keyboard are being forwarded'}
        {rtc.deviceOnline && rtc.status === 'connected' && !sessionState.locked && !controlEnabled && 'View only — click Control to interact with the remote desktop'}
        {rtc.deviceOnline && rtc.status === 'disconnected' && 'Connection lost — attempting to reconnect...'}
      </div>
    </div>
  );
}
