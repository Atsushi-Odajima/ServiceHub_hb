/**
 * セキュリティ(Phase 9)
 * - テナント分離: 登録済みの全APIを、他組織の Owner が組織AのIDで呼んでも成功せず・データを返さず・組織Aは変わらない
 * - 未ログインでは公開/認証以外の全APIが 401
 * - DB層(RLS): 全テナント表で他組織の行は見えない。テナント文脈なしでは何も見えない
 * - CSRF / Origin / Cookie 属性 / セキュリティヘッダー / 入力(SQL記号・本文上限) / XSS(文字として扱う) / ログの個人情報
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createBackup } from '../../src/server/backup/dump.js';
import { verifyBackup } from '../../src/server/backup/verify.js';
import { EXPORT_KINDS } from '../../src/server/modules/csv/export.js';
import { withSystem, withSystemForOrg, withTenant } from '../../src/server/db/tx.js';
import { SAMPLE_PASSWORD, SAMPLE_SLUG, seedSampleOrganization, type SampleIds } from '../../src/server/sample/seed.js';
import { anonymous, createOrgFixture, login, makeTestContext, TEST_ORIGIN, type ApiSession, type OrgFixture, type TestContext } from './helpers.js';

const SECRET = 'test-session-secret-0123456789abcdefghijklmnop';
let t: TestContext;
let ids: SampleIds;
let orgB: OrgFixture;
let ownerB: ApiSession;
let dir: string;
/** 組織Aの表ごとの行ID */
const aIds = new Map<string, string[]>();
/** 組織Aのデータに固有の文字列(応答に含まれたら漏えい) */
const aMarkers = new Set<string>();

async function purgeSample() {
  await withSystem(t.pool, async (q) => {
    await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
    await q.exec('DELETE FROM organizations WHERE slug = $1', [SAMPLE_SLUG]);
  });
}

/** 組織Aの全表の内容ハッシュ(バックアップと同じ方法で計算) */
async function digestOrgA(): Promise<Record<string, string>> {
  const file = path.join(dir, `${randomUUID()}.shbak`);
  await createBackup(t.pool, ids.orgId, createWriteStream(file), { now: new Date('2030-01-01T00:00:00Z') });
  const v = await verifyBackup(file);
  expect(v.ok).toBe(true);
  return v.tableDigests;
}

const TABLE_BY_SEGMENT: Record<string, string> = {
  locations: 'locations',
  exceptions: 'location_exceptions',
  members: 'memberships',
  staff: 'staff',
  services: 'services',
  shifts: 'staff_shifts',
  'shift-templates': 'staff',
  resources: 'resources',
  records: 'service_records',
  bookings: 'bookings',
  customers: 'customers',
  notes: 'customer_notes',
  import: 'csv_imports',
  'pass-products': 'pass_products',
  'plan-products': 'plan_products',
  passes: 'customer_passes',
  plans: 'customer_plans',
  waitlist: 'waitlist_entries',
  matches: 'waitlist_matches',
  notifications: 'notifications',
};

/** ルートの :param を組織Aの実在IDで埋める */
function fillWithOrgA(url: string): string | null {
  const segs = url.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].startsWith(':')) continue;
    const prev = segs[i - 1];
    if (segs[i] === ':kind') {
      segs[i] = 'customers';
      continue;
    }
    let table = TABLE_BY_SEGMENT[prev];
    if (prev === 'blocks') table = url.includes('/resources/') ? 'resource_blocks' : 'location_blocks';
    if (prev === 'invitations') table = 'invitations';
    if (!table) return null;
    const list = aIds.get(table);
    if (!list?.length) throw new Error(`組織Aに ${table} の行がありません(${url})`);
    segs[i] = list[0];
  }
  return segs.join('/');
}

function apiRoutes() {
  return t.app.routeList.filter((r) => r.url.startsWith('/api/v1/') && !r.url.startsWith('/api/v1/public/') && !r.url.startsWith('/api/v1/auth/'));
}

