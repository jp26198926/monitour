import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store';
import { api } from '../api/client';
import type { InputEvent, CommandPayload } from '@monitour/shared';

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
  const socketRef = useRef<Socket | null>(null);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

  const [rtc, setRtc] = useState<DesktopState>({ status: 'idle', fps: 0, resolution: '', lastFrameAt: null, deviceOnline: false });
  const [controlEnabled, setControlEnabled] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  // ---- Frame rendering ----
  const renderFrame = useCallback((data: ArrayBuffer | Uint8Array) => {
    const blob = new Blob([data as BlobPart], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);

    const img = imgRef.current;
    if (img) {
      img.onload = () => {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
          }
        }
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }

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
  }, []);

  // ---- Setup Socket.IO connection ----
  useEffect(() => {
    if (!deviceId || !token) return;

    let cancelled = false;
    const socket = io('/dashboard', { auth: { token } });
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
      sendCommand('desktop:start', { quality: 70, fps: 15 });
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

    socket.on('connect_error', () => {
      setRtc((s) => ({ ...s, status: 'disconnected', deviceOnline: false }));
    });

    socket.on('disconnect', () => {
      setRtc((s) => ({ ...s, status: 'disconnected', deviceOnline: false }));
    });

    // Live device status (agent online/offline)
    socket.on('device:status-update', (payload: { deviceId: string; status: string }) => {
      if (payload.deviceId !== deviceId) return;
      const online = payload.status === 'online';
      setRtc((s) => ({
        ...s,
        deviceOnline: online,
        ...(online ? {} : { status: 'disconnected' as const, fps: 0 }),
      }));
      if (!online) {
        setControlEnabled(false);
      } else {
        // Device just came back online — restart the stream
        setRtc((s) => ({ ...s, lastFrameAt: Date.now(), status: 'connecting' }));
        sendCommand('desktop:start', { quality: 70, fps: 15 });
      }
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

  // ---- Mouse/keyboard handlers (only active when controlEnabled) ----
  function handleMouseDown(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    sendInput({ type: 'mousedown', x, y, button: e.button });
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    sendInput({ type: 'mouseup', x, y, button: e.button });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!controlEnabled) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    sendInput({ type: 'mousemove', x, y });
  }

  function handleWheel(e: React.WheelEvent) {
    if (!controlEnabled) return;
    sendInput({ type: 'wheel', x: 50, y: 50, deltaX: e.deltaX, deltaY: e.deltaY });
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

        {/* View / Control toggle */}
        <div style={{ marginLeft: 'auto' }}>
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
        className={`desktop-container ${controlEnabled ? 'controlling' : 'view-only'}`}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <img ref={imgRef} style={{ display: 'none' }} alt="" />
        <canvas ref={canvasRef} />

        {/* Overlay badge */}
        <div className="desktop-overlay">
          {controlEnabled ? (
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
        {rtc.deviceOnline && rtc.status === 'connected' && !controlEnabled && 'View only — click Control to interact with the remote desktop'}
        {rtc.deviceOnline && rtc.status === 'connected' && controlEnabled && 'Control active — your mouse and keyboard are being forwarded'}
        {rtc.deviceOnline && rtc.status === 'disconnected' && 'Connection lost — attempting to reconnect...'}
      </div>
    </div>
  );
}
