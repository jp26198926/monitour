import { generateKeyPairSync, createHash, randomBytes, type X509Certificate } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import { createLogger } from '../utils/logger.js';

const log = createLogger('certs');

export interface ServerCerts {
  /** Root CA certificate (self-signed) used to sign the certs below. */
  rootCertPem: string;
  rootKeyPem: string;
  /** Agent-authentication certificate — agents pin its SHA-256 hash. */
  agentCertPem: string;
  agentKeyPem: string;
  /** Web / HTTPS certificate (can be replaced in production). */
  webCertPem: string;
  webKeyPem: string;
  /** SHA-256 hash of agentCertPem (the pin agents trust). */
  agentCertHash: string;
}

interface PemPair {
  certPem: string;
  keyPem: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function generateCert(
  subject: forge.pki.CertificateField[],
  parentCert: forge.pki.Certificate,
  parentKey: forge.pki.rsa.PrivateKey,
  isCa = false,
  keySize = 3072,
): PemPair {
  const keys = forge.pki.rsa.generateKeyPair(keySize);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  cert.setSubject(subject);
  cert.setIssuer(parentCert.subject.attributes);
  cert.setExtensions(
    isCa
      ? [
          { name: 'basicConstraints', cA: true },
          { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
        ]
      : [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        ],
  );

  cert.sign(parentKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function generateSelfSignedRoot(commonName: string, keySize = 3072): PemPair {
  const keys = forge.pki.rsa.generateKeyPair(keySize);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Monitour' },
    { name: 'countryName', value: 'US' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function loadOrCreateCerts(dataDir: string): ServerCerts {
  ensureDir(dataDir);
  const paths = {
    rootCert: join(dataDir, 'root-cert.pem'),
    rootKey: join(dataDir, 'root-key.pem'),
    agentCert: join(dataDir, 'agent-cert.pem'),
    agentKey: join(dataDir, 'agent-key.pem'),
    webCert: join(dataDir, 'web-cert.pem'),
    webKey: join(dataDir, 'web-key.pem'),
  };

  const allExist = Object.values(paths).every((p) => existsSync(p));
  if (allExist) {
    log.info('Loading existing certificates from', dataDir);
    const certs: ServerCerts = {
      rootCertPem: readFileSync(paths.rootCert, 'utf-8'),
      rootKeyPem: readFileSync(paths.rootKey, 'utf-8'),
      agentCertPem: readFileSync(paths.agentCert, 'utf-8'),
      agentKeyPem: readFileSync(paths.agentKey, 'utf-8'),
      webCertPem: readFileSync(paths.webCert, 'utf-8'),
      webKeyPem: readFileSync(paths.webKey, 'utf-8'),
      agentCertHash: '',
    };
    certs.agentCertHash = createHash('sha256').update(certs.agentCertPem).digest('hex');
    return certs;
  }

  log.info('Generating new certificate hierarchy in', dataDir, '(this may take a moment)');
  const root = generateSelfSignedRoot('Monitour Root CA');
  const rootCertObj = forge.pki.certificateFromPem(root.certPem);
  const rootKeyObj = forge.pki.privateKeyFromPem(root.keyPem);

  const agent = generateCert(
    [
      { name: 'commonName', value: 'Monitour Agent Auth' },
      { name: 'organizationName', value: 'Monitour' },
    ],
    rootCertObj,
    rootKeyObj,
    false,
  );

  const web = generateCert(
    [
      { name: 'commonName', value: 'Monitour Web' },
      { name: 'organizationName', value: 'Monitour' },
    ],
    rootCertObj,
    rootKeyObj,
    false,
  );

  writeFileSync(paths.rootCert, root.certPem);
  writeFileSync(paths.rootKey, root.keyPem, { mode: 0o600 });
  writeFileSync(paths.agentCert, agent.certPem);
  writeFileSync(paths.agentKey, agent.keyPem, { mode: 0o600 });
  writeFileSync(paths.webCert, web.certPem);
  writeFileSync(paths.webKey, web.keyPem, { mode: 0o600 });

  const agentCertHash = createHash('sha256').update(agent.certPem).digest('hex');
  log.info('Certificate generation complete. Agent cert hash:', agentCertHash);

  return {
    rootCertPem: root.certPem,
    rootKeyPem: root.keyPem,
    agentCertPem: agent.certPem,
    agentKeyPem: agent.keyPem,
    webCertPem: web.certPem,
    webKeyPem: web.keyPem,
    agentCertHash,
  };
}

/**
 * Compute the SHA-256 fingerprint of an RSA public key (PEM).
 * Used to uniquely identify a device by its key.
 */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex');
}
