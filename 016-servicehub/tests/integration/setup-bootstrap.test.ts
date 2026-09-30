/**
 * 環境変数による初回セットアップ(シェルを使えないホスティング向け)
 * - 本番の組織が1つもない空のDBでだけ、最初の組織とオーナーを作る(2回目以降の起動では何もしない)
 * - 入力が不正なら作らない。パスワードはログに出さない。サンプル組織は SEED_SAMPLE_ON_START=true のときだけ
 * - サンプル組織は本番の組織に触れずに削除でき、サンプル専用のログイン(公開パスワード)も消える
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { migrate } from '../../src/server/db/migrate.js';
import { createPool } from '../../src/server/db/pool.js';
import { withSystem } from '../../src/server/db/tx.js';
import { FakeClock, systemClock } from '../../src/server/deps.js';
import { LogMailer } from '../../src/server/email/mailer.js';
import { deleteSampleOrganization, SAMPLE_SLUG } from '../../src/server/sample/seed.js';
import { bootstrapFromEnv } from '../../src/server/setup.js';
import { TEST_DATABASE_URL } from './global-setup.js';
import { login, makeTestContext, type TestContext } from './helpers.js';

const URL2 = TEST_DATABASE_URL.replace(/\/[a-z0-9_]+$/, '/servicehub_setup_test');
let t: TestContext;
let pool: pg.Pool;
const logs: string[] = [];
const log = { info: (...a: unknown[]) => logs.push(a.join(' ')), warn: (...a: unknown[]) => logs.push(a.join(' ')) };
const opts = () => ({ appBaseUrl: 'http://localhost:3000', sessionSecret: 'test-session-secret-0123456789abcdefghijklmnop', log });

beforeAll(async () => {
  t = await makeTestContext();
  const admin = new URL(URL2);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  pool = createPool({ connectionString: URL2, max: 4 });
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
  await t.close();
});

const count = () => withSystem(pool, (q) => q.one<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE NOT is_sample'));

describe('環境変数による初回セットアップ', () => {
  it('必要な値が足りない・不正なときは作らない', async () => {
    await bootstrapFromEnv(pool, opts(), { SETUP_ORG_SLUG: 'my-salon', SETUP_OWNER_EMAIL: 'owner@my-salon.example' });
    await bootstrapFromEnv(pool, opts(), { SETUP_ORG_SLUG: 'My Salon!', SETUP_OWNER_EMAIL: 'owner@my-salon.example', SETUP_OWNER_PASSWORD: 'long-enough-pass' });
    await bootstrapFromEnv(pool, opts(), { SETUP_ORG_SLUG: 'my-salon', SETUP_OWNER_EMAIL: 'owner@my-salon.example', SETUP_OWNER_PASSWORD: 'short' });
    // docker compose の空欄(空文字)は未設定と同じ
    await bootstrapFromEnv(pool, opts(), { SETUP_ORG_SLUG: 'my-salon', SETUP_ORG_NAME: '', SETUP_OWNER_EMAIL: 'owner@my-salon.example', SETUP_OWNER_PASSWORD: '', SETUP_TIMEZONE: '' });
    await bootstrapFromEnv(pool, opts(), { SETUP_ORG_SLUG: '', SETUP_OWNER_EMAIL: '', SETUP_OWNER_PASSWORD: '', SEED_SAMPLE_ON_START: '' });
    expect((await count()).n).toBe(0);
    expect(logs.join('\n')).toMatch(/すべて必要/);
    expect(logs.join('\n')).toMatch(/URL名/);
    expect(logs.join('\n')).toMatch(/10文字以上/);
  });

  it('空のDBでは組織・拠点・オーナーを作り、そのパスワードでログインできる。2回目の起動では何もしない', async () => {
    const env = {
      SETUP_ORG_SLUG: 'my-salon',
      SETUP_ORG_NAME: 'マイサロン',
      SETUP_OWNER_EMAIL: 'owner@my-salon.example',
      SETUP_OWNER_PASSWORD: 'first-owner-pass-2030',
      SETUP_OWNER_NAME: '山田 花子',
      SETUP_LOCATION_NAME: '本店',
      SETUP_TIMEZONE: '', // 空欄 → Asia/Tokyo
    };
    logs.length = 0;
    await bootstrapFromEnv(pool, opts(), env);
    expect((await count()).n).toBe(1);
    expect(logs.join('\n')).not.toContain('first-owner-pass-2030');
    expect(logs.join('\n')).toMatch(/SETUP_OWNER_PASSWORD を環境変数から削除/);
    const org = await withSystem(pool, (q) =>
      q.one<{ name: string; timezone: string; locations: number; owners: number }>(
        `SELECT o.name, o.timezone, (SELECT count(*)::int FROM locations l WHERE l.organization_id = o.id) AS locations,
                (SELECT count(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.role = 'owner') AS owners
           FROM organizations o WHERE o.slug = 'my-salon'`,
      ),
    );
    expect(org).toEqual({ name: 'マイサロン', timezone: 'Asia/Tokyo', locations: 1, owners: 1 });
    // 2回目の起動(値を変えても)では作らない。パスワードが残っていれば削除を促し、消した後は何も言わない
    logs.length = 0;
    await bootstrapFromEnv(pool, opts(), { ...env, SETUP_ORG_SLUG: 'other-salon' });
    expect((await count()).n).toBe(1);
    expect(logs.join('\n')).toMatch(/SETUP_OWNER_PASSWORD は環境変数から削除/);
    logs.length = 0;
    await bootstrapFromEnv(pool, opts(), { ...env, SETUP_OWNER_PASSWORD: '' });
    expect(logs).toEqual([]);
    // ログインできる
    const app = await buildApp({ ...t.deps, pool, clock: new FakeClock('2030-01-07T00:00:00Z'), mailer: new LogMailer(false) }, { serveStatic: false, logger: false });
    try {
      const s = await login(app, 'owner@my-salon.example', 'first-owner-pass-2030');
      const me = await s.get('/api/v1/auth/me');
      expect(me.body.organization.slug).toBe('my-salon');
      expect(me.body.membership.role).toBe('owner');
    } finally {
      await app.close();
    }
  });

  it('運用担当者はコマンドでパスワード再設定リンクを発行できる(メール未設定でオーナーが1人の場合の復旧)', async () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/server/cli/reset-password.ts', '--email', 'OWNER@my-salon.example', '--hours', '2'], {
      env: { ...process.env, DATABASE_URL: URL2, APP_BASE_URL: 'http://localhost:3000' },
      encoding: 'utf8',
    });
    const m = out.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
    expect(m).toBeTruthy();
    // リンクの期限は DB の現在時刻で決まるため、実時間の時計で確認する
    const app = await buildApp({ ...t.deps, pool, clock: systemClock, mailer: new LogMailer(false) }, { serveStatic: false, logger: false });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token: m![1], password: 'recovered-pass-2031' }, headers: { origin: 'http://localhost:3000' } });
      expect(res.statusCode).toBe(200);
      await login(app, 'owner@my-salon.example', 'recovered-pass-2031');
      const again = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token: m![1], password: 'another-pass-2031' }, headers: { origin: 'http://localhost:3000' } });
      expect(again.statusCode).toBe(404); // 1回限り
    } finally {
      await app.close();
    }
    const audit = await withSystem(pool, (q) => q.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'member.password_reset_link_issued' AND actor_type = 'operator'`));
    expect(audit.n).toBe(1);
    // 存在しないメールは失敗(終了コード 1)
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'src/server/cli/reset-password.ts', '--email', 'nobody@example.com'], { env: { ...process.env, DATABASE_URL: URL2 }, stdio: 'pipe' })).toThrow();
  });

  it('SEED_SAMPLE_ON_START=true でサンプル組織を1回だけ作る', async () => {
    await bootstrapFromEnv(pool, opts(), { SEED_SAMPLE_ON_START: 'true' });
    await bootstrapFromEnv(pool, opts(), { SEED_SAMPLE_ON_START: 'true' });
    const n = await withSystem(pool, (q) => q.one<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE slug = $1 AND is_sample', [SAMPLE_SLUG]));
    expect(n.n).toBe(1);
  });

  it('サンプル組織を削除すると、サンプル専用のログインも消え、本番の組織はそのまま', async () => {
    const r = await deleteSampleOrganization(pool);
    expect(r).toEqual({ deleted: true, users: 5 });
    const left = await withSystem(pool, (q) =>
      q.one<{ sample: number; users: number; prod: number }>(
        `SELECT (SELECT count(*)::int FROM organizations WHERE is_sample) AS sample,
                (SELECT count(*)::int FROM users WHERE email_normalized LIKE '%@sample-wellness.example') AS users,
                (SELECT count(*)::int FROM organizations WHERE slug = 'my-salon') AS prod`,
      ),
    );
    expect(left).toEqual({ sample: 0, users: 0, prod: 1 });
    expect(await deleteSampleOrganization(pool)).toEqual({ deleted: false, users: 0 });
    const app = await buildApp({ ...t.deps, pool, clock: new FakeClock('2030-01-07T00:00:00Z'), mailer: new LogMailer(false) }, { serveStatic: false, logger: false });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@sample-wellness.example', password: 'sample-pass-2026' }, headers: { origin: 'http://localhost:3000' } });
      expect(res.statusCode).toBe(401);
      await login(app, 'owner@my-salon.example', 'recovered-pass-2031'); // 上のテストで再設定したパスワード
    } finally {
      await app.close();
    }
  });
});
