/**
 * サンプル組織「Sample Wellness」を作成する(is_sample = true。メールは送信されない)。
 *   pnpm db:seed:sample             … 既に存在すれば何もしない
 *   pnpm db:seed:sample -- --reset  … サンプル組織を削除して作り直す(サンプル組織以外には触れない)
 *   pnpm db:seed:sample -- --delete … サンプル組織とサンプル専用のログインユーザーを削除する(本番で使い始める前に)
 * 本番の組織は setup-org で別に作成する(サンプルと本番は分離)。
 */
import { hasFlag, loadConfigForCli } from './cli-config.js';
import { createPool } from '../db/pool.js';
import { withSystem } from '../db/tx.js';
import { deleteSampleOrganization, seedSampleOrganization, SAMPLE_PASSWORD, SAMPLE_SLUG } from '../sample/seed.js';

const config = loadConfigForCli();
const pool = createPool({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 4, applicationName: 'servicehub-seed' });
try {
  const existing = await withSystem(pool, (q) => q.maybeOne<{ id: string; is_sample: boolean }>('SELECT id, is_sample FROM organizations WHERE slug = $1', [SAMPLE_SLUG]));
  if (existing && !existing.is_sample) {
    console.error(`slug "${SAMPLE_SLUG}" is used by a non-sample organization. Aborting.`);
    process.exitCode = 1;
  } else if (hasFlag('delete')) {
    const r = await deleteSampleOrganization(pool);
    console.info(r.deleted ? 'sample organization deleted' : 'sample organization does not exist');
    if (r.users > 0) console.info(`sample login users deleted: ${r.users}`);
    if (process.env.SEED_SAMPLE_ON_START === 'true') console.warn('SEED_SAMPLE_ON_START=true のままだと次の起動で再び作られます。false にしてください。');
  } else {
    if (existing && hasFlag('reset')) {
      await withSystem(pool, async (q) => {
        await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
        await q.exec('DELETE FROM organizations WHERE id = $1 AND is_sample = true', [existing.id]);
      });
      console.info('sample organization deleted');
    }
    const again = await withSystem(pool, (q) => q.maybeOne('SELECT 1 FROM organizations WHERE slug = $1', [SAMPLE_SLUG]));
    if (again) {
      console.info('sample organization already exists (use --reset to recreate)');
    } else {
      const r = await seedSampleOrganization(pool, { appBaseUrl: config.APP_BASE_URL, sessionSecret: process.env.SESSION_SECRET ?? 'sample-secret-for-seed-only-000000000' });
      console.info(`sample organization created: /p/${SAMPLE_SLUG}`);
      console.info(`sample logins (password: ${SAMPLE_PASSWORD}):`);
      for (const u of r.users) console.info(`  ${u.role.padEnd(9)} ${u.email}`);
    }
  }
} finally {
  await pool.end();
}
