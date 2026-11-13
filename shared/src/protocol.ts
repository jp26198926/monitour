// =============================================================================
// Monitour Protocol — shared message & type definitions across
//   - server   (Node.js + Express 5)
//   - dashboard (React + Vite)
//   - agent    (Electron + Node.js)
//
// Channels:
//   1. REST (HTTPS)         – auth, enrollment, device CRUD
//   2. Control Socket.IO    – persistent agent<->server, dashboard<->server
//   3. WebRTC DataChannel   – desktop frames, input, terminal, file transfer
// =============================================================================

// -----------------------------------------------------------------------------
// Domain model
// -----------------------------------------------------------------------------

export type DeviceStatus = 'online' | 'offline' | 'pending' | 'error';

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: string; // ISO-8601
}

export interface DeviceInfo {
  id: string;
  name: string;
  hostname: string;
  platform: NodeJS.Platform | 'unknown';
  arch: string;
  status: DeviceStatus;
  lastSeen: string | null;
  enrolledAt: string;
  labels: string[];
  agentVersion: string;
  systemInfo: SystemInfo | null;
  /** Group name this device belongs to (null = ungrouped). */
  group: string | null;
  /** User-defined alias name (overrides display name). */
  alias: string;
  /** Whether the device's screen session is currently locked. */
  sessionLocked?: boolean;
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  totalMemMB: number;
  freeMemMB: number;
  uptimeSec: number;
  loadAvg: number[];
  osVersion: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string;
  deviceCount: number;
  createdAt: string;
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
}

export interface UpdateManifest {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  filename: string;
  downloadUrl: string;
  notes: string;
  publishedAt: string;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  manifest: UpdateManifest | null;
}

export interface UpdateProgress {
  stage: 'checking' | 'downloading' | 'installing' | 'done' | 'error';
  message: string;
  version?: string;
}

// -----------------------------------------------------------------------------
// REST API contracts
// -----------------------------------------------------------------------------

// POST /api/auth/login
export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  user: UserInfo;
}

// POST /api/auth/register  (first-user-becomes-admin, or admin-only)
export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
}

// POST /api/enrollment/tokens  (admin creates one-time token)
export interface CreateEnrollmentTokenRequest {
  label?: string;
  expiresInHours?: number; // default 24
}
export interface EnrollmentTokenInfo {
  token: string;
  label: string;
  expiresAt: string;
  used: boolean;
}

export type EnrollmentMode = 'open' | 'locked';

// Agent enrollment exchange
// POST /api/enrollment/enroll
export interface AgentEnrollRequest {
  enrollmentToken: string;
  hostname: string;
  platform: string;
  arch: string;
  agentVersion: string;
  publicKeyPem: string; // agent's generated RSA public key
}
export interface AgentEnrollResponse {
  deviceId: string;
  deviceName: string;
  /** JWT used for the Socket.IO control channel. Long-lived, refreshable. */
  deviceToken: string;
  /** SHA-256 hash of the server's agent-auth certificate (pinning). */
  serverCertHash: string;
  /** Socket.IO URL the agent should connect to. */
  serverUrl: string;
}

// -----------------------------------------------------------------------------
// Socket.IO — Agent control channel
//   Namespace: /agent
//   Auth: deviceToken (JWT) in handshake.auth
// -----------------------------------------------------------------------------

export interface AgentHandshake {
  deviceId: string;
  deviceToken: string;
  agentVersion: string;
}

// Agent -> Server events
export enum AgentEvent {
  /** Periodic heartbeat + live system stats */
  Status = 'agent:status',
  /** Acknowledgement/response to a ServerEvent.Command */
  CommandResult = 'agent:command-result',
  /** WebRTC ICE/SDP signaling (agent side) */
  Signal = 'agent:signal',
  /** Log message (for dashboard live log view) */
  Log = 'agent:log',
  /** Agent checked for updates — result sent to server */
  UpdateResult = 'agent:update-result',
  /** Session lock/desktop state change */
  SessionState = 'agent:session-state',
  /** Cursor position/visibility sample (on change, ~30 Hz max) */
  Cursor = 'agent:cursor',
  /** Cursor bitmap, sent once per shape change */
  CursorShape = 'agent:cursor-shape',
}

// Server -> Agent events
export enum ServerEvent {
  /** Dispatch a command to the agent */
  Command = 'server:command',
  /** WebRTC ICE/SDP signaling (server relays from browser) */
  Signal = 'server:signal',
  /** Server instructs agent to disconnect a session */
  SessionEnd = 'server:session-end',
  /** Ping for latency measurement */
  Ping = 'server:ping',
  /** Server notifies agent of an available update */
  UpdateAvailable = 'server:update-available',
  /** Server tells agent it has been deleted and must re-enroll */
  DeviceDeleted = 'server:device-deleted',
}

export interface SessionStateInfo {
  locked: boolean;
  secureDesktop: boolean;
  inputDesktop: string | null;
  inputReachability: 'ok' | 'uncertain' | 'unavailable';
  sasAvailable: boolean;
  captureBackend: 'dxgi' | 'gdi';
  confidence: 'ffi' | 'heuristic';
}

