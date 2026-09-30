import { loadConfig } from './config.js';
import { checkRlsEffective } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { systemClock } from './deps.js';
import { createMailer } from './email/mailer.js';
import { startBackgroundJobs } from './jobs/runner.js';

/** 通知ワーカー/スケジューラ専用プロセス(Web と分ける場合: RUN_WORKER=false で Web を起動し、これを別に起動) */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 4, ssl: config.DATABASE_SSL, applicationName: 'servicehub-worker' });
  const rls = await checkRlsEffective(pool);
  if (!rls.ok && config.isProduction && !config.ALLOW_RLS_BYPASS_ROLE) {
    console.error(`[security] RLS not effective for role ${rls.role}: ${rls.reason}. Refusing to start.`);
    process.exit(1);
  }
  const deps = { pool, config, clock: systemClock, mailer: createMailer(config), log: console };
  const stop = startBackgroundJobs(deps);
  console.info(`[worker] started (email provider: ${deps.mailer.name})`);
  const shutdown = async () => {
    stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
