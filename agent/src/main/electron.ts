import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  loadAgentConfig,
  loadAgentState,
  enroll,
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
import { checkForUpdates, downloadUpdate, applyUpdate } from './updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let connection: AgentConnection | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

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
}

// --- IPC: window controls ---
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

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
      agentVersion: '0.2.0',
    });
  } else {
    mainWindow?.webContents.send('app-state', {
      enrolled: false,
      serverUrl: cfg?.serverUrl ?? '',
    });
  }
});

// --- IPC: enroll ---
ipcMain.handle('enroll', async (_e, data: { serverUrl: string; enrollToken: string }) => {
  try {
    const cfg: AgentConfig = {
      serverUrl: data.serverUrl,
      enrollmentToken: data.enrollToken,
    };
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
        agentVersion: '0.2.0',
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Enrollment failed',
    };
  }
});

// --- IPC: forget / reset ---
ipcMain.handle('forget', () => {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
  // Remove config files
  const dir = join(homedir(), '.monitour-agent');
  if (existsSync(join(dir, 'state.json'))) rmSync(join(dir, 'state.json'));
  if (existsSync(join(dir, 'config.json'))) rmSync(join(dir, 'config.json'));
});

// --- IPC: password protection ---
ipcMain.handle('is-password-set', () => {
  return isPasswordSet();
});

ipcMain.handle('set-password', (_e, password: string) => {
  try {
    setConfigPassword(password);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to set password' };
  }
});

ipcMain.handle('verify-password', (_e, password: string) => {
  return verifyConfigPassword(password);
});

ipcMain.handle('remove-password', () => {
  try {
    removeConfigPassword();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to remove password' };
  }
});

// --- IPC: service install/uninstall ---
ipcMain.handle('install-service', async () => {
  return await installService();
});

ipcMain.handle('uninstall-service', async () => {
  return await uninstallService();
});

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

ipcMain.handle('download-update', async (_e, manifest: { downloadUrl: string }) => {
  const cfg = loadAgentConfig();
  if (!cfg?.serverUrl) return { success: false, error: 'No server URL configured' };
  try {
    const filepath = await downloadUpdate(cfg.serverUrl, manifest as never);
    return { success: true, filepath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Download failed' };
  }
});

ipcMain.handle('apply-update', (_e, filepath: string) => {
  applyUpdate(filepath);
  return { success: true };
});

// --- Agent connection management ---
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
    // Clear credentials and show re-enroll UI
    const dir = join(homedir(), '.monitour-agent');
    if (existsSync(join(dir, 'state.json'))) rmSync(join(dir, 'state.json'));
    if (existsSync(join(dir, 'config.json'))) rmSync(join(dir, 'config.json'));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status', { connected: false, lastSeen: Date.now() });
      mainWindow.webContents.send('device-deleted', {
        message: 'This device was removed from the server. Please re-enroll.',
      });
    }
  };
  connection.connect();

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
app.whenReady().then(() => {
  createWindow();

  // Auto-connect if already enrolled
  const state = loadAgentState();
  if (state.enrolled && state.credentials) {
    startConnection(state.credentials);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (statusTimer) clearInterval(statusTimer);
  if (connection) connection.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
