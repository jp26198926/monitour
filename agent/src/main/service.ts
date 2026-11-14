import { platform, homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';

const SERVICE_NAME = 'MonitourAgent';
const SERVICE_ID = 'com.monitour.agent.service';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: NodeJS.Platform;
}

export interface ServiceActionResult {
  success: boolean;
  message: string;
  /** Fresh status after the action — drives the UI directly. */
  serviceStatus: ServiceStatus;
}

/**
 * Argv the service should run.
 *  - Packaged Electron app: the installed binary itself, headless.
 *  - Dev Electron: the Electron binary + the agent directory.
 *  - Plain node (CLI): node + the compiled CLI entry next to this module.
 */
function getServiceArgv(): string[] {
  if (process.versions.electron) {
    const exe = process.execPath;
    if (/electron/i.test(basename(exe))) {
      // Dev: execPath is the Electron binary and needs the app directory
      return [exe, join(import.meta.dirname, '..', '..'), '--service', '--hidden'];
    }
    return [exe, '--service', '--hidden'];
  }
  return [process.execPath, join(import.meta.dirname, 'index.js')];
}

/** Shell-quoted command line (schtasks /tr, systemd ExecStart). */
function getServiceCommand(): string {
  return getServiceArgv()
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
}

function getServiceWorkDir(): string {
  return process.versions.electron ? join(import.meta.dirname, '..', '..') : import.meta.dirname;
}

function getConfigDir(): string {
  return join(homedir(), '.monitour-agent');
}

/**
 * Install the agent as a system service (auto-start on boot).
 * Success is determined by verifying the service actually exists afterwards.
 */
export async function installService(): Promise<ServiceActionResult> {
  const plat = platform();

  let result: { success: boolean; message: string };
  try {
    switch (plat) {
      case 'win32':
        result = installWindowsTask();
        break;
      case 'linux':
        result = await installLinuxService();
        break;
      case 'darwin':
        result = await installMacService();
        break;
      default:
        result = { success: false, message: `Unsupported platform: ${plat}` };
    }
  } catch (err) {
    result = { success: false, message: err instanceof Error ? err.message : String(err) };
  }

  // Trust the actual state, not the command's exit code alone
  const serviceStatus = getServiceStatus();
  const success = result.success && serviceStatus.installed;
  return {
    success,
    message: success
      ? result.message
      : result.success
        ? 'Install command ran but the service is not present'
        : result.message,
    serviceStatus,
  };
}

/**
 * Uninstall the system service. Success = the service is actually gone.
 */
