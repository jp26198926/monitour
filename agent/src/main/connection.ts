import { io, type Socket } from 'socket.io-client';
import fs from 'node:fs';
import {
  loadAgentState,
  getAgentVersion,
  type DeviceCredentials,
} from './enrollment.js';
import { startCapture, captureFrame, getScreenInfo, getRawScreenDimensions, type ScreenFrame } from './screenCapture.js';
import { startCursorCapture } from './cursorCapture.js';
import { handleInputEvent, setScreenDimensions, setSessionState as setInjectorSessionState } from './inputInjector.js';
import { refreshSessionState, getSessionState, onSessionStateChange, type SessionState } from './lockState.js';
import { getActiveBackend } from './captureBackend.js';
import { ensureLockCaptureTask, startLockCapture, stopLockCapture } from './service.js';
import { sendSas, isSasAvailable } from './sas.js';
import { checkForUpdates, downloadUpdate, applyUpdate } from './updater.js';
import { openTerminal, writeTerminal, resizeTerminal, closeTerminal, closeAllTerminals } from './terminal.js';
import {
  listDirectory,
  readFile,
  writeFileBuffer,
  deleteFile,
  createDirectory,
  removeDirectory,
} from './fileTransfer.js';
import {
  AgentEvent,
  ServerEvent,
  type CommandPayload,
  type CommandResultPayload,
  type AgentStatusPayload,
  type SignalPayload,
  type SessionStateInfo,
} from '@monitour/shared';

const AGENT_VERSION = getAgentVersion();
const STATUS_INTERVAL = 30_000;

export class AgentConnection {
  private socket: Socket | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private stopCapture: (() => void) | null = null;
  private stopCursorCapture: (() => void) | null = null;
  private thumbTimer: ReturnType<typeof setInterval> | null = null;
  private thumbBusy = false;
  private credentials: DeviceCredentials;
  public deviceDeleted = false;
  public onDeviceDeleted?: () => void;
  public onStatusChange?: (connected: boolean) => void;
  /** Server announced a new agent update — run one check pass. */
  public onServerUpdateAvailable?: () => void;

