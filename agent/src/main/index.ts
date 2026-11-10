import {
  loadAgentConfig,
  loadAgentState,
  enroll,
  saveAgentConfig,
  loadOrCreateKeyPair,
  type AgentConfig,
  type DeviceCredentials,
} from './enrollment.js';
import { AgentConnection } from './connection.js';
import { getScreenInfo } from './screenCapture.js';

const AGENT_VERSION = '0.2.0';

async function main(): Promise<void> {
  console.log('========================================');
  console.log(`  Monitour Agent v${AGENT_VERSION}`);
  console.log('========================================');

  // Load or prompt for config
  let cfg = loadAgentConfig();
  if (!cfg) {
    // Try environment variables
    const serverUrl = process.env.MONITOUR_SERVER_URL;
    const enrollmentToken = process.env.MONITOUR_ENROLLMENT_TOKEN;

    if (!serverUrl) {
      console.error('');
      console.error('No configuration found. To enroll this agent:');
      console.error('');
      console.error('  Option 1: Set environment variables');
      console.error('    MONITOUR_SERVER_URL=http://your-server:4430');
      console.error('    MONITOUR_ENROLLMENT_TOKEN=<token-from-dashboard>');
      console.error('');
      console.error('  Option 2: Create ~/.monitour-agent/config.json');
      console.error('    {');
      console.error('      "serverUrl": "http://your-server:4430",');
      console.error('      "enrollmentToken": "<token-from-dashboard>"');
      console.error('    }');
      console.error('');
      process.exit(1);
    }

    cfg = {
      serverUrl,
      enrollmentToken,
    };
    saveAgentConfig(cfg);
  }

  console.log(`Server: ${cfg.serverUrl}`);

  // Ensure we have a keypair
  const keys = loadOrCreateKeyPair();
  console.log(`Public key fingerprint loaded`);

  // Check enrollment state
  const state = loadAgentState();
  let credentials: DeviceCredentials | undefined = state.credentials;

  if (!credentials || !state.enrolled) {
    if (!cfg.enrollmentToken) {
      console.error('Not enrolled and no enrollment token configured.');
      console.error('Set MONITOUR_ENROLLMENT_TOKEN or add it to ~/.monitour-agent/config.json');
      process.exit(1);
    }

    console.log('Enrolling with server…');
    credentials = await enroll(cfg);
  } else {
    console.log(`Already enrolled as: ${credentials.deviceName} (${credentials.deviceId})`);
  }

  // Print system info
  const info = getScreenInfo();
  console.log(`Host: ${info.hostname} | ${info.platform} ${info.arch} | ${info.cpus} cores | ${info.totalMemMB} MB RAM`);

  // Connect to server
  const connection = new AgentConnection(credentials);
  connection.connect();

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
