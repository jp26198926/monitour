import { io, type Socket } from 'socket.io-client';
import {
  loadAgentState,
  getAgentVersion,
  type DeviceCredentials,
} from './enrollment.js';
import { startCapture, captureFrame, getScreenInfo, getRawScreenDimensions, type ScreenFrame } from './screenCapture.js';
import { handleInputEvent, setScreenDimensions } from './inputInjector.js';
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
} from '@monitour/shared';

const AGENT_VERSION = getAgentVersion();
const STATUS_INTERVAL = 30_000;

export class AgentConnection {
  private socket: Socket | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private stopCapture: (() => void) | null = null;
  private thumbTimer: ReturnType<typeof setInterval> | null = null;
  private thumbBusy = false;
  private credentials: DeviceCredentials;
  public deviceDeleted = false;
  public onDeviceDeleted?: () => void;

  constructor(credentials: DeviceCredentials) {
    this.credentials = credentials;
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
      this.sendStatus();
      this.startThumbnailCapture();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`Disconnected from server: ${reason}`);
      this.stopThumbnailCapture();
    });

    this.socket.on('connect_error', (err) => {
      console.error('Connection error:', err.message);
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

  private sendStatus(): void {
    if (!this.socket?.connected) return;
    const payload: AgentStatusPayload = {
      deviceId: this.credentials.deviceId,
      status: 'online',
      systemInfo: getScreenInfo(),
      timestamp: Date.now(),
      agentVersion: AGENT_VERSION,
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
          this.startDesktopCapture(cmd.sessionId, quality, fps, maxWidth);
          result.data = { streaming: true };
          break;
        }

        case 'desktop:stop': {
          this.stopDesktopCapture();
          result.data = { streaming: false };
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

    console.log(`Desktop capture started (session=${sessionId}, q=${quality}, fps=${fps})`);
  }

  private stopDesktopCapture(): void {
    if (this.stopCapture) {
      this.stopCapture();
      this.stopCapture = null;
      console.log('Desktop capture stopped');
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
