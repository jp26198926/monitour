/**
 * SAS helper — runs as SYSTEM via scheduled task.
 * Sends Ctrl+Alt+Del (Secure Attention Sequence) and exits.
 * Usage: node sasHelper.js
 */
import koffi from 'koffi';

try {
  const sas = koffi.load('sas');
  const SendSAS = sas.func('SendSAS', koffi.types.int32, [koffi.types.int32]);
  const ok = SendSAS(0); // AsUser = FALSE
  console.log(ok ? 'SAS sent' : 'SendSAS returned false');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('Failed to send SAS:', err);
  process.exit(1);
}