export interface AgentStatusPayload {
  deviceId: string;
  status: DeviceStatus;
  systemInfo: SystemInfo;
  timestamp: number;
  agentVersion: string;
  sessionState?: SessionStateInfo;
}

export type CommandType =
  | 'desktop:start'
  | 'desktop:stop'
  | 'desktop:sas'
  | 'agent:update'
  | 'terminal:open'
  | 'terminal:input'
  | 'terminal:resize'
  | 'terminal:close'
  | 'file:list'
  | 'file:download'
  | 'file:upload'
  | 'file:delete'
  | 'file:mkdir'
  | 'shell:exec';

export interface CommandPayload {
  commandId: string;
  type: CommandType;
  sessionId: string;
  params: Record<string, unknown>;
}

export interface CommandResultPayload {
  commandId: string;
  sessionId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SignalPayload {
  sessionId: string;
  kind: 'offer' | 'answer' | 'ice-candidate' | 'renegotiate';
  data: string | IceCandidateInit;
}

/** Minimal ICE candidate shape (avoids DOM lib dependency in shared). */
export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// -----------------------------------------------------------------------------
// Socket.IO — Dashboard control channel
//   Namespace: /dashboard
//   Auth: JWT (user token) in handshake.auth
// -----------------------------------------------------------------------------

export enum DashboardEvent {
  /** Subscribe to a device's status updates */
  SubscribeDevice = 'dash:subscribe-device',
  UnsubscribeDevice = 'dash:unsubscribe-device',
  /** List of devices with live status */
  DevicesUpdate = 'dash:devices-update',
  /** Command the server to relay to an agent */
  SendCommand = 'dash:send-command',
  CommandResult = 'dash:command-result',
  /** WebRTC signaling relay */
  Signal = 'dash:signal',
  /** Ping */
  Ping = 'dash:ping',
  /** Cursor position/visibility sample (server -> dashboard) */
  CursorUpdate = 'device:cursor-update',
  /** Cursor bitmap (server -> dashboard) */
  CursorShape = 'device:cursor-shape',
}

// -----------------------------------------------------------------------------
// WebRTC DataChannel protocol
//   Channel labels:
//     'desktop-frames'  – binary JPEG frames + text JSON input
//     'terminal'        – text (JSON envelopes)
//     'files'           – binary chunks + text JSON control
// -----------------------------------------------------------------------------

export interface DesktopFrameHeader {
  type: 'frame';
  seq: number;
  width: number;
  height: number;
  quality: number;
  ts: number;
}

export type InputEvent =
  | { type: 'mousemove'; x: number; y: number }
  | { type: 'mousedown'; x: number; y: number; button: number }
  | { type: 'mouseup'; x: number; y: number; button: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'keydown'; key: string; code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
  | { type: 'keyup'; key: string; code: string };

/** Raw cursor bitmap — BGRA, 4 bytes/pixel, row-major, top-down. length = w*h*4 */
export interface CursorShape {
  /** Monotonic per-agent-run id; bumps whenever the bitmap changes. */
  shapeId: number;
  width: number;
  height: number;
  /** Hotspot in bitmap pixels (from GetIconInfo xHotspot/yHotspot). */
  hotspotX: number;
  hotspotY: number;
  /** Over the wire this arrives as a Socket.IO binary attachment (ArrayBuffer on the client). */
  pixels: Uint8Array;
}

/** Cursor position/visibility sample. Percent 0–100 float of primary monitor — same space as InputEvent. */
export interface CursorState {
  deviceId: string;
  sessionId: string;
  x: number;
  y: number;
  /** false when CURSOR_SHOWING is unset or the cursor is outside the primary monitor. */
  visible: boolean;
  /** Which shape the cursor currently has (see CursorShape.shapeId). */
  shapeId: number;
  ts: number;
}

export type TerminalMessage =
  | { type: 'open'; cols: number; rows: number; shell?: string }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close'; exitCode?: number }
  | { type: 'error'; message: string };

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export type FileMessage =
  | { type: 'list'; path: string }
  | { type: 'list-result'; path: string; entries: FileListEntry[] }
  | { type: 'download'; path: string }
  | { type: 'download-start'; path: string; size: number }
  | { type: 'chunk'; offset: number; data: Uint8Array }
  | { type: 'download-complete'; path: string }
  | { type: 'upload-start'; path: string; size: number }
  | { type: 'upload-complete'; path: string }
  | { type: 'error'; message: string; path?: string };

// -----------------------------------------------------------------------------
// Socket.IO event name constants (single source of truth)
// -----------------------------------------------------------------------------

export const AGENT_NS = '/agent';
export const DASHBOARD_NS = '/dashboard';

export const AUTH_HEADER = 'authorization';

// Wire-level message envelope for WebRTC data channels (JSON text frames).
// Binary frames are raw data (JPEG image bytes, file chunks) and are
// always preceded by a JSON text frame describing them.
export interface WireEnvelope<T = unknown> {
  v: 1;
  kind: 'desktop' | 'terminal' | 'file' | 'control';
  payload: T;
}

export function envelope<T>(kind: WireEnvelope<T>['kind'], payload: T): WireEnvelope<T> {
  return { v: 1, kind, payload };
}
