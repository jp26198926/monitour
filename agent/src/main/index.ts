import {
  loadAgentConfig,
  loadAgentState,
  enroll,
  autoEnrollIfPossible,
  saveAgentConfig,
  loadOrCreateKeyPair,
  getAgentVersion,
  type DeviceCredentials,
} from './enrollment.js';
import { AgentConnection } from './connection.js';
import { getScreenInfo } from './screenCapture.js';
import { installService } from './service.js';
import { startUpdateChecker } from './updater.js';

async function main(): Promise<void> {
  console.log('========================================');
  console.log(`  Monitour Agent v${getAgentVersion()}`);
  console.log('========================================');

  // Already enrolled? Or auto-enrollable (bootstrap / key-bearing config)?
  const state = loadAgentState();
  let credentials: DeviceCredentials | undefined = state.enrolled ? state.credentials : undefined;

  if (!credentials) {
    const auto = await autoEnrollIfPossible().catch((err) => {
      console.error('Auto-enrollment failed:', err instanceof Error ? err.message : err);
      return null;
    });
    if (auto) {
      credentials = auto.credentials;
      if (auto.bootstrap?.installService) {
        const r = await installService();
        console.log('Service install:', r.message);
      }
    }
  }

  if (!credentials) {
    // Manual fallback: config.json, else environment variables
    let cfg = loadAgentConfig();
    if (!cfg) {
      const serverUrl = process.env.MONITOUR_SERVER_URL;
      const enrollmentKey = process.env.MONITOUR_ENROLLMENT_KEY;

      if (!serverUrl) {
        console.error('');
        console.error('No configuration found. To enroll this agent:');
        console.error('');
        console.error('  Option 1: Set environment variables');
        console.error('    MONITOUR_SERVER_URL=http://your-server:4430');
        console.error('    MONITOUR_ENROLLMENT_KEY=<key-from-dashboard>');
        console.error('');
        console.error('  Option 2: Create ~/.monitour-agent/config.json');
        console.error('    {');
        console.error('      "serverUrl": "http://your-server:4430",');
        console.error('      "enrollmentKey": "<key-from-dashboard>"');
        console.error('    }');
        console.error('');
        console.error('  Option 3: place a monitour-bootstrap.json next to this agent');
        console.error('    (downloaded as part of a server-generated agent package)');
        console.error('');
        process.exit(1);
      }

      cfg = {
        serverUrl,
        enrollmentKey,
      };
      saveAgentConfig(cfg);
    }

    console.log(`Server: ${cfg.serverUrl}`);
    loadOrCreateKeyPair();
    console.log('Enrolling with server…');
    // The server decides whether the supplied material is sufficient
    credentials = await enroll(cfg);
    saveAgentConfig(cfg);
  }

  const cred = credentials;
  console.log(`Enrolled as: ${cred.deviceName} (${cred.deviceId})`);

  // Print system info
  const info = getScreenInfo();
  console.log(`Host: ${info.hostname} | ${info.platform} ${info.arch} | ${info.cpus} cores | ${info.totalMemMB} MB RAM`);

  // Connect to server
  const connection = new AgentConnection(cred);
  connection.connect();

  // Background update checks (auto-applies when cfg.autoUpdate is on)
  const cfg = loadAgentConfig();
  if (cfg?.serverUrl) {
    const checker = startUpdateChecker(cfg.serverUrl, {
      autoUpdate: cfg.autoUpdate !== false,
      onProgress: (p) => connection.emitUpdateProgress(p),
    });
    connection.onServerUpdateAvailable = () => void checker.checkNow();
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down agent…');
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal agent error:', err);
  process.exit(1);
});
