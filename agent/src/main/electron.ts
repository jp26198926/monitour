import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  loadAgentConfig,
  loadAgentState,
  enroll,
  autoEnrollIfPossible,
  changeServerUrl,
  wipeDeviceIdentity,
  saveAgentConfig,
  isPasswordSet,
  setConfigPassword,
  verifyConfigPassword,
  removeConfigPassword,
  getAgentVersion,
  type AgentConfig,
  type DeviceCredentials,
} from './enrollment.js';
import { AgentConnection } from './connection.js';
import { getScreenInfo } from './screenCapture.js';
import { installService, uninstallService, getServiceStatus } from './service.js';
import { checkForUpdates, downloadUpdate, applyUpdate, startUpdateChecker } from './updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let connection: AgentConnection | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: false,
    title: 'Monitour Agent',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Resolve renderer path: works both in dev (src/) and after build (dist/)
  const rendererPath = join(__dirname, '../../src/renderer/index.html');
  void mainWindow.loadFile(rendererPath);

  // Close hides the window — the agent keeps running in the background
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

/** Single reopen path: tray, second-instance, activate. */
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// --- IPC: window controls ---
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.hide());

/**
 * Main-process gate for every settings mutation. The renderer prompts for the
 * password as UX; verification happens here — a compromised renderer cannot
 * change settings without it.
 */
function guard<A extends unknown[], R>(fn: (e: IpcMainInvokeEvent, ...args: A) => R) {
  return async (
    e: IpcMainInvokeEvent,
    password: string | null,
    ...args: A
  ): Promise<R | { success: false; error: string }> => {
    if (isPasswordSet() && !verifyConfigPassword(password ?? '')) {
      return { success: false, error: 'Invalid settings password' };
    }
    return fn(e, ...args);
  };
}

// --- System tray ---
function loadTrayIcon(): NativeImage | null {
  const candidates = [
    join(__dirname, '../../src/renderer/tray-icon.png'),
    join(process.resourcesPath, 'tray-icon.png'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  console.warn('Tray icon not found — running without tray');
  return null;
}

function requestQuit(): void {
  if (isPasswordSet()) {
    // No visible window from the tray — surface it to host the password prompt
    showMainWindow();
    mainWindow?.webContents.send('prompt-quit-password');
  } else {
    app.quit();
  }
}

function createTray(): void {
  if (tray || HEADLESS) return;
  const icon = loadTrayIcon();
  if (!icon) return; // degrade gracefully — no tray is better than a crash
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Monitour Agent');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showMainWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => requestQuit() },
    ]),
  );
  tray.on('double-click', () => showMainWindow());
  if (process.platform === 'darwin') tray.on('click', () => showMainWindow());
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

function applyTraySetting(): void {
  const cfg = loadAgentConfig();
  if (!HEADLESS && cfg?.showInTray !== false) createTray();
  else destroyTray();
}

// --- IPC: app ready — send current state ---
ipcMain.on('app-ready', () => {
  const state = loadAgentState();
  const cfg = loadAgentConfig();
  const info = getScreenInfo();

  if (state.enrolled && state.credentials) {
    mainWindow?.webContents.send('app-state', {
      enrolled: true,
      deviceName: state.credentials.deviceName,
      deviceId: state.credentials.deviceId,
      serverUrl: state.credentials.serverUrl,
      platform: `${info.platform} ${info.arch}`,
      agentVersion: getAgentVersion(),
    });
  } else {
    mainWindow?.webContents.send('app-state', {
      enrolled: false,
      serverUrl: cfg?.serverUrl ?? '',
    });
  }
});

