import { Router } from 'express';
import { existsSync, mkdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import yazl from 'yazl';
import { z } from 'zod';
import multer from 'multer';
import { requireAuth, requireRole, type AuthedRequest } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { ServerCerts } from '../certs/certOps.js';
import { EnrollmentKey } from '../db/index.js';
import {
  INSTALLER_EXT,
  getAgentPackagesDir,
  slotDir,
  installerInfo,
  listSlotInstallers,
  findInstaller,
} from '../utils/installers.js';
import type {
  AgentBootstrap,
  AvailableInstallersResponse,
  UploadInstallerResponse,
} from '@monitour/shared';
import { createLogger } from '../utils/logger.js';

const log = createLogger('packages');

function getStagingDir(): string {
  return join(getAgentPackagesDir(), '.staging');
}

function buildInstallScript(platform: string, installerName: string | null): { name: string; body: string } {
  if (platform === 'win32') {
    return {
      name: 'install.bat',
      body: [
        '@echo off',
        'setlocal',
        'set "CFGDIR=%USERPROFILE%\\.monitour-agent"',
        'if not exist "%CFGDIR%" mkdir "%CFGDIR%"',
        'copy /Y "%~dp0monitour-bootstrap.json" "%CFGDIR%\\bootstrap.json" >nul',
        'if not exist "%ProgramData%\\Monitour" mkdir "%ProgramData%\\Monitour" 2>nul',
        'copy /Y "%~dp0monitour-bootstrap.json" "%ProgramData%\\Monitour\\bootstrap.json" >nul',
        'echo Installing Monitour Agent...',
        installerName
          ? `start /wait "" "%~dp0${installerName}"`
          : 'echo No installer found next to this script.',
        'echo Done. The agent enrolls automatically on first run.',
        'endlocal',
        '',
      ].join('\r\n'),
    };
  }
  return {
    name: 'install.sh',
    body: [
      '#!/usr/bin/env sh',
      'set -e',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'CFGDIR="${HOME}/.monitour-agent"',
      'mkdir -p "$CFGDIR"',
      'cp "$DIR/monitour-bootstrap.json" "$CFGDIR/bootstrap.json"',
      'case "$(uname -s)" in',
      '  Darwin)',
      '    echo "Opening the installer — drag Monitour Agent to Applications, then launch it to enroll."',
      '    open "$DIR"/*.dmg',
      '    ;;',
      '  *)',
      '    APPIMAGE="$(ls "$DIR"/*.AppImage 2>/dev/null | head -n 1)"',
      '    if [ -n "$APPIMAGE" ]; then',
      '      chmod +x "$APPIMAGE"',
      '      DEST="$HOME/.local/share/monitour-agent"',
      '      mkdir -p "$DEST"',
      '      cp "$APPIMAGE" "$DEST/monitour-agent.AppImage"',
      '      chmod +x "$DEST/monitour-agent.AppImage"',
      '      echo "Installed to $DEST/monitour-agent.AppImage — starting..."',
      '      "$DEST/monitour-agent.AppImage" >/dev/null 2>&1 &',
      '    else',
      '      echo "No installer found in $DIR — run the Monitour Agent installer manually."',
      '    fi',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  };
}

function buildReadme(installerName: string | null): string {
  return [
    'Monitour Agent package',
    '======================',
    '',
    'This package pre-configures the Monitour Agent to enroll with the server',
    'automatically — no tokens or URLs to type.',
    '',
    'Windows:  run install.bat',
    'macOS:    run install.sh (then drag the app to Applications and launch it)',
    'Linux:    run install.sh',
    '',
    installerName ? `Installer included: ${installerName}` : 'NOTE: no installer binary was found in this package.',
    '',
    'What the launcher does:',
    '  1. Copies monitour-bootstrap.json to the agent config location.',
    '  2. Runs the installer.',
    '  3. On first launch the agent reads the bootstrap, enrolls, and deletes it.',
    '',
  ].join('\n');
}

const createPackageSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  enrollmentKeyId: z.string().min(1),
  installService: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
});

