/**
 * E2E 用: DB(servicehub_e2e)を作り直し、購入者と同じ CLI(migrate / setup-org / サンプル投入)で準備してから
 * ビルド済みサーバー(dist/server/index.js)を起動する。終了時に停止する。
 * 事前に `pnpm build` が必要(`pnpm test:e2e` はビルドしてから実行する)。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { E2E } from './env';

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = r.status;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become healthy: ${String(last)}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync('dist/server/index.js')) throw new Error('dist がありません。先に pnpm build を実行してください');
  const url = new URL(E2E.databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+_e2e$/.test(dbName)) throw new Error(`Refusing to reset non-e2e database: ${dbName}`);
  const admin = new URL(E2E.databaseUrl);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: E2E.databaseUrl,
    DATABASE_SSL: 'disable',
    SESSION_SECRET: E2E.sessionSecret,
    APP_BASE_URL: E2E.baseUrl,
    PORT: String(E2E.port),
    EMAIL_PROVIDER: 'log',
    RUN_WORKER: 'true',
    WORKER_POLL_MS: '1000',
    MIGRATE_ON_START: 'false',
    LOG_LEVEL: 'warn',
    LOGIN_RATE_LIMIT_PER_15MIN: '1000',
    PUBLIC_RATE_LIMIT_PER_MIN: '1000',
  };
  execFileSync('node', ['dist/server/cli/migrate.js'], { env, stdio: 'pipe' });
  execFileSync(
    'node',
    [
      'dist/server/cli/setup-org.js',
      '--slug',
      E2E.orgSlug,
      '--name',
      'E2E Studio',
      '--owner-email',
      E2E.ownerEmail,
      '--owner-name',
      'E2E オーナー',
      '--password',
      E2E.password,
    ],
    { env, stdio: 'pipe' },
  );
  execFileSync('node', ['dist/server/cli/seed-sample.js'], { env, stdio: 'pipe' });

  const server = spawn('node', ['dist/server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  try {
    await waitForHealth(`${E2E.baseUrl}/healthz`, 30_000);
  } catch (e) {
    server.kill('SIGTERM');
    throw new Error(`${(e as Error).message}\n${log.slice(-4000)}`);
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/.e2e-server.pid', String(server.pid ?? ''), { flag: 'w' });
  return async () => {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (process.env.E2E_SHOW_SERVER_LOG) console.log(log.slice(-8000));
  };
}