// --- IPC: enroll ---
ipcMain.handle('enroll', guard(async (_e, data: { serverUrl: string; enrollKey: string }) => {
  try {
    // Merge into existing config — a re-enroll must not wipe passwordHash etc.
    const cfg: AgentConfig = {
      ...(loadAgentConfig() ?? { serverUrl: data.serverUrl }),
      serverUrl: data.serverUrl.replace(/\/+$/, ''),
    };
    if (data.enrollKey) cfg.enrollmentKey = data.enrollKey;
    saveAgentConfig(cfg);

    const credentials = await enroll(cfg);
    const info = getScreenInfo();

    // Connect the agent
    startConnection(credentials);

    return {
      success: true,
      state: {
        enrolled: true,
        deviceName: credentials.deviceName,
        deviceId: credentials.deviceId,
        serverUrl: credentials.serverUrl,
        platform: `${info.platform} ${info.arch}`,
        agentVersion: getAgentVersion(),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Enrollment failed',
    };
  }
}));

// --- IPC: settings snapshot (read-only, no password needed) ---
ipcMain.handle('get-settings', () => {
  const cfg = loadAgentConfig();
  const state = loadAgentState();
  return {
    serverUrl: cfg?.serverUrl ?? state.credentials?.serverUrl ?? '',
    deviceName: state.credentials?.deviceName ?? cfg?.deviceName ?? '',
    autoUpdate: cfg?.autoUpdate !== false,
    showInTray: cfg?.showInTray !== false,
    passwordSet: isPasswordSet(),
    serviceStatus: getServiceStatus(),
    agentVersion: getAgentVersion(),
  };
});

// --- IPC: show in system tray toggle ---
ipcMain.handle('set-show-in-tray', guard((_e, enabled: boolean) => {
  const cfg = loadAgentConfig();
  if (!cfg) return { success: false as const, error: 'No configuration found' };
  cfg.showInTray = !!enabled;
  saveAgentConfig(cfg);
  applyTraySetting();
  return { success: true as const };
}));

// --- IPC: quit the agent (password-gated when one is set) ---
ipcMain.handle('quit-app', guard(() => {
  app.quit();
  return { success: true as const };
}));

// --- IPC: change server URL (full re-enroll with rotated identity) ---
ipcMain.handle('change-server-url', guard(async (_e, newServerUrl: string, enrollmentKey?: string) => {
  try {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (connection) {
      connection.disconnect();
      connection = null;
    }
    const credentials = await changeServerUrl(newServerUrl, enrollmentKey);
    startConnection(credentials);
    return { success: true, deviceId: credentials.deviceId, deviceName: credentials.deviceName };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Re-enrollment failed' };
  }
}));

// --- IPC: rename device (served from the server) ---
ipcMain.handle('update-device-name', guard(async (_e, deviceName: string) => {
  const cfg = loadAgentConfig();
  const state = loadAgentState();
  if (!cfg?.serverUrl || !state.credentials) {
    return { success: false, error: 'Not enrolled' };
  }
  try {
    const axios = (await import('axios')).default;
    await axios.patch(
      `${cfg.serverUrl}/api/agent/profile`,
      { deviceName },
      { headers: { Authorization: `Bearer ${state.credentials.deviceToken}` }, timeout: 10_000 },
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Rename failed' };
  }
}));

// --- IPC: auto-update preference ---
ipcMain.handle('set-auto-update', guard((_e, enabled: boolean) => {
  const cfg = loadAgentConfig();
  if (!cfg) return { success: false, error: 'No configuration found' };
  cfg.autoUpdate = !!enabled;
  saveAgentConfig(cfg);
  return { success: true };
}));

// --- IPC: password protection ---
ipcMain.handle('is-password-set', () => {
  return isPasswordSet();
});

// First set needs no password; changing requires the current one.
ipcMain.handle('set-password', (_e, currentPassword: string | null, newPassword: string) => {
  try {
    if (isPasswordSet() && !verifyConfigPassword(currentPassword ?? '')) {
      return { success: false, error: 'Invalid settings password' };
    }
    setConfigPassword(newPassword);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to set password' };
  }
});

ipcMain.handle('verify-password', (_e, password: string) => {
  return verifyConfigPassword(password);
});

ipcMain.handle('remove-password', guard(() => {
  try {
    removeConfigPassword();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to remove password' };
  }
}));

// --- IPC: service install/uninstall ---
ipcMain.handle('install-service', guard(async () => {
  return await installService();
}));

ipcMain.handle('uninstall-service', guard(async () => {
  return await uninstallService();
}));

ipcMain.handle('service-status', () => {
  return getServiceStatus();
});

// --- IPC: update ---
ipcMain.handle('check-for-updates', async () => {
  const cfg = loadAgentConfig();
  if (!cfg?.serverUrl) return { hasUpdate: false, error: 'No server URL configured' };
  const manifest = await checkForUpdates(cfg.serverUrl);
  return { hasUpdate: !!manifest, manifest, currentVersion: getAgentVersion() };
});

ipcMain.handle('download-update', guard(async (_e, manifest: { downloadUrl: string }) => {
  const cfg = loadAgentConfig();
  if (!cfg?.serverUrl) return { success: false, error: 'No server URL configured' };
  try {
    const filepath = await downloadUpdate(cfg.serverUrl, manifest as never);
    return { success: true, filepath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Download failed' };
  }
}));

ipcMain.handle('apply-update', guard((_e, filepath: string) => {
  applyUpdate(filepath);
  return { success: true };
}));

// --- Agent connection management ---
let updateChecker: { stop: () => void; checkNow: () => Promise<void> } | null = null;

function startConnection(credentials: DeviceCredentials): void {
  if (connection) connection.disconnect();
  if (statusTimer) clearInterval(statusTimer);
  connection = new AgentConnection(credentials);
  connection.onStatusChange = (connected) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status', {
        connected,
        ...(connected ? { lastSeen: Date.now() } : {}),
      });
    }
  };
  connection.onDeviceDeleted = () => {
    // Stop status updates immediately
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    // Clear identity but keep config.json — the settings password must survive,
    // otherwise a server-side delete would unlock the UI.
    wipeDeviceIdentity();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status', { connected: false, lastSeen: Date.now() });
      mainWindow.webContents.send('device-deleted', {
        message: 'This device was removed from the server. Please re-enroll.',
      });
    }
  };
  connection.connect();

  // Background update checks (auto-applies when cfg.autoUpdate is on)
  const cfg = loadAgentConfig();
  if (cfg?.serverUrl) {
    updateChecker?.stop();
    updateChecker = startUpdateChecker(cfg.serverUrl, {
      autoUpdate: cfg.autoUpdate !== false,
      onProgress: (p) => connection?.emitUpdateProgress(p),
    });
    connection.onServerUpdateAvailable = () => void updateChecker?.checkNow();
  }

  // Send status updates to the renderer periodically
  statusTimer = setInterval(() => {
    if (connection && !connection.deviceDeleted && mainWindow && !mainWindow.isDestroyed()) {
      const connected = connection.isConnected();
      mainWindow.webContents.send('agent-status', {
        connected,
        ...(connected ? { lastSeen: Date.now() } : {}),
      });
    }
  }, 10_000);
}

// --- App lifecycle ---
const SERVICE_MODE = process.argv.includes('--service');
const HEADLESS = SERVICE_MODE || process.argv.includes('--hidden');

// One agent per machine: a second launch just shows the existing window.
// The lock is taken in service mode too — two instances would fight over the
// same device identity.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    if (!HEADLESS) createWindow();

    // Auto-connect if already enrolled, else try zero-input bootstrap enrollment
    const state = loadAgentState();
    if (state.enrolled && state.credentials) {
      startConnection(state.credentials);
    } else {
      try {
        const result = await autoEnrollIfPossible();
        if (result) {
          startConnection(result.credentials);
          if (result.bootstrap?.installService) {
            void installService().then((r) => console.log('Service install:', r.message));
          }
        }
      } catch (err) {
        console.error('Auto-enrollment failed:', err instanceof Error ? err.message : err);
      }
    }

    applyTraySetting();

    if (!HEADLESS) {
      app.on('activate', () => showMainWindow());
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  updateChecker?.stop();
  connection?.disconnect();
  destroyTray();
});

app.on('window-all-closed', () => {
  // Intentionally empty. Electron quits by default when every window closes —
  // the hidden agent must keep running. Real cleanup happens in before-quit.
});
