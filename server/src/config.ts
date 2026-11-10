import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4430),
  HOST: z.string().default('0.0.0.0'),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/monitour'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  DEVICE_JWT_EXPIRES_IN: z.string().default('365d'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Path to the server's data folder (certs, keys). */
  DATA_DIR: z.string().default('./data'),
  /** Allowed origins for the dashboard (CORS). Comma-separated. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Log level */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  isProduction: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    corsOrigins: cfg.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: cfg.NODE_ENV === 'production',
  };
}
