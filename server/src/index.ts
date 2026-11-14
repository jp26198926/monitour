import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import multer from 'multer';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig } from './config.js';
import { connectDatabase } from './db/index.js';
import { loadOrCreateCerts } from './certs/certOps.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { enrollmentRoutes } from './routes/enrollment.js';
import { groupRoutes } from './routes/groups.js';
import { agentUpdateRoutes } from './routes/agentUpdate.js';
import { agentPackageRoutes } from './routes/agentPackages.js';
import { setupSocketHandlers } from './socket/index.js';
import { createLogger, setLogLevel } from './utils/logger.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);

  log.info('Starting Monitour server…');
  log.info(`  Environment : ${cfg.NODE_ENV}`);
  log.info(`  Port        : ${cfg.PORT}`);
  log.info(`  MongoDB     : ${cfg.MONGO_URI}`);

  // Connect to MongoDB
  await connectDatabase(cfg.MONGO_URI);

  // Load / generate TLS certificate hierarchy
  const certs = loadOrCreateCerts(cfg.DATA_DIR);

  // Express app
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: cfg.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan(cfg.isProduction ? 'combined' : 'dev'));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), version: '0.1.0' });
  });

  // REST API
  app.use('/api/auth', authRoutes(cfg));
  app.use('/api/devices', deviceRoutes(cfg));
  app.use('/api/enrollment', enrollmentRoutes(cfg, certs));
  app.use('/api/groups', groupRoutes(cfg));
  app.use('/api/agent', agentUpdateRoutes(cfg));
  app.use('/api/agent', agentPackageRoutes(cfg, certs));

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      const gb = cfg.MAX_UPLOAD_SIZE / 1024 ** 3;
      const label = Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
      res.status(413).json({ error: `File too large — maximum upload size is ${label}` });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload failed: ${err.message}` });
      return;
    }
    const e = err as { code?: string; status?: number; statusCode?: number; message?: string };
    if (e?.code === 'ENOSPC') {
      res.status(507).json({ error: 'Server storage is full — cannot store the uploaded file' });
      return;
    }
    const status = e?.status ?? e?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: e.message || 'Bad request' });
      return;
    }
    log.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // HTTP + Socket.IO
  const httpServer = createServer(app);
  httpServer.requestTimeout = 0; // Node's 300s default kills slow multi-hundred-MB uploads
  const io = new SocketIOServer(httpServer, {
    cors: { origin: cfg.corsOrigins, credentials: true },
    maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB for file chunks
    pingInterval: 10_000,
    pingTimeout: 20_000,
  });

  // Make io accessible to routes (for emitting to agents)
  app.set('io', io);

  setupSocketHandlers(io, cfg, certs);

  httpServer.listen(cfg.PORT, cfg.HOST, () => {
    log.info(`Server listening on ${cfg.HOST}:${cfg.PORT}`);
    log.info(`Agent cert hash (pin): ${certs.agentCertHash.slice(0, 16)}…`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down…`);
    io.close();
    httpServer.close();
    const { disconnectDatabase } = await import('./db/index.js');
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
