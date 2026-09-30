import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_SSL: z.enum(['disable', 'require', 'no-verify']).default('disable'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  TRUST_PROXY: bool.default(false),
  RUN_WORKER: bool.default(false),
  MIGRATE_ON_START: bool.default(false),
  MIGRATIONS_DIR: z.string().optional(),
  STATIC_DIR: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  EMAIL_FROM: z.string().default('ServiceHub <no-reply@example.invalid>'),
  SMTP_URL: z.string().optional(),
  EMAIL_ALLOWLIST: z.string().optional(),
  ALLOW_RLS_BYPASS_ROLE: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(200).max(60000).default(5000),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10000).default(30),
  LOGIN_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).max(1000).default(10),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  cookieSecure: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  const cookieSecure =
    c.COOKIE_SECURE === 'auto' ? c.APP_BASE_URL.startsWith('https://') : c.COOKIE_SECURE === 'true';
  if (isProduction && c.SESSION_SECRET.includes('change-me')) {
    throw new Error('SESSION_SECRET must be changed for production');
  }
  if (c.EMAIL_PROVIDER === 'smtp' && !c.SMTP_URL) {
    throw new Error('SMTP_URL is required when EMAIL_PROVIDER=smtp');
  }
  return { ...c, isProduction, cookieSecure };
}
