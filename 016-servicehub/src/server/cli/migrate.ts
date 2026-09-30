import { loadConfigForCli } from './cli-config.js';
import { checkRlsEffective, migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const config = loadConfigForCli();
const pool = createPool({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 2, applicationName: 'servicehub-migrate' });
try {
  const r = await migrate(pool, config.MIGRATIONS_DIR);
  console.info(`applied: ${r.applied.length ? r.applied.join(', ') : '(none)'}; already applied: ${r.skipped.length}`);
  const rls = await checkRlsEffective(pool);
  if (!rls.ok) console.warn(`WARNING: RLS not effective for role ${rls.role}: ${rls.reason}`);
} finally {
  await pool.end();
}
