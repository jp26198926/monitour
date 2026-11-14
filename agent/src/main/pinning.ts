import { connect as tlsConnect } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';

/**
 * Server identity checks. Two anchors:
 *  - serverCertHash: SHA-256 of the server's agent-auth cert PEM, delivered
 *    out-of-band in the bootstrap. Compared against the enroll response.
 *  - webCertHash: SHA-256 of the server's web cert PEM. For https URLs the
 *    live TLS peer certificate is hashed and compared before trusting the
 *    connection. (No-op for plain http:// deployments.)
 */

export function verifyServerCertHash(expectedHash: string, actualCertPem: string): boolean {
  const actualHash = createHash('sha256').update(actualCertPem).digest('hex');
  return actualHash === expectedHash;
}

/** Hash the live TLS peer certificate of a server (same convention as webCertHash). */
export function probeTlsCertHash(serverUrl: string): Promise<string> {
  const url = new URL(serverUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: url.hostname, port, rejectUnauthorized: false, servername: url.hostname },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.raw) {
            socket.destroy();
            reject(new Error('No peer certificate presented'));
            return;
          }
          // Same convention as certOps: SHA-256 of the PEM text
          const x509 = new X509Certificate(cert.raw);
          const hash = createHash('sha256').update(x509.toString()).digest('hex');
          socket.destroy();
          resolve(hash);
        } catch (err) {
          socket.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('TLS probe timed out'));
    });
    socket.on('error', (err) => reject(err));
  });
}

/**
 * For https URLs, verify the live TLS cert matches the pinned webCertHash.
 * Plain http:// deployments have no TLS to pin — resolves (with a note).
 */
export async function verifyTlsIdentity(serverUrl: string, expectedWebCertHash?: string): Promise<void> {
  if (!expectedWebCertHash) return;
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  if (url.protocol !== 'https:') return;

  const actual = await probeTlsCertHash(serverUrl);
  if (actual !== expectedWebCertHash) {
    throw new Error('Server TLS identity mismatch — connection refused');
  }
}