beforeAll(async () => {
  t = await makeTestContext();
  dir = await mkdtemp(path.join(os.tmpdir(), 'servicehub-security-'));
  await purgeSample();
  ids = await seedSampleOrganization(t.pool, { appBaseUrl: TEST_ORIGIN, sessionSecret: SECRET, now: t.clock.now() });
  orgB = await createOrgFixture(t.pool);
  ownerB = await login(t.app, orgB.users.owner.email);

  // 組織Aに、サンプルに無い種類の行も作っておく(全ルートを実在IDで試すため)
  await withSystemForOrg(t.pool, ids.orgId, async (q) => {
    const loc = ids.locations.ikebukuro;
    await q.exec(`INSERT INTO location_exceptions (organization_id, location_id, date, kind, note) VALUES ($1, $2, '2030-02-11', 'closed', '祝日')`, [ids.orgId, loc]);
    await q.exec(`INSERT INTO location_blocks (organization_id, location_id, starts_at, ends_at, note) VALUES ($1, $2, '2030-02-12T01:00:00Z', '2030-02-12T02:00:00Z', '点検')`, [ids.orgId, loc]);
    await q.exec(`INSERT INTO resource_blocks (organization_id, resource_id, starts_at, ends_at, kind) VALUES ($1, $2, '2030-02-12T01:00:00Z', '2030-02-12T02:00:00Z', 'maintenance')`, [ids.orgId, ids.resources.roomA]);
    await q.exec(`INSERT INTO customer_notes (organization_id, customer_id, body, visibility, author_label) VALUES ($1, $2, '組織Aの機密メモ', 'confidential', 'テスト')`, [ids.orgId, ids.customers.repeater]);
    await q.exec(
      `INSERT INTO csv_imports (organization_id, kind, file_name, file_hash, status, row_count, error_count, rows) VALUES ($1, 'customers', 'a.csv', $2, 'previewed', 1, 0, '[]')`,
      [ids.orgId, randomUUID()],
    );
    await q.exec(
      `INSERT INTO invitations (organization_id, email, email_normalized, role, token_hash, expires_at) VALUES ($1, 'invitee@a.example', 'invitee@a.example', 'staff', $2, now() + interval '7 days')`,
      [ids.orgId, randomUUID()],
    );
    const w = await q.one<{ id: string; location_id: string; service_id: string }>(`SELECT id, location_id, service_id FROM waitlist_entries WHERE organization_id = $1 LIMIT 1`, [ids.orgId]);
    await q.exec(`INSERT INTO waitlist_matches (organization_id, waitlist_entry_id, location_id, service_id, starts_at, status) VALUES ($1, $2, $3, $4, '2030-02-13T01:00:00Z', 'open')`, [
      ids.orgId,
      w.id,
      w.location_id,
      w.service_id,
    ]);
    for (const table of [...new Set([...Object.values(TABLE_BY_SEGMENT), 'resource_blocks', 'location_blocks', 'invitations'])]) {
      const rows = await q.many<{ id: string }>(`SELECT id::text AS id FROM ${table} WHERE organization_id = $1 ORDER BY id LIMIT 50`, [ids.orgId]);
      aIds.set(table, rows.map((r) => r.id));
      for (const r of rows) aMarkers.add(r.id);
    }
    const cust = await q.many<{ name: string; phone: string | null }>(`SELECT name, phone FROM customers WHERE organization_id = $1`, [ids.orgId]);
    for (const c of cust) {
      aMarkers.add(c.name);
      if (c.phone) aMarkers.add(c.phone);
    }
  });
  aMarkers.add(ids.orgId);
  aMarkers.add('組織Aの機密メモ');
});

afterAll(async () => {
  await purgeSample();
  await t.close();
  await rm(dir, { recursive: true, force: true });
});

