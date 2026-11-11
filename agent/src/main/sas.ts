import koffi from 'koffi';
import { execSync } from 'node:child_process';

export type SasResult =
  | { ok: true; method: 'in-process' | 'system-task' }
  | { ok: false; reason: 'policy' | 'access-denied' | 'unavailable'; requiresPhysical: true };

const SAS_REGISTRY_PATH = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const SAS_TASK_NAME = 'MonitourSAS';

let sasDll: ReturnType<typeof koffi.load> | null = null;
let sendSasFn: ((asUser: boolean) => boolean) | null = null;

try {
  sasDll = koffi.load('sas');
  sendSasFn = sasDll.func('SendSAS', koffi.types.int32, [koffi.types.int32]) as (asUser: boolean) => boolean;
} catch {
  // sas.dll not available — try system task fallback
}

/**
 * Check if software SAS is allowed by policy.
 * SoftwareSASGeneration: 0/absent=blocked, 1=services only, 2=non-service, 3=both
 */
export function checkSasPolicy(): { registryValue: number | null; callable: boolean } {
  if (process.platform !== 'win32') return { registryValue: null, callable: false };
  try {
    const output = execSync(
      `reg query "${SAS_REGISTRY_PATH}" /v SoftwareSASGeneration`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    const match = output.match(/SoftwareSASGeneration\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    const value = match ? parseInt(match[1], 16) : null;
    return {
      registryValue: value,
      callable: value !== null && value >= 2,
    };
  } catch {
    // Key not found — SAS is blocked
    return { registryValue: null, callable: false };
  }
}

/**
 * Enable software SAS if running elevated (requires admin).
 * Sets SoftwareSASGeneration=3 (both services and non-service).
 */
export function enableSasPolicyIfElevated(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execSync(
      `reg add "${SAS_REGISTRY_PATH}" /v SoftwareSASGeneration /t REG_DWORD /d 3 /f`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Send Ctrl+Alt+Del (SAS) via escalation chain:
 * 1. In-process SendSAS (works when policy allows non-service)
 * 2. Registry assist if elevated, then retry
 * 3. SYSTEM one-shot task
 * 4. Physical fallback
 */
export async function sendSas(): Promise<SasResult> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unavailable', requiresPhysical: true };
  }

  const policy = checkSasPolicy();

  // Method 1: In-process SendSAS
  if (sendSasFn && policy.registryValue !== null && policy.registryValue >= 2) {
    try {
      const ok = sendSasFn(false);
      if (ok) return { ok: true, method: 'in-process' };
    } catch {
      // fall through
    }
  }

  // Method 2: Try to enable policy if elevated, then retry
  if (sendSasFn && policy.registryValue === null) {
    if (enableSasPolicyIfElevated()) {
      try {
        const ok = sendSasFn(false);
        if (ok) return { ok: true, method: 'in-process' };
      } catch {
        // fall through
      }
    }
  }

  // Method 3: SYSTEM one-shot task
  try {
    // Create task if it doesn't exist
    const script = `${process.cwd()}\\dist\\main\\sasHelper.js`;
    execSync(
      `schtasks /create /tn "${SAS_TASK_NAME}" /tr "node \\"${script}\\"" /sc once /st 00:00 /ru SYSTEM /rl highest /f`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    execSync(`schtasks /run /tn "${SAS_TASK_NAME}"`, { encoding: 'utf-8', stdio: 'pipe' });
    return { ok: true, method: 'system-task' };
  } catch {
    // Task creation/execution failed
  }

  // Method 4: Physical fallback
  return {
    ok: false,
    reason: policy.registryValue !== null && policy.registryValue < 2 ? 'policy' : 'unavailable',
    requiresPhysical: true,
  };
}

export function isSasAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  if (sendSasFn) {
    const policy = checkSasPolicy();
    return policy.registryValue !== null && policy.registryValue >= 2;
  }
  return false;
}
