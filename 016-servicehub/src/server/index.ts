import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { checkRlsEffective, migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { systemClock } from './deps.js';
import { createMailer } from './email/mailer.js';
import { startBackgroundJobs } from './jobs/runner.js';
import { RealtimeHub } from './realtime/hub.js';
import { bootstrapFromEnv } from './setup.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
    applicationName: 'servicehub-web',
  });
  const rls = await checkRlsEffective(pool);
  if (!rls.ok) {
    const msg = `[security] Row Level Security is NOT effective for role "${rls.role}": ${rls.reason}`;
    if (config.isProduction && !config.ALLOW_RLS_BYPASS_ROLE) {
      console.error(`${msg}. Refusing to start. Use a non-superuser role without BYPASSRLS.`);
      process.exit(1);
    }
    console.warn(`${msg}. (continuing: not production or ALLOW_RLS_BYPASS_ROLE=true)`);
  }
  if (config.MIGRATE_ON_START) {
    const r = await migrate(pool, config.MIGRATIONS_DIR);
    if (r.applied.length) console.info(`[db] applied migrations: ${r.applied.join(', ')}`);
  }
  // 初回セットアップ(SETUP_* の環境変数がある場合のみ)・サンプル組織(SEED_SAMPLE_ON_START=true)
  await bootstrapFromEnv(pool, { appBaseUrl: config.APP_BASE_URL, sessionSecret: config.SESSION_SECRET, log: console });
  const mailer = createMailer(config);
  const realtime = new RealtimeHub(
    config.DATABASE_URL,
    config.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : config.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined,
  );
  await realtime.start();
  const deps = { pool, config, clock: systemClock, mailer, log: console, realtime };
  const app = await buildApp(deps);
  const stopJobs = config.RUN_WORKER ? startBackgroundJobs(deps) : null;

  const shutdown = async (signal: string) => {
    console.info(`[server] ${signal} received, shutting down`);
    stopJobs?.();
    await realtime.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  console.info(`[server] listening on ${config.HOST}:${config.PORT} (worker in-process: ${config.RUN_WORKER})`);
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