export async function uninstallService(): Promise<ServiceActionResult> {
  const plat = platform();

  let result: { success: boolean; message: string };
  try {
    switch (plat) {
      case 'win32':
        result = uninstallWindowsTask();
        break;
      case 'linux':
        result = await uninstallLinuxService();
        break;
      case 'darwin':
        result = await uninstallMacService();
        break;
      default:
        result = { success: false, message: `Unsupported platform: ${plat}` };
    }
  } catch (err) {
    result = { success: false, message: err instanceof Error ? err.message : String(err) };
  }

  const serviceStatus = getServiceStatus();
  const success = result.success && !serviceStatus.installed;
  return {
    success,
    message: success
      ? result.message
      : result.success
        ? 'Uninstall command ran but the service is still present'
        : result.message,
    serviceStatus,
  };
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

// ---- Windows (Task Scheduler, runs elevated) ----

function checkWindowsService(): ServiceStatus {
  try {
    // Existence by exit code — locale-proof (output text is localized on non-English Windows)
    execSync(`schtasks /query /tn "${SERVICE_NAME}"`, { encoding: 'utf-8', stdio: 'pipe' });
    let running = false;
    try {
      const detail = execSync(`schtasks /query /tn "${SERVICE_NAME}" /v /fo LIST`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      running = /Status:\s+Running/i.test(detail);
    } catch {
      // verbose query is best-effort — installed state is already known
    }
    return { installed: true, running, platform: 'win32' };
  } catch {
    return { installed: false, running: false, platform: 'win32' };
  }
}

/**
 * Run a batch file elevated and propagate its real exit code.
 * (Start-Process alone always "succeeds" — without -PassThru + exit $p.ExitCode
 * a failed schtasks would be reported as success.)
 */
function runElevatedBatch(lines: string[]): void {
  const batPath = join(tmpdir(), `monitour-svc-${Date.now()}-${process.pid}.bat`);
  writeFileSync(batPath, lines.join('\r\n') + '\r\n', { mode: 0o600 });
  try {
    execSync(
      `powershell -NoProfile -Command "$p = Start-Process -FilePath '${batPath}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
  } finally {
    rmSync(batPath, { force: true });
  }
}

function installWindowsTask(): { success: boolean; message: string } {
  try {
    // schtasks /tr needs embedded quotes escaped as \" inside the .bat line
    const command = getServiceCommand().replace(/"/g, '\\"');
    runElevatedBatch([
      `schtasks /create /tn "${SERVICE_NAME}" /tr "${command}" /sc onstart /ru SYSTEM /rl highest /f`,
    ]);
    return { success: true, message: 'Auto-start task created (Task Scheduler)' };
  } catch (err) {
    return { success: false, message: `Failed to create task: ${err instanceof Error ? err.message : err}` };
  }
}

function uninstallWindowsTask(): { success: boolean; message: string } {
  try {
    runElevatedBatch([`schtasks /delete /tn "${SERVICE_NAME}" /f`]);
    return { success: true, message: 'Auto-start task removed' };
  } catch (err) {
    return { success: false, message: `Failed to remove task: ${err instanceof Error ? err.message : err}` };
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
ExecStart=${getServiceCommand()}
Restart=always
RestartSec=10
Environment=NODE_ENV=production
WorkingDirectory=${getServiceWorkDir()}

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
  const programArgs = getServiceArgv()
    .map((a) => `    <string>${a}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${getServiceWorkDir()}</string>
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

// ---- Lock capture helper task management (Windows only) ----
const LOCK_TASK_NAME = 'MonitourLockCapture';

function getLockHelperScriptPath(): string {
  return join(import.meta.dirname, 'lockCaptureHelper.js');
}

export function ensureLockCaptureTask(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: false, message: 'Windows only' };
  try {
    const script = getLockHelperScriptPath();
    const outputDir = join(process.env.TEMP || '.', 'monitour-lock');
    // Create a one-shot task that runs on demand as SYSTEM
    const cmd = `schtasks /create /tn "${LOCK_TASK_NAME}" /tr "node \\"${script}\\" --desktop Winlogon --output \\"${outputDir}\\" --fps 10" /sc once /st 00:00 /ru SYSTEM /rl highest /f`;
    execSync(`powershell -Command "Start-Process cmd -ArgumentList '/c ${cmd}' -Verb RunAs -Wait"`, { encoding: 'utf-8', stdio: 'pipe' });
    return { success: true, message: 'Lock capture task created' };
  } catch (err) {
    return { success: false, message: `Failed to create lock capture task: ${err}` };
  }
}

export function startLockCapture(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: false, message: 'Windows only' };
  try {
    execSync(`schtasks /run /tn "${LOCK_TASK_NAME}"`, { encoding: 'utf-8', stdio: 'pipe' });
    return { success: true, message: 'Lock capture started' };
  } catch (err) {
    return { success: false, message: `Failed to start lock capture: ${err}` };
  }
}

export function stopLockCapture(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: false, message: 'Windows only' };
  try {
    execSync(`schtasks /end /tn "${LOCK_TASK_NAME}"`, { encoding: 'utf-8', stdio: 'pipe' });
    return { success: true, message: 'Lock capture stopped' };
  } catch {
    // Task may not be running — that's fine
    return { success: true, message: 'Lock capture not running' };
  }
}

export function removeLockCaptureTask(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: false, message: 'Windows only' };
  try {
    stopLockCapture();
    execSync(`powershell -Command "Start-Process cmd -ArgumentList '/c schtasks /delete /tn \\"${LOCK_TASK_NAME}\\" /f' -Verb RunAs -Wait"`, { encoding: 'utf-8', stdio: 'pipe' });
    return { success: true, message: 'Lock capture task removed' };
  } catch (err) {
    return { success: false, message: `Failed to remove lock capture task: ${err}` };
  }
}
