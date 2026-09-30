import pg from 'pg';
import { createPool } from '../../src/server/db/pool.js';
import { migrate } from '../../src/server/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://servicehub:servicehub_dev_pw@127.0.0.1:5432/servicehub_test';

/** テスト実行ごとにテストDBを作り直して移行を適用する */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error(`Refusing to reset non-test database: ${dbName}`);
  }
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await migrate(pool);
  await pool.end();
}