describe('テナント分離(登録済みの全API)', () => {
  it('ルート一覧を取得できる(網羅の前提)', () => {
    const routes = apiRoutes();
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.url === '/api/v1/bookings/:id/cancel' && r.method === 'POST')).toBe(true);
  });

  it('未ログインでは公開・認証以外の全APIが 401 になる', async () => {
    const anon = anonymous(t.app);
    const unexpected: string[] = [];
    for (const r of apiRoutes()) {
      const url = fillWithOrgA(r.url) ?? r.url;
      const res = await anon.request(r.method, url, r.method === 'GET' ? undefined : {});
      if (res.status !== 401) unexpected.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(unexpected).toEqual([]);
  });

  it('他組織の Owner が組織AのIDを指定しても、全APIで成功せず、組織Aのデータを返さず、組織Aは変わらない', async () => {
    const before = await digestOrgA();
    const succeeded: string[] = [];
    const leaked: string[] = [];
    let tried = 0;
    for (const r of apiRoutes()) {
      // 組織Aの行を指すパラメータがあるルートのみ(:kind は出力の種類で、IDではない)
      if (!/:(?!kind\b)[a-zA-Z]+/.test(r.url)) continue;
      const url = fillWithOrgA(r.url);
      if (!url) throw new Error(`パラメータの対応がありません: ${r.url}`);
      tried++;
      const bodies = r.method === 'GET' || r.method === 'DELETE' ? [undefined] : [{}, { reason: 'x', confirm: true, version: 1, expectedVersion: 1, idempotencyKey: randomUUID() }];
      for (const body of bodies) {
        const res = await ownerB.request(r.method, url, body);
        if (res.status >= 200 && res.status < 300) succeeded.push(`${r.method} ${url} → ${res.status}`);
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
        const requested = new Set(url.split('/'));
        for (const m of aMarkers) {
          if (!requested.has(m) && text.includes(m)) leaked.push(`${r.method} ${r.url}: ${m.slice(0, 12)}`);
        }
      }
    }
    expect(tried).toBeGreaterThan(60);
    expect(succeeded).toEqual([]);
    expect(leaked).toEqual([]);
    expect(await digestOrgA()).toEqual(before);
  });

  it('他組織の一覧・検索・集計・CSV出力に組織Aのデータが含まれない', async () => {
    const leaked: string[] = [];
    for (const r of apiRoutes()) {
      if (r.method !== 'GET' || r.url.includes(':') || r.url === '/api/v1/events' || r.url === '/api/v1/backup/download') continue;
      const extra = r.url === '/api/v1/search' ? '?q=常連' : r.url === '/api/v1/availability' ? `?locationId=${orgB.locations[0].id}&serviceId=${randomUUID()}&date=2030-01-08` : '';
      const res = await ownerB.get(`${r.url}${extra}`);
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
      for (const m of aMarkers) if (text.includes(m)) leaked.push(`${r.url}: ${m.slice(0, 12)}`);
    }
    for (const kind of EXPORT_KINDS) {
      const res = await ownerB.get(`/api/v1/csv/export/${kind}?from=2020-01-01&to=2020-12-31&status=all`);
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
      for (const m of aMarkers) if (text.includes(m)) leaked.push(`csv ${kind}: ${m.slice(0, 12)}`);
    }
    const dl = await t.app.inject({ method: 'GET', url: '/api/v1/backup/download', headers: { origin: TEST_ORIGIN, cookie: ownerB.cookie! } });
    expect(dl.statusCode).toBe(200);
    const v = await (async () => {
      const f = path.join(dir, 'b.shbak');
      await import('node:fs/promises').then((fs) => fs.writeFile(f, dl.rawPayload));
      return verifyBackup(f);
    })();
    expect(v.ok).toBe(true);
    expect(v.header?.organization.id).toBe(orgB.orgId);
    expect(v.counts.customers ?? 0).toBe(0);
    expect(leaked).toEqual([]);
  });

  it('DB層(RLS): 全テナント表で他組織の行は見えず、テナント文脈なしでは何も見えない', async () => {
    const tables = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organization_id' ORDER BY table_name`,
    );
    expect(tables.rows.length).toBeGreaterThan(40);
    for (const { table_name } of tables.rows) {
      const inA = await withSystemForOrg(t.pool, ids.orgId, (q) => q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name} WHERE organization_id = $1`, [ids.orgId]));
      const seenFromB = await withTenant(t.pool, { orgId: orgB.orgId }, (q) =>
        q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name} WHERE organization_id = $1`, [ids.orgId]),
      );
      expect(seenFromB.n, `${table_name}(組織Aに ${inA.n} 行)`).toBe(0);
      const noContext = await t.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name}`);
      expect(noContext.rows[0].n, `${table_name} をテナント文脈なしで読めてしまう`).toBe(0);
    }
    const org = await withTenant(t.pool, { orgId: orgB.orgId }, (q) => q.many(`SELECT id FROM organizations`));
    expect(org).toEqual([{ id: orgB.orgId }]);
    // 他組織の行としての書き込みも拒否される
    await expect(
      withTenant(t.pool, { orgId: orgB.orgId }, (q) =>
        q.exec(`INSERT INTO customers (organization_id, name, source) VALUES ($1, '侵入', 'staff')`, [ids.orgId]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(t.pool, { orgId: orgB.orgId }, (q) => q.exec(`UPDATE customers SET name = '改ざん' WHERE organization_id = $1`, [ids.orgId])),
    ).resolves.toBe(0);
  });

  it('接続ロールは RLS を回避できない(superuser / BYPASSRLS ではない)', async () => {
    const r = await t.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('CSRF・Origin・Cookie・ヘッダー', () => {
  it('ログイン中の状態変更は CSRF トークン必須・別サイトの Origin は拒否・GET は不要', async () => {
    const owner = await login(t.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
    const noToken = await t.app.inject({ method: 'POST', url: '/api/v1/customers', payload: { name: 'x' }, headers: { origin: TEST_ORIGIN, cookie: owner.cookie! } });
    expect(noToken.statusCode).toBe(403);
    expect(JSON.parse(noToken.body).error.code).toBe('CSRF_FAILED');
    const wrongToken = await t.app.inject({ method: 'POST', url: '/api/v1/customers', payload: { name: 'x' }, headers: { origin: TEST_ORIGIN, cookie: owner.cookie!, 'x-csrf-token': 'x'.repeat(43) } });
    expect(wrongToken.statusCode).toBe(403);
    const evil = await t.app.inject({ method: 'POST', url: '/api/v1/customers', payload: { name: 'x' }, headers: { origin: 'https://evil.example', cookie: owner.cookie!, 'x-csrf-token': owner.csrf! } });
    expect(evil.statusCode).toBe(403);
    const evilReferer = await t.app.inject({ method: 'POST', url: '/api/v1/customers', payload: { name: 'x' }, headers: { referer: 'https://evil.example/page', cookie: owner.cookie!, 'x-csrf-token': owner.csrf! } });
    expect(evilReferer.statusCode).toBe(403);
    // 公開予約も別サイトからの送信は拒否(Origin 検査)
    const publicEvil = await t.app.inject({ method: 'POST', url: `/api/v1/public/orgs/${SAMPLE_SLUG}/locations/ikebukuro/bookings`, payload: {}, headers: { origin: 'https://evil.example' } });
    expect(publicEvil.statusCode).toBe(403);
    expect((await owner.get('/api/v1/customers')).status).toBe(200);
  });

  it('セッションCookie は HttpOnly・SameSite=Lax、ログインのたびに新しいIDになり、ログアウトで無効になる', async () => {
    const a = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@sample-wellness.example', password: SAMPLE_PASSWORD }, headers: { origin: TEST_ORIGIN } });
    const b = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@sample-wellness.example', password: SAMPLE_PASSWORD }, headers: { origin: TEST_ORIGIN } });
    const ca = String(a.headers['set-cookie']);
    const cb = String(b.headers['set-cookie']);
    expect(ca).toMatch(/HttpOnly/i);
    expect(ca).toMatch(/SameSite=Lax/i);
    expect(ca).toMatch(/Path=\//);
    expect(ca.split(';')[0]).not.toBe(cb.split(';')[0]);
    const s = await login(t.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
    expect((await s.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await s.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('本番(https)では Cookie に Secure が付き、HSTS を送る', async () => {
    const prod = await makeTestContext({ env: { APP_BASE_URL: 'https://app.example.com' } });
    try {
      const res = await prod.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@sample-wellness.example', password: SAMPLE_PASSWORD }, headers: { origin: 'https://app.example.com' } });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
      expect(String(res.headers['strict-transport-security'])).toMatch(/max-age=\d+/);
    } finally {
      await prod.close();
    }
  });

  it('セキュリティヘッダー: CSP(外部スクリプト・埋め込み禁止)/ nosniff / Referrer-Policy / API は no-store', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { origin: TEST_ORIGIN } });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['content-type'])).toMatch(/application\/json/);
  });
});

describe('入力・出力', () => {
  it('検索・並び順・ID に SQL の記号を入れても 500 にならず、他組織の行を返さない', async () => {
    const payloads = ["' OR 1=1 --", '%', '_', '\\', "'; DROP TABLE customers; --", '"', '0 OR 1=1', "') UNION SELECT id FROM users --", '＇', '\u0000'];
    for (const p of payloads) {
      for (const url of [
        `/api/v1/search?q=${encodeURIComponent(p)}`,
        `/api/v1/customers?q=${encodeURIComponent(p)}`,
        `/api/v1/customers?sort=${encodeURIComponent(p)}`,
        `/api/v1/bookings?code=${encodeURIComponent(p.slice(0, 20))}`,
        `/api/v1/bookings/${encodeURIComponent(p)}`,
        `/api/v1/audit?action=${encodeURIComponent(p)}`,
      ]) {
        const res = await ownerB.get(url);
        expect(res.status, `${url} → ${res.status}`).toBeLessThan(500);
        const text = JSON.stringify(res.body ?? '');
        for (const m of aMarkers) expect(text.includes(m), `${url} leaked`).toBe(false);
      }
    }
    const count = await withSystemForOrg(t.pool, ids.orgId, (q) => q.one<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE organization_id = $1', [ids.orgId]));
    expect(count.n).toBeGreaterThan(0);
  });

  it('JSON 本文は 1MB まで(超えると 413)', async () => {
    const res = await ownerB.post('/api/v1/customers', { name: 'x', memo: 'あ'.repeat(400_000) });
    expect(res.status).toBe(413);
  });

  it('スクリプトを含む入力は文字として保存・返却され、画面は HTML として解釈しない', async () => {
    const xss = `<img src=x onerror=alert(1)><script>alert('x')</script>`;
    const c = await ownerB.post('/api/v1/customers', { name: xss, memo: xss });
    expect(c.status).toBe(200);
    const got = await ownerB.get(`/api/v1/customers/${c.body.id}`);
    expect(got.body.name).toBe(xss);
    expect(String(got.headers['content-type'])).toMatch(/application\/json/);
    // 画面のコードに HTML を直接差し込む書き方がないこと(React の自動エスケープに一本化)
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(f)) files.push(p);
      }
    };
    walk(path.resolve('src/web'));
    const offenders = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|new Function\(|\beval\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('ログの個人情報', () => {
  it('リクエストログにメール・電話・氏名・パスワード・Cookie・管理トークンが出ない', async () => {
    let captured = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });
    const app = await buildApp({ ...t.deps, config: { ...t.deps.config, LOG_LEVEL: 'info' } }, { serveStatic: false, logStream: stream });
    try {
      const secretPassword = SAMPLE_PASSWORD;
      const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@sample-wellness.example', password: secretPassword }, headers: { origin: TEST_ORIGIN } });
      expect(loginRes.statusCode).toBe(200);
      const cookie = String(loginRes.headers['set-cookie']).split(';')[0];
      const csrf = JSON.parse(loginRes.body).csrfToken as string;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        payload: { name: 'ログ 確認子', email: 'log-check@example.com', phone: '090-9876-5432' },
        headers: { origin: TEST_ORIGIN, cookie, 'x-csrf-token': csrf },
      });
      expect(created.statusCode).toBe(200);
      await app.inject({ method: 'GET', url: `/api/v1/customers?q=${encodeURIComponent('090-9876-5432')}`, headers: { origin: TEST_ORIGIN, cookie } });
      await app.inject({ method: 'GET', url: '/api/v1/public/manage/THIS-IS-A-SECRET-TOKEN-123456', headers: { origin: TEST_ORIGIN } });
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@example.com', password: 'wrong-password-xyz' }, headers: { origin: TEST_ORIGIN } });
      expect(captured.length).toBeGreaterThan(100); // ログは出ている
      for (const secret of [secretPassword, 'wrong-password-xyz', 'log-check@example.com', 'nobody@example.com', '090-9876-5432', 'ログ 確認子', 'THIS-IS-A-SECRET-TOKEN-123456', cookie.split('=')[1], csrf]) {
        expect(captured.includes(secret), `ログに ${secret.slice(0, 6)}… が含まれる`).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});

describe('レート制限(公開ページ・推測攻撃)', () => {
  it('公開ページの閲覧・予約送信・予約管理リンクは IP ごとに回数制限され、429 と Retry-After を返す', async () => {
    const limited = await makeTestContext({ env: { PUBLIC_RATE_LIMIT_PER_MIN: '5' } });
    try {
      const hit = (method: 'GET' | 'POST', url: string, ip: string) =>
        limited.app.inject({ method, url, payload: method === 'POST' ? {} : undefined, headers: { origin: TEST_ORIGIN }, remoteAddress: ip });
      // 閲覧: 5 × 4 = 20 回/分
      const reads = [];
      for (let i = 0; i < 21; i++) reads.push((await hit('GET', `/api/v1/public/orgs/${SAMPLE_SLUG}`, '203.0.113.10')).statusCode);
      expect(reads.slice(0, 20).every((s) => s === 200)).toBe(true);
      const blocked = await hit('GET', `/api/v1/public/orgs/${SAMPLE_SLUG}`, '203.0.113.10');
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // 別の IP には影響しない
      expect((await hit('GET', `/api/v1/public/orgs/${SAMPLE_SLUG}`, '203.0.113.11')).statusCode).toBe(200);
      // 予約送信: 10 回/10分(本文の検査より先に数える)
      const books = [];
      for (let i = 0; i < 11; i++) books.push((await hit('POST', `/api/v1/public/orgs/${SAMPLE_SLUG}/locations/ikebukuro/bookings`, '203.0.113.20')).statusCode);
      expect(books.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(books[10]).toBe(429);
      // 予約管理リンクの総当たり: 30 回/分
      const guesses = [];
      for (let i = 0; i < 31; i++) guesses.push((await hit('GET', `/api/v1/public/manage/${'x'.repeat(40)}${i}`, '203.0.113.30')).statusCode);
      expect(guesses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(guesses[30]).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('バックアップの作成は組織ごとに1時間12回まで', async () => {
    const owner = await login(t.app, orgB.users.owner.email);
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await t.app.inject({ method: 'GET', url: '/api/v1/backup/download', headers: { origin: TEST_ORIGIN, cookie: owner.cookie! } });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(12);
    expect(codes.at(-1)).toBe(429);
  });
});
