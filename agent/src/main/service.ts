import { platform } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';

const SERVICE_NAME = 'MonitourAgent';
const SERVICE_ID = 'com.monitour.agent.service';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: NodeJS.Platform;
}

function getAgentScriptPath(): string {
  // The headless CLI entry point — this is what runs as a service
  return join(process.cwd(), 'dist', 'main', 'index.js');
}

function getConfigDir(): string {
  return join(homedir(), '.monitour-agent');
}

/**
 * Install the agent as a system service (auto-start on boot).
 */
export async function installService(): Promise<{ success: boolean; message: string }> {
  const plat = platform();

  try {
    switch (plat) {
      case 'win32':
        return await installWindowsService();
      case 'linux':
        return await installLinuxService();
      case 'darwin':
        return await installMacService();
      default:
        return { success: false, message: `Unsupported platform: ${plat}` };
    }
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Uninstall the system service.
 */
export async function uninstallService(): Promise<{ success: boolean; message: string }> {
  const plat = platform();

  try {
    switch (plat) {
      case 'win32':
        return await uninstallWindowsService();
      case 'linux':
        return await uninstallLinuxService();
      case 'darwin':
        return await uninstallMacService();
      default:
        return { success: false, message: `Unsupported platform: ${plat}` };
    }
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check if the service is installed and running.
 */
export function getServiceStatus(): ServiceStatus {
  const plat = platform();

  try {
    switch (plat) {
      case 'win32':
        return checkWindowsService();
      case 'linux':
        return checkLinuxService();
      case 'darwin':
        return checkMacService();
      default:
        return { installed: false, running: false, platform: plat };
    }
  } catch {
    return { installed: false, running: false, platform: plat };
  }
}

// ---- Windows (node-windows) ----

async function installWindowsService(): Promise<{ success: boolean; message: string }> {
  try {
    const { Service } = (await import('node-windows' as string)) as {
      Service: new (opts: Record<string, unknown>) => NodeJS.EventEmitter;
    };
    const svc = new Service({
      name: SERVICE_NAME,
      description: 'Monitour remote management agent',
      script: getAgentScriptPath(),
      nodeOptions: ['--max-old-space-size=256'],
      env: [{ name: 'NODE_ENV', value: 'production' }],
      workingDirectory: process.cwd(),
    });

    return new Promise((resolve) => {
      svc.on('install', () => {
        (svc as unknown as { start: () => void }).start();
        resolve({ success: true, message: 'Service installed and started' });
      });
      svc.on('error', (err: unknown) => {
        resolve({ success: false, message: `Service error: ${String(err)}` });
      });
      (svc as unknown as { install: () => void }).install();
    });
  } catch {
    // Fallback: create a Windows Task Scheduler task for auto-start (elevated)
    return installWindowsTask();
  }
}

async function uninstallWindowsService(): Promise<{ success: boolean; message: string }> {
  try {
    const { Service } = (await import('node-windows' as string)) as {
      Service: new (opts: Record<string, unknown>) => NodeJS.EventEmitter;
    };
    const svc = new Service({
      name: SERVICE_NAME,
      script: getAgentScriptPath(),
    });

    return new Promise((resolve) => {
      svc.on('uninstall', () => {
        resolve({ success: true, message: 'Service uninstalled' });
      });
      svc.on('error', (err: unknown) => {
        resolve({ success: false, message: `Service error: ${String(err)}` });
      });
      (svc as unknown as { uninstall: () => void }).uninstall();
    });
  } catch {
    return uninstallWindowsTask();
  }
}

function checkWindowsService(): ServiceStatus {
  try {
    const result = execSync(`sc query "${SERVICE_NAME}"`, { encoding: 'utf-8', stdio: 'pipe' });
    const installed = result.includes('SERVICE_NAME');
    const running = result.includes('RUNNING');
    return { installed, running, platform: 'win32' };
  } catch {
    return { installed: false, running: false, platform: 'win32' };
  }
}

// Windows Task Scheduler fallback (runs elevated)
function installWindowsTask(): { success: boolean; message: string } {
  try {
    const script = getAgentScriptPath();
    const cmd = `schtasks /create /tn "${SERVICE_NAME}" /tr "node ${script}" /sc onstart /ru SYSTEM /f`;
    execSync(
      `powershell -Command "Start-Process cmd -ArgumentList '/c ${cmd}' -Verb RunAs -Wait"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    return { success: true, message: 'Auto-start task created (Task Scheduler)' };
  } catch (err) {
    return { success: false, message: `Failed to create task: ${err}` };
  }
}

function uninstallWindowsTask(): { success: boolean; message: string } {
  try {
    const cmd = `schtasks /delete /tn "${SERVICE_NAME}" /f`;
    execSync(
      `powershell -Command "Start-Process cmd -ArgumentList '/c ${cmd}' -Verb RunAs -Wait"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    return { success: true, message: 'Auto-start task removed' };
  } catch (err) {
    return { success: false, message: `Failed to remove task: ${err}` };
  }
}

// ---- Linux (systemd) ----

async function installLinuxService(): Promise<{ success: boolean; message: string }> {
  const unit = `[Unit]
Description=Monitour Remote Management Agent
After=network.target

[Service]
Type=simple
User=${process.env.USER || 'root'}
ExecStart=$(which node) ${getAgentScriptPath()}
Restart=always
RestartSec=10
Environment=NODE_ENV=production
WorkingDirectory=${process.cwd()}

[Install]
WantedBy=multi-user.target
`;

  const unitPath = '/etc/systemd/system/monitour-agent.service';
  try {
    writeFileSync(unitPath, unit);
    execSync('systemctl daemon-reload', { stdio: 'pipe' });
    execSync('systemctl enable monitour-agent', { stdio: 'pipe' });
    execSync('systemctl start monitour-agent', { stdio: 'pipe' });
    return { success: true, message: 'Service installed and started (systemd)' };
  } catch (err) {
    return { success: false, message: `Failed to install service: ${err}` };
  }
}

async function uninstallLinuxService(): Promise<{ success: boolean; message: string }> {
  try {
    execSync('systemctl stop monitour-agent', { stdio: 'pipe' });
    execSync('systemctl disable monitour-agent', { stdio: 'pipe' });
    rmSync('/etc/systemd/system/monitour-agent.service', { force: true });
    execSync('systemctl daemon-reload', { stdio: 'pipe' });
    return { success: true, message: 'Service uninstalled' };
  } catch (err) {
    return { success: false, message: `Failed to uninstall: ${err}` };
  }
}

function checkLinuxService(): ServiceStatus {
  try {
    const status = execSync('systemctl is-active monitour-agent', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { installed: true, running: status === 'active', platform: 'linux' };
  } catch {
    return { installed: false, running: false, platform: 'linux' };
  }
}

// ---- macOS (launchd) ----

async function installMacService(): Promise<{ success: boolean; message: string }> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execSync('which node', { encoding: 'utf-8' }).trim()}</string>
    <string>${getAgentScriptPath()}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${process.cwd()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;

  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_ID}.plist`);
  try {
    writeFileSync(plistPath, plist);
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
    return { success: true, message: 'Service installed and loaded (launchd)' };
  } catch (err) {
    return { success: false, message: `Failed to install service: ${err}` };
  }
}

async function uninstallMacService(): Promise<{ success: boolean; message: string }> {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_ID}.plist`);
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    rmSync(plistPath, { force: true });
    return { success: true, message: 'Service uninstalled' };
  } catch (err) {
    return { success: false, message: `Failed to uninstall: ${err}` };
  }
}

function checkMacService(): ServiceStatus {
  try {
    execSync(`launchctl list | grep ${SERVICE_ID}`, { encoding: 'utf-8', stdio: 'pipe' });
    return { installed: true, running: true, platform: 'darwin' };
  } catch {
    return { installed: false, running: false, platform: 'darwin' };
  }
}