export function agentPackageRoutes(cfg: Config, certs: ServerCerts): Router {
  const router = Router();
  mkdirSync(getAgentPackagesDir(), { recursive: true });
  // Sweep stale staged uploads from interrupted requests
  rmSync(getStagingDir(), { recursive: true, force: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdirSync(getStagingDir(), { recursive: true });
        cb(null, getStagingDir());
      },
      // Stage under the sanitized basename; slot selection happens after the
      // middleware completes (multipart field order is client-controlled).
      filename: (_req, file, cb) => cb(null, basename(file.originalname)),
    }),
    limits: { fileSize: cfg.MAX_UPLOAD_SIZE },
  });

  // GET /api/agent/packages/available — which stock installers are on disk
  router.get('/packages/available', requireAuth(cfg), requireRole('admin'), (_req, res) => {
    const available: AvailableInstallersResponse['available'] = {};
    for (const platform of Object.keys(INSTALLER_EXT)) {
      for (const arch of ['x64', 'arm64']) {
        const found = findInstaller(platform, arch);
        available[`${platform}-${arch}`] = found ? installerInfo(found.path, found.name) : null;
      }
    }
    res.json({ available, baseDir: getAgentPackagesDir() } satisfies AvailableInstallersResponse);
  });

  // POST /api/agent/packages/installers — upload a stock installer (admin)
  // Replace semantics: exactly one installer per <platform>-<arch> slot.
  const installerSlotSchema = z.object({
    platform: z.enum(['win32', 'darwin', 'linux']),
    arch: z.enum(['x64', 'arm64']),
  });

  router.post(
    '/packages/installers',
    requireAuth(cfg),
    requireRole('admin'),
    upload.single('file'),
    (req: AuthedRequest, res) => {
      const file = req.file;
      const cleanup = () => {
        if (file && existsSync(file.path)) unlinkSync(file.path);
      };

      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const parsed = installerSlotSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        cleanup();
        res.status(400).json({ error: 'Invalid platform or arch', details: parsed.error.flatten() });
        return;
      }
      const { platform, arch } = parsed.data;

      const name = basename(file.originalname);
      const ext = INSTALLER_EXT[platform];
      if (!name.toLowerCase().endsWith(ext.toLowerCase())) {
        cleanup();
        res.status(400).json({ error: `File for ${platform} must be a ${ext} installer` });
        return;
      }

      try {
        const dir = slotDir(platform, arch);
        mkdirSync(dir, { recursive: true });
        // Replace: exactly one installer per slot (findInstaller picks the
        // first readdir match — multiple files make packaging nondeterministic)
        const replaced = listSlotInstallers(platform, arch);
        for (const old of replaced) {
          unlinkSync(join(dir, old));
        }
        renameSync(file.path, join(dir, name));
        const installer = installerInfo(join(dir, name), name);
        log.info(`Installer uploaded: ${platform}-${arch}/${name} (replaced: ${replaced.join(', ') || 'none'})`);
        res.json({ installer, replaced } satisfies UploadInstallerResponse);
      } catch (err) {
        cleanup();
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to store installer' });
      }
    },
  );

  // DELETE /api/agent/packages/installers/:platform/:arch — remove installer(s) from a slot
  router.delete('/packages/installers/:platform/:arch', requireAuth(cfg), requireRole('admin'), (req, res) => {
    const parsed = installerSlotSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid platform or arch' });
      return;
    }
    const { platform, arch } = parsed.data;
    const files = listSlotInstallers(platform, arch);
    if (files.length === 0) {
      res.status(404).json({ error: 'No installer in this slot' });
      return;
    }
    for (const f of files) {
      unlinkSync(join(slotDir(platform, arch), f));
    }
    log.info(`Installer removed from ${platform}-${arch}: ${files.join(', ')}`);
    res.json({ deleted: files });
  });

  // GET /api/agent/packages/installers/:platform/:arch — download the raw installer (admin)
  router.get('/packages/installers/:platform/:arch', requireAuth(cfg), requireRole('admin'), (req, res) => {
    const parsed = installerSlotSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid platform or arch' });
      return;
    }
    const { platform, arch } = parsed.data;
    const installer = findInstaller(platform, arch);
    if (!installer) {
      res.status(404).json({ error: 'No installer in this slot' });
      return;
    }
    log.info(`Installer download: ${platform}-${arch}/${installer.name}`);
    res.download(installer.path, installer.name);
  });

  // POST /api/agent/packages — generate and stream a pre-configured agent zip
  router.post('/packages', requireAuth(cfg), requireRole('admin'), async (req: AuthedRequest, res) => {
    const parsed = createPackageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    const { platform, arch, enrollmentKeyId, installService, autoUpdate } = parsed.data;

    const keyDoc = await EnrollmentKey.findById(enrollmentKeyId);
    if (!keyDoc) {
      res.status(404).json({ error: 'Enrollment key not found' });
      return;
    }
    if (!keyDoc.isValid()) {
      res.status(400).json({ error: 'Enrollment key is expired or revoked' });
      return;
    }

    const installer = findInstaller(platform, arch);
    if (!installer) {
      res.status(400).json({
        error: `No installer binary on the server for ${platform}-${arch}. Place the built installer under ${join(getAgentPackagesDir(), `${platform}-${arch}`)}/ (see deploy docs).`,
      });
      return;
    }

    // Externally reachable server URL: PUBLIC_URL wins, else the request host
    const publicUrl = (cfg.PUBLIC_URL || `http://${req.headers.host ?? `localhost:${cfg.PORT}`}`).replace(/\/+$/, '');

    const bootstrap: AgentBootstrap = {
      v: 1,
      serverUrl: publicUrl,
      enrollmentKey: keyDoc.key,
      serverCertHash: certs.agentCertHash,
      webCertHash: certs.webCertHash,
      group: keyDoc.group,
      labels: keyDoc.labels,
      installService: installService ?? false,
      autoUpdate: autoUpdate ?? true,
    };

    const script = buildInstallScript(platform, installer.name);
    const zipName = `monitour-agent-${platform}-${arch}.zip`;
    log.info(`Agent package generated for ${keyDoc.name}: ${zipName} -> ${publicUrl}`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const zip = new yazl.ZipFile();
    zip.addFile(installer.path, installer.name);
    zip.addBuffer(Buffer.from(JSON.stringify(bootstrap, null, 2), 'utf-8'), 'monitour-bootstrap.json');
    zip.addBuffer(Buffer.from(script.body, 'utf-8'), script.name);
    zip.addBuffer(Buffer.from(buildReadme(installer.name), 'utf-8'), 'README.txt');
    zip.outputStream.pipe(res);
    zip.end();
  });

  return router;
}