  constructor(credentials: DeviceCredentials) {
    this.credentials = credentials;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  connect(): void {
    const url = this.credentials.serverUrl;
    console.log(`Connecting to server: ${url}`);

    this.socket = io(`${url}/agent`, {
      auth: { token: this.credentials.deviceToken },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      console.log(`Connected to server (socket=${this.socket?.id})`);
      this.onStatusChange?.(true);
      void getRawScreenDimensions().then((dims) => setScreenDimensions(dims.width, dims.height));
      this.sendStatus();
      this.startThumbnailCapture();
      this.startSessionStatePolling();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from server: ${reason}`);
      this.onStatusChange?.(false);
      this.stopThumbnailCapture();
    });

    this.socket.on('connect_error', (err) => {
      console.error('Connection error:', err.message);
      this.onStatusChange?.(false);
    });

    // ---- Handle commands from server ----
    this.socket.on(ServerEvent.Command, (cmd: CommandPayload) => {
      void this.handleCommand(cmd);
    });

    // ---- Handle WebRTC signaling ----
    this.socket.on(ServerEvent.Signal, (signal: SignalPayload) => {
      this.handleSignal(signal);
    });

    // ---- Handle desktop input events from dashboard ----
    this.socket.on('server:desktop-input', (input: Parameters<typeof handleInputEvent>[0]) => {
      handleInputEvent(input);
    });

    // ---- Device deleted from server — must re-enroll ----
    this.socket.on('server:device-deleted', () => {
      console.log('Device deleted from server — re-enrollment required');
      this.deviceDeleted = true;
      this.socket?.disconnect();
      this.onDeviceDeleted?.();
    });

    // ---- Server announces an agent update ----
    this.socket.on(ServerEvent.UpdateAvailable, () => {
      this.onServerUpdateAvailable?.();
    });

    // ---- Server tells us to end a session ----
    this.socket.on(ServerEvent.SessionEnd, (payload: { sessionId: string }) => {
      this.stopDesktopCapture();
      closeTerminal(payload.sessionId);
    });

    // ---- Periodic status reporting ----
    this.statusTimer = setInterval(() => this.sendStatus(), STATUS_INTERVAL);
  }

  disconnect(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.stopThumbnailCapture();
    this.stopSessionStatePolling();
    this.stopLockCaptureMode();
    this.stopDesktopCapture();
    closeAllTerminals();
    this.socket?.disconnect();
    this.socket = null;
  }

  // ---- Thumbnail capture (independent of desktop sessions) ----

  private startThumbnailCapture(): void {
    this.stopThumbnailCapture();
    this.thumbTimer = setInterval(() => void this.captureAndSendThumbnail(), 5000);
    void this.captureAndSendThumbnail(); // send one immediately
  }

  private stopThumbnailCapture(): void {
    if (this.thumbTimer) {
      clearInterval(this.thumbTimer);
      this.thumbTimer = null;
    }
  }

  private async captureAndSendThumbnail(): Promise<void> {
    if (this.thumbBusy || !this.socket?.connected) return;
    this.thumbBusy = true;
    try {
      const frame = await captureFrame({ quality: 30, fps: 1, maxWidth: 320 });
      // Update input injector with real screen dimensions for coordinate mapping
      const dims = await getRawScreenDimensions();
      setScreenDimensions(dims.width, dims.height);
      this.socket.emit('agent:thumbnail', {
        deviceId: this.credentials.deviceId,
        data: frame.data.toString('base64'),
        width: frame.width,
        height: frame.height,
        ts: frame.timestamp,
      });
    } catch (err) {
      console.error('Thumbnail capture error:', err);
    } finally {
      this.thumbBusy = false;
    }
  }

  // ---- Session lock/desktop state polling ----
  private sessionStateTimer: ReturnType<typeof setInterval> | null = null;
  private lastEmittedSessionState: SessionState | null = null;
  private lockCaptureActive = false;
  private lockCaptureTimer: ReturnType<typeof setInterval> | null = null;
  private lockCaptureReady = false;

  private buildSessionStateInfo(state: SessionState): SessionStateInfo {
    return {
      locked: state.locked,
      secureDesktop: state.secureDesktop,
      inputDesktop: state.inputDesktop,
      inputReachability: state.confidence === 'ffi' ? 'ok' : 'uncertain',
      sasAvailable: isSasAvailable(),
      captureBackend: getActiveBackend().name,
      confidence: state.confidence,
    };
  }

  private startSessionStatePolling(): void {
    this.stopSessionStatePolling();
    // Immediate probe + poll every 3s
    refreshSessionState();
    this.emitSessionStateIfChanged();
    this.sessionStateTimer = setInterval(() => {
      refreshSessionState();
      this.emitSessionStateIfChanged();
    }, 3000);
  }

  private stopSessionStatePolling(): void {
    if (this.sessionStateTimer) {
      clearInterval(this.sessionStateTimer);
      this.sessionStateTimer = null;
    }
  }

  emitUpdateProgress(progress: { stage: string; message: string; version?: string }): void {
    if (this.socket?.connected) {
      this.socket.emit(AgentEvent.UpdateResult, {
        deviceId: this.credentials.deviceId,
        progress,
        ts: Date.now(),
      });
    }
  }

  private emitSessionStateIfChanged(): void {
    if (!this.socket?.connected) return;
    const state = getSessionState();
    const changed =
      !this.lastEmittedSessionState ||
      state.locked !== this.lastEmittedSessionState.locked ||
      state.secureDesktop !== this.lastEmittedSessionState.secureDesktop;
    if (changed) {
      this.lastEmittedSessionState = { ...state };
      // Notify input injector of lock state
      setInjectorSessionState(state.locked);
      this.socket.emit(AgentEvent.SessionState, {
        deviceId: this.credentials.deviceId,
        sessionState: this.buildSessionStateInfo(state),
        ts: Date.now(),
      });
      // Start/stop lock screen capture based on lock state
      if (state.locked && !this.lockCaptureActive) {
        this.startLockCapture();
      } else if (!state.locked && this.lockCaptureActive) {
        this.stopLockCaptureMode();
      }
    }
  }

  // ---- Lock screen capture (reads frames from helper output) ----
  private startLockCapture(): void {
    console.log('Lock detected — starting lock screen capture');
    // Ensure the scheduled task exists (first time may need elevation)
    const ensure = ensureLockCaptureTask();
    if (!ensure.success) {
      console.warn('Failed to ensure lock capture task:', ensure.message);
    }
    const result = startLockCapture();
    if (!result.success) {
      console.warn('Failed to start lock capture:', result.message);
      return;
    }
    this.lockCaptureActive = true;
    this.lockCaptureReady = false;
    // Poll the helper's output directory for frames
    const outputDir = `${process.env.TEMP || '.'}/monitour-lock`;
    const readyPath = `${outputDir}/ready`;
    const framePath = `${outputDir}/frame.jpg`;
    this.lockCaptureTimer = setInterval(() => {
      try {
        if (!this.lockCaptureReady) {
          if (fs.existsSync(readyPath)) {
            this.lockCaptureReady = true;
            console.log('Lock capture helper ready');
          }
          return;
        }
        if (fs.existsSync(framePath)) {
          const data = fs.readFileSync(framePath);
          if (data.length > 0 && this.socket?.connected) {
            this.socket.emit('agent:frame', {
              header: {
                v: 1,
                kind: 'desktop',
                payload: { type: 'frame', seq: Date.now(), width: 0, height: 0, quality: 0, ts: Date.now(), sessionId: 'lock-capture' },
              },
              data,
            });
          }
        }
      } catch { /* ignore read errors */ }
    }, 100); // ~10fps polling
  }

  private stopLockCaptureMode(): void {
    console.log('Unlock detected — stopping lock screen capture');
    if (this.lockCaptureTimer) {
      clearInterval(this.lockCaptureTimer);
      this.lockCaptureTimer = null;
    }
    this.lockCaptureActive = false;
    this.lockCaptureReady = false;
    stopLockCapture();
  }

  private sendStatus(): void {
    if (!this.socket?.connected) return;
    const payload: AgentStatusPayload = {
      deviceId: this.credentials.deviceId,
      status: 'online',
      systemInfo: getScreenInfo(),
      timestamp: Date.now(),
      agentVersion: AGENT_VERSION,
      sessionState: this.buildSessionStateInfo(getSessionState()),
    };
    this.socket.emit(AgentEvent.Status, payload);
  }

  private async handleCommand(cmd: CommandPayload): Promise<void> {
    console.log(`Command: ${cmd.type} (session=${cmd.sessionId})`);

    const result: CommandResultPayload = {
      commandId: cmd.commandId,
      sessionId: cmd.sessionId,
      success: true,
    };

    try {
      switch (cmd.type) {
        case 'desktop:start': {
          const quality = (cmd.params.quality as number) ?? 60;
          const fps = (cmd.params.fps as number) ?? 15;
          const maxWidth = cmd.params.width as number | undefined;
          void getRawScreenDimensions().then((dims) => setScreenDimensions(dims.width, dims.height));
          this.startDesktopCapture(cmd.sessionId, quality, fps, maxWidth);
          result.data = { streaming: true };
          break;
        }

        case 'desktop:stop': {
          this.stopDesktopCapture();
          result.data = { streaming: false };
          break;
        }

        case 'desktop:sas': {
          const sasResult = await sendSas();
          if (sasResult.ok) {
            result.data = { sent: true, method: sasResult.method };
          } else {
            result.success = false;
            result.data = { requiresPhysical: true, reason: sasResult.reason };
            result.error = 'Software SAS blocked — ask the local user to press Ctrl+Alt+Del';
          }
          break;
        }

        case 'agent:update': {
          const serverUrl = this.credentials.serverUrl;
          try {
            this.emitUpdateProgress({ stage: 'checking', message: 'Checking for updates...' });
            const manifest = await checkForUpdates(serverUrl);
            if (!manifest) {
              result.data = { updated: false, reason: 'no-update' };
              this.emitUpdateProgress({ stage: 'done', message: 'No update available' });
              break;
            }
            this.emitUpdateProgress({ stage: 'downloading', message: `Downloading ${manifest.version}...`, version: manifest.version });
            const filepath = await downloadUpdate(serverUrl, manifest);
            this.emitUpdateProgress({ stage: 'installing', message: `Installing ${manifest.version}...`, version: manifest.version });
            applyUpdate(filepath);
            result.data = { updated: true, version: manifest.version };
            this.emitUpdateProgress({ stage: 'done', message: `Update to ${manifest.version} installing...`, version: manifest.version });
          } catch (err) {
            result.success = false;
            result.error = err instanceof Error ? err.message : String(err);
            this.emitUpdateProgress({ stage: 'error', message: result.error });
          }
          break;
        }

        case 'terminal:open': {
          const cols = (cmd.params.cols as number) ?? 80;
          const rows = (cmd.params.rows as number) ?? 24;
          const shell = cmd.params.shell as string | undefined;
          openTerminal(
            cmd.sessionId,
            cols,
            rows,
            shell,
            (data) => this.sendTerminalData(cmd.sessionId, data),
            (exitCode) => this.sendTerminalExit(cmd.sessionId, exitCode),
          );
          result.data = { opened: true };
          break;
        }

        case 'terminal:input': {
          writeTerminal(cmd.sessionId, cmd.params.data as string);
          result.data = { written: true };
          break;
        }

        case 'terminal:resize': {
          resizeTerminal(cmd.sessionId, cmd.params.cols as number, cmd.params.rows as number);
          result.data = { resized: true };
          break;
        }

        case 'terminal:close': {
          closeTerminal(cmd.sessionId);
          result.data = { closed: true };
          break;
        }

        case 'file:list': {
          const entries = await listDirectory(cmd.params.path as string);
          result.data = entries;
          break;
        }

        case 'file:download': {
          const data = await readFile(cmd.params.path as string);
          result.data = data.toString('base64');
          break;
        }

        case 'file:upload': {
          const buf = Buffer.from(cmd.params.data as string, 'base64');
          await writeFileBuffer(cmd.params.path as string, buf);
          result.data = { uploaded: true };
          break;
        }

        case 'file:delete': {
          if (cmd.params.recursive) {
            await removeDirectory(cmd.params.path as string);
          } else {
            await deleteFile(cmd.params.path as string);
          }
          result.data = { deleted: true };
          break;
        }

        case 'file:mkdir': {
          await createDirectory(cmd.params.path as string);
          result.data = { created: true };
          break;
        }

        case 'shell:exec': {
          // Quick shell command execution
          const { exec } = await import('node:child_process');
          const cmdStr = cmd.params.command as string;
          const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            exec(cmdStr, { timeout: 30_000 }, (err, stdout, stderr) => {
              if (err && !stdout && !stderr) reject(err);
              else resolve({ stdout, stderr });
            });
          });
          result.data = output;
          break;
        }

        default:
          result.success = false;
          result.error = `Unknown command: ${cmd.type}`;
      }
    } catch (err) {
      result.success = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    this.socket?.emit(AgentEvent.CommandResult, result);
  }

  private startDesktopCapture(
    sessionId: string,
    quality: number,
    fps: number,
    maxWidth?: number,
  ): void {
    this.stopDesktopCapture();

    this.stopCapture = startCapture({ quality, fps, maxWidth }, (frame: ScreenFrame) => {
      this.sendDesktopFrame(sessionId, frame);
    });

    this.stopCursorCapture = startCursorCapture({
      onState: (s) => {
        this.socket?.emit(AgentEvent.Cursor, {
          deviceId: this.credentials.deviceId,
          sessionId,
          x: s.x,
          y: s.y,
          visible: s.visible,
          shapeId: s.shapeId,
          ts: Date.now(),
        });
      },
      onShape: (shape) => {
        this.socket?.emit(AgentEvent.CursorShape, {
          deviceId: this.credentials.deviceId,
          shape,
          ts: Date.now(),
        });
      },
    });

    console.log(`Desktop capture started (session=${sessionId}, q=${quality}, fps=${fps})`);
  }

  private stopDesktopCapture(): void {
    if (this.stopCapture) {
      this.stopCapture();
      this.stopCapture = null;
      console.log('Desktop capture stopped');
    }
    if (this.stopCursorCapture) {
      this.stopCursorCapture();
      this.stopCursorCapture = null;
    }
  }

  private sendDesktopFrame(sessionId: string, frame: ScreenFrame): void {
    // Send frame header as JSON text, then raw JPEG bytes as binary
    // Both go through Socket.IO; in WebRTC mode these go over the data channel.
    // For simplicity in this MVP, we send frames via Socket.IO binary events.
    const header = {
      v: 1,
      kind: 'desktop',
      payload: {
        type: 'frame',
        seq: frame.seq,
        width: frame.width,
        height: frame.height,
        quality: 0,
        ts: frame.timestamp,
        sessionId,
      },
    };

    this.socket?.emit('agent:frame', {
      header,
      data: frame.data,
    });
  }

  private sendTerminalData(sessionId: string, data: string): void {
    this.socket?.emit('agent:terminal-data', { sessionId, data });
  }

  private sendTerminalExit(sessionId: string, exitCode: number): void {
    this.socket?.emit('agent:terminal-exit', { sessionId, exitCode });
  }

  private handleSignal(signal: SignalPayload): void {
    console.log(`Signal: ${signal.kind} (session=${signal.sessionId})`);
    // In a full implementation, this would set up WebRTC.
    // For now, we use Socket.IO as the transport (see sendDesktopFrame).
  }
}
