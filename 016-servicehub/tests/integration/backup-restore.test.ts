/**
 * 組織バックアップ / 復元(Phase 9)
 * - 必須 #19 バックアップ復元後に残回数が一致(空の環境へ復元)
 * - 置換復元 / 復元テスト(dry run) / 失敗時は現行データを維持 / 改ざん・破損・別組織データの拒否 / 暗号化 / 既存ユーザーの扱い
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { hashPassword } from '../../src/server/auth/crypto.js';
import { createBackup } from '../../src/server/backup/dump.js';
import { sha256Hex } from '../../src/server/backup/format.js';
import { restoreBackup, type RestoreOptions } from '../../src/server/backup/restore.js';
import { BACKUP_TABLES, EXCLUDED_TABLES } from '../../src/server/backup/spec.js';
import { verifyBackup } from '../../src/server/backup/verify.js';
import { migrate } from '../../src/server/db/migrate.js';
import { createPool } from '../../src/server/db/pool.js';
import { withSystem, withSystemForOrg } from '../../src/server/db/tx.js';
import { FakeClock, type Deps } from '../../src/server/deps.js';
import { LogMailer } from '../../src/server/email/mailer.js';
import { SAMPLE_PASSWORD, SAMPLE_SLUG, seedSampleOrganization, type SampleIds } from '../../src/server/sample/seed.js';
import { TEST_DATABASE_URL } from './global-setup.js';
import { createOrgFixture, login, makeTestContext, type ApiSession, type TestContext } from './helpers.js';

const SECRET = 'test-session-secret-0123456789abcdefghijklmnop';
const RESTORE_DB_URL = TEST_DATABASE_URL.replace(/\/[a-z0-9_]+$/, '/servicehub_restore_test');
const OWNER = 'owner@sample-wellness.example';
const CLI_ACTOR = { type: 'operator' as const, label: 'test' };

let t: TestContext;
let ids: SampleIds;
let dir: string;
let backupFile: string;
let tiePassId: string;

async function purgeSample(pool: pg.Pool) {
  await withSystem(pool, async (q) => {
    await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
    await q.exec('DELETE FROM organizations WHERE slug = $1', [SAMPLE_SLUG]);
  });
}

/** 空のDBを作り直して移行を適用(空のテスト環境) */
async function freshDatabase(): Promise<pg.Pool> {
  const admin = new URL(RESTORE_DB_URL);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const pool = createPool({ connectionString: RESTORE_DB_URL, max: 6, statementTimeoutMs: 0 });
  await migrate(pool);
  return pool;
}

async function makeApp(pool: pg.Pool, clock: FakeClock): Promise<FastifyInstance> {
  const deps: Deps = { ...t.deps, pool, clock, mailer: new LogMailer(false) };
  return buildApp(deps, { serveStatic: false, logger: false });
}

async function backup(file: string, opts: { encryptionKey?: string } = {}) {
  return createBackup(t.pool, ids.orgId, createWriteStream(file), { sessionSecret: SECRET, now: t.clock.now(), ...opts });
}

function restoreOpts(extra: Partial<RestoreOptions> = {}): RestoreOptions {
  return { mode: 'new', actor: CLI_ACTOR, existingUserPolicy: 'link', sessionSecret: SECRET, ...extra };
}

/** バックアップの行を加工し、ハッシュを計算し直して保存する(悪意のあるファイル・壊れた台帳の再現) */
async function craft(src: string, dst: string, mutate: (table: string, columns: string[], rows: (string | null)[][]) => void): Promise<void> {
  const lines = gunzipSync(await readFile(src)).toString('utf8').split('\n').filter(Boolean);
  const header = lines[0];
  const out: string[] = [header];
  let i = 1;
  const counts: Record<string, number> = {};
  while (i < lines.length) {
    const obj = JSON.parse(lines[i]);
    if (obj.type === 'footer') break;
    const start = obj;
    i++;
    const rows: (string | null)[][] = [];
    while (!lines[i].startsWith('{')) rows.push(JSON.parse(lines[i++]));
    i++; // end
    mutate(start.name, start.columns, rows);
    const rowLines = rows.map((r) => JSON.stringify(r));
    out.push(JSON.stringify(start), ...rowLines);
    out.push(JSON.stringify({ type: 'end', name: start.name, count: rows.length, sha256: sha256Hex(rowLines.map((l) => l + '\n').join('')) }));
    counts[start.name] = rows.length;
  }
  const body = out.map((l) => l + '\n').join('');
  const footer = { type: 'footer', counts, lines: out.length, sha256: sha256Hex(body) };
  await writeFile(dst, gzipSync(body + JSON.stringify(footer) + '\n'));
}

async function orgCounts(pool: pg.Pool, orgId: string) {
  return withSystemForOrg(pool, orgId, (q) =>
    q.one<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM bookings WHERE organization_id = $1) AS bookings,
              (SELECT count(*)::int FROM customers WHERE organization_id = $1) AS customers,
              (SELECT count(*)::int FROM pass_ledger_entries WHERE organization_id = $1) AS pass_entries,
              (SELECT coalesce(sum(remaining), 0)::int FROM customer_passes WHERE organization_id = $1) AS pass_remaining,
              (SELECT count(*)::int FROM audit_logs WHERE organization_id = $1) AS audit`,
      [orgId],
    ),
  );
}

async function passBalances(pool: pg.Pool, orgId: string) {
  return withSystemForOrg(pool, orgId, (q) =>
    q.many<{ id: string; remaining: number; ledger_sum: number; entries: string }>(
      `SELECT p.id, p.remaining, coalesce(sum(l.delta), 0)::int AS ledger_sum,
              string_agg(l.entry_type || ':' || l.delta || ':' || l.balance_after, ',' ORDER BY l.created_at, l.id) AS entries
         FROM customer_passes p LEFT JOIN pass_ledger_entries l ON l.customer_pass_id = p.id
        WHERE p.organization_id = $1 GROUP BY p.id ORDER BY p.id`,
      [orgId],
    ),
  );
}

async function periodBalances(pool: pg.Pool, orgId: string) {
  return withSystemForOrg(pool, orgId, (q) =>
    q.many<{ id: string; remaining: number; ledger_sum: number }>(
      `SELECT pp.id, pp.remaining, coalesce(sum(l.delta), 0)::int AS ledger_sum
         FROM customer_plan_periods pp LEFT JOIN plan_ledger_entries l ON l.customer_plan_period_id = pp.id
        WHERE pp.organization_id = $1 GROUP BY pp.id ORDER BY pp.id`,
      [orgId],
    ),
  );
}

beforeAll(async () => {
  t = await makeTestContext();
  dir = await mkdtemp(path.join(os.tmpdir(), 'servicehub-backup-test-'));
  await purgeSample(t.pool);
  ids = await seedSampleOrganization(t.pool, { appBaseUrl: 'http://localhost:3000', sessionSecret: SECRET, now: t.clock.now() });
  const owner = await login(t.app, OWNER, SAMPLE_PASSWORD);

  // 自己参照・循環参照を含む状態を作る
  // (1) 顧客統合: merged_into_id(自己参照)と統合履歴
  const newbie = await owner.post(`/api/v1/customers/${ids.customers.repeater}/merge`, { mergeFromId: ids.customers.newbie, confirm: true, reason: 'テスト' });
  expect(newbie.status).toBe(200);
  // (2) 回数券の消化取消(use_reversal → reverses_entry_id の自己参照)
  const consumed = await withSystemForOrg(t.pool, ids.orgId, (q) =>
    q.one<{ id: string }>(
      `SELECT booking_id AS id FROM pass_ledger_entries WHERE organization_id = $1 AND entry_type = 'use' AND booking_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [ids.orgId],
    ),
  );
  const rev = await owner.post(`/api/v1/bookings/${consumed.id}/consumption/reverse`, { reason: '誤操作の取消' });
  expect(rev.status).toBe(200);
  // (3) 次回予約の元予約(bookings の自己参照)と、待機 ⇔ 予約 の循環参照
  await withSystemForOrg(t.pool, ids.orgId, async (q) => {
    const b = await q.many<{ id: string }>(`SELECT id FROM bookings WHERE organization_id = $1 ORDER BY starts_at LIMIT 2`, [ids.orgId]);
    await q.exec(`UPDATE bookings SET previous_booking_id = $2 WHERE id = $1`, [b[1].id, b[0].id]);
    const w = await q.one<{ id: string }>(`SELECT id FROM waitlist_entries WHERE organization_id = $1 LIMIT 1`, [ids.orgId]);
    await q.exec(`UPDATE waitlist_entries SET status = 'booked', booked_booking_id = $2 WHERE id = $1`, [w.id, b[1].id]);
    await q.exec(`UPDATE bookings SET waitlist_entry_id = $2 WHERE id = $1`, [b[1].id, w.id]);
  });
  // (4) 同じトランザクション(同じ作成日時)の台帳。ID順に並べると残数のつながりが崩れる並びにする
  tiePassId = randomUUID();
  await withSystemForOrg(t.pool, ids.orgId, async (q) => {
    const product = await q.one<{ id: string }>(`SELECT id FROM pass_products WHERE organization_id = $1 LIMIT 1`, [ids.orgId]);
    await q.exec(
      `INSERT INTO customer_passes (id, organization_id, customer_id, pass_product_id, product_snapshot, starts_on, initial_uses)
       VALUES ($1, $2, $3, $4, '{"name":"8回券"}', '2030-01-01', 8)`,
      [tiePassId, ids.orgId, ids.customers.planMember, product.id],
    );
    const ins = (id: string, type: string, delta: number, reverses: string | null) =>
      q.exec(
        `INSERT INTO pass_ledger_entries (id, organization_id, customer_pass_id, entry_type, delta, reverses_entry_id, reason, actor_type, actor_label, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'テスト', 'system', 'test', $7)`,
        [id, ids.orgId, tiePassId, type, delta, reverses, `tie:${id}`],
      );
    const use1 = '00000000-0000-7000-8000-000000000001';
    await ins('ffffffff-ffff-7fff-bfff-ffffffffffff', 'grant', 8, null);
    await ins(use1, 'use', -1, null);
    await ins('00000000-0000-7000-8000-000000000000', 'use_reversal', 1, use1);
    await ins('00000000-0000-7000-8000-000000000002', 'use', -1, null);
  });

  backupFile = path.join(dir, 'sample.shbak');
  await backup(backupFile);
});

afterAll(async () => {
  await purgeSample(t.pool);
  await t.close();
  await rm(dir, { recursive: true, force: true });
});

describe('バックアップの対象', () => {
  it('全ての表がバックアップ対象か除外理由付きで、外部キーの親が子より先に復元される', async () => {
    const tables = await t.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const covered = new Set([...BACKUP_TABLES.map((s) => s.name), ...Object.keys(EXCLUDED_TABLES)]);
    for (const r of tables.rows) expect(covered.has(r.relname), `表 ${r.relname} がバックアップ対象にも除外にもない`).toBe(true);
    const order = new Map(BACKUP_TABLES.map((s, i) => [s.name, i]));
    const fks = await t.pool.query<{ child: string; parent: string; cols: string[] }>(
      `SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
              array(SELECT a.attname::text FROM unnest(con.conkey) k(n) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols
         FROM pg_constraint con WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`,
    );
    for (const fk of fks.rows) {
      if (!order.has(fk.child) || !order.has(fk.parent)) continue;
      const spec = BACKUP_TABLES[order.get(fk.child)!];
      const col = fk.cols.find((c) => c !== 'organization_id');
      if (col && spec.deferred?.includes(col)) continue;
      if (fk.child === fk.parent && spec.ledger && col === 'reverses_entry_id') continue; // 台帳は元の順序で再生
      expect(order.get(fk.parent)!, `${fk.child}.${col} → ${fk.parent}`).toBeLessThan(order.get(fk.child)!);
    }
  });
});

describe('#19 空の環境へ復元', () => {
  let pool2: pg.Pool;
  let app2: FastifyInstance;

  afterAll(async () => {
    await app2?.close();
    await pool2?.end();
  });

  it('検証 → 空のDBへ復元すると、全表の件数・内容と回数券/利用プランの残数が一致する', async () => {
    const v = await verifyBackup(backupFile, { pool: t.pool, sessionSecret: SECRET });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.header!.organization.slug).toBe(SAMPLE_SLUG);
    expect(v.header!.schemaVersion).toMatch(/^\d{4}$/);
    expect(v.header!.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.counts.bookings).toBeGreaterThan(20);

    pool2 = await freshDatabase();
    const report = await restoreBackup(pool2, backupFile, restoreOpts());
    expect(report.dryRun).toBe(false);
    for (const tbl of report.tables) {
      expect(tbl.restored, tbl.name).toBe(tbl.expected);
      if (tbl.expected > 0) expect(tbl.digest, tbl.name).toBe('match');
    }
    expect(report.users).toMatchObject({ created: 5, linked: 0, membershipsDisabled: 0 });

    // 残回数: 回数券ごとに remaining・台帳合計・各エントリの balance_after まで一致(#19)
    const before = await passBalances(t.pool, ids.orgId);
    const after = await passBalances(pool2, ids.orgId);
    expect(after).toEqual(before);
    for (const p of after) expect(p.remaining).toBe(p.ledger_sum);
    const tie = after.find((p) => p.id === tiePassId)!;
    expect(tie.remaining).toBe(7);
    expect(await periodBalances(pool2, ids.orgId)).toEqual(await periodBalances(t.pool, ids.orgId));
    expect(report.ledger.passes).toBe(before.length);

    // 監査: 元の監査ログは全て残り、復元の記録が1件増える
    const audit = async (p: pg.Pool) =>
      withSystemForOrg(p, ids.orgId, (q) => q.many<{ id: string; action: string }>(`SELECT id, action FROM audit_logs WHERE organization_id = $1 ORDER BY created_at, id`, [ids.orgId]));
    const srcAudit = await audit(t.pool);
    const dstAudit = await audit(pool2);
    expect(dstAudit.slice(0, srcAudit.length)).toEqual(srcAudit);
    expect(dstAudit.slice(srcAudit.length).map((a) => a.action)).toEqual(['backup.restored']);

    // 未送信だった通知は送らない
    const pending = await withSystemForOrg(pool2, ids.orgId, (q) =>
      q.one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND status IN ('pending', 'sending')`, [ids.orgId]),
    );
    expect(pending.n).toBe(0);
  });

  it('復元した環境にバックアップ時のパスワードでログインでき、画面(API)で同じ内容が見える', async () => {
    const clock2 = new FakeClock(t.clock.now().toISOString());
    app2 = await makeApp(pool2, clock2);
    const src = await login(t.app, OWNER, SAMPLE_PASSWORD);
    const dst = await login(app2, OWNER, SAMPLE_PASSWORD);
    const same = async (url: string) => {
      const a = await src.get(url);
      const b = await dst.get(url);
      expect(a.status, url).toBe(200);
      expect(b.status, url).toBe(200);
      expect(b.body, url).toEqual(a.body);
      return a.body;
    };
    await same('/api/v1/org');
    await same('/api/v1/locations');
    await same('/api/v1/staff');
    await same('/api/v1/services');
    await same('/api/v1/resources');
    await same('/api/v1/members');
    await same('/api/v1/customers?status=all&sort=created&limit=200');
    const from = new Date(t.clock.now().getTime() - 80 * 86400_000).toISOString();
    const to = new Date(t.clock.now().getTime() + 30 * 86400_000).toISOString();
    await same(`/api/v1/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`);
    const passes = await same('/api/v1/passes?status=all');
    expect(passes.items.length).toBeGreaterThanOrEqual(3);
    for (const p of passes.items) await same(`/api/v1/passes/${p.id}`);
    const plans = await same('/api/v1/plans?status=all');
    expect(plans.items.length).toBeGreaterThanOrEqual(1);
    for (const p of plans.items) await same(`/api/v1/plans/${p.id}`);
    await same('/api/v1/records?limit=500');
    await same('/api/v1/waitlist?status=all');
    await same(`/api/v1/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const srcAudit = await src.get('/api/v1/audit?limit=200');
    const dstAudit = await dst.get('/api/v1/audit?limit=200');
    const withoutRestore = dstAudit.body.items.filter((i: { action: string }) => i.action !== 'backup.restored');
    expect(withoutRestore).toEqual(srcAudit.body.items);
  });
});

describe('置換復元', () => {
  it('復元テスト(dry run)は照合まで行って何も変更しない', async () => {
    const before = await orgCounts(t.pool, ids.orgId);
    const owner = await login(t.app, OWNER, SAMPLE_PASSWORD);
    const report = await restoreBackup(t.pool, backupFile, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId, dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.replaced?.slug).toBe(SAMPLE_SLUG);
    expect(await orgCounts(t.pool, ids.orgId)).toEqual(before);
    expect((await owner.get('/api/v1/org')).status).toBe(200); // セッションも残る
  });

  it('バックアップ後の変更が元に戻り、全員が再ログインになる', async () => {
    const before = await orgCounts(t.pool, ids.orgId);
    const balances = await passBalances(t.pool, ids.orgId);
    const owner = await login(t.app, OWNER, SAMPLE_PASSWORD);
    // バックアップ後の変更: 回数券を手動で減らし、顧客を追加
    const pass = balances.find((p) => p.remaining > 1)!;
    const adj = await owner.post(`/api/v1/passes/${pass.id}/adjust`, { type: 'manual_subtract', delta: -1, reason: '復元テスト', idempotencyKey: randomUUID() });
    expect(adj.status).toBe(200);
    const c = await owner.post('/api/v1/customers', { name: '復元で消える顧客', phone: '090-0000-1111' });
    expect(c.status).toBe(200);

    const report = await restoreBackup(t.pool, backupFile, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId, existingUserPolicy: 'restrict', requireOwnerUserId: null }));
    expect(report.users.membershipsDisabled).toBe(0);
    const after = await orgCounts(t.pool, ids.orgId);
    expect({ ...after, audit: after.audit - 1 }).toEqual(before);
    expect(await passBalances(t.pool, ids.orgId)).toEqual(balances);
    expect((await owner.get('/api/v1/org')).status).toBe(401);
    const again = await login(t.app, OWNER, SAMPLE_PASSWORD);
    expect((await again.get(`/api/v1/customers/${c.body.id}`)).status).toBe(404);
  });

  it('途中で失敗した復元は全て巻き戻され、現行データとセッションが維持される', async () => {
    const broken = path.join(dir, 'broken-ledger.shbak');
    // 台帳の balance_after を改ざん(ハッシュは計算し直す)→ 再計算結果の照合で失敗する
    await craft(backupFile, broken, (table, columns, rows) => {
      if (table !== 'pass_ledger_entries') return;
      const i = columns.indexOf('balance_after');
      rows[rows.length - 1][i] = String(Number(rows[rows.length - 1][i]) + 5);
    });
    const v = await verifyBackup(broken, { pool: t.pool });
    expect(v.ok).toBe(true); // 形式としては正しい
    const before = await orgCounts(t.pool, ids.orgId);
    const balances = await passBalances(t.pool, ids.orgId);
    const owner = await login(t.app, OWNER, SAMPLE_PASSWORD);
    await expect(restoreBackup(t.pool, broken, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId }))).rejects.toThrow(/台帳/);
    expect(await orgCounts(t.pool, ids.orgId)).toEqual(before);
    expect(await passBalances(t.pool, ids.orgId)).toEqual(balances);
    expect((await owner.get('/api/v1/org')).status).toBe(200);
  });

  it('画面からの復元: 操作者がバックアップ内の有効なオーナーでなければ拒否する(締め出し防止)', async () => {
    const before = await orgCounts(t.pool, ids.orgId);
    const reception = await withSystem(t.pool, (q) => q.one<{ id: string }>(`SELECT id FROM users WHERE email = 'reception@sample-wellness.example'`));
    await expect(
      restoreBackup(t.pool, backupFile, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId, requireOwnerUserId: reception.id, existingUserPolicy: 'restrict' })),
    ).rejects.toThrow(/オーナー権限/);
    expect(await orgCounts(t.pool, ids.orgId)).toEqual(before);
  });

  it('この組織のメンバーでなかった既存ユーザーを含むファイルは、その権限を無効で復元する', async () => {
    const other = await createOrgFixture(t.pool);
    const otherUser = await withSystem(t.pool, (q) => q.one<Record<string, string | null>>(`SELECT * FROM users WHERE id = $1`, [other.users.owner.userId]));
    const crafted = path.join(dir, 'foreign-user.shbak');
    await craft(backupFile, crafted, (table, columns, rows) => {
      if (table === 'users') {
        rows.push(columns.map((c) => (otherUser[c] == null ? null : c.endsWith('_at') ? new Date(otherUser[c] as string).toISOString() : String(otherUser[c]))));
      }
      if (table === 'memberships') {
        const row = [...rows[0]];
        row[columns.indexOf('id')] = randomUUID();
        row[columns.indexOf('user_id')] = other.users.owner.userId;
        row[columns.indexOf('role')] = 'owner';
        row[columns.indexOf('status')] = 'active';
        row[columns.indexOf('staff_id')] = null;
        rows.push(row);
      }
    });
    const report = await restoreBackup(t.pool, crafted, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId, existingUserPolicy: 'restrict' }));
    expect(report.users.membershipsDisabled).toBe(1);
    expect(report.warnings.join()).toMatch(/無効/);
    const m = await withSystemForOrg(t.pool, ids.orgId, (q) =>
      q.one<{ status: string }>(`SELECT status FROM memberships WHERE organization_id = $1 AND user_id = $2`, [ids.orgId, other.users.owner.userId]),
    );
    expect(m.status).toBe('disabled');
    // 元に戻す
    await restoreBackup(t.pool, backupFile, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId }));
  });
});

describe('検証で拒否されるファイル', () => {
  it('破損・途中切れ・改ざん(ハッシュ不一致)を検出する', async () => {
    const raw = await readFile(backupFile);
    const truncated = path.join(dir, 'truncated.shbak');
    await writeFile(truncated, raw.subarray(0, Math.floor(raw.length / 2)));
    const r1 = await verifyBackup(truncated);
    expect(r1.ok).toBe(false);

    const flipped = path.join(dir, 'flipped.shbak');
    const copy = Buffer.from(raw);
    copy[Math.floor(copy.length / 2)] ^= 0xff;
    await writeFile(flipped, copy);
    const r2 = await verifyBackup(flipped);
    expect(r2.ok).toBe(false);

    const tampered = path.join(dir, 'tampered.shbak');
    const text = gunzipSync(raw).toString('utf8').replace('Sample Wellness', 'Tampered Name');
    await writeFile(tampered, gzipSync(text));
    const r3 = await verifyBackup(tampered);
    expect(r3.ok).toBe(false);
    expect(r3.errors.join()).toMatch(/ハッシュ|改ざん/);

    const notBackup = path.join(dir, 'not-backup.shbak');
    await writeFile(notBackup, 'name,phone\n山田,090\n');
    const r4 = await verifyBackup(notBackup);
    expect(r4.ok).toBe(false);
    expect(r4.errors.join()).toMatch(/バックアップファイルではありません/);
  });

  it('別の組織の行を含むファイルは拒否し、復元しない(テナント分離)', async () => {
    const other = await createOrgFixture(t.pool);
    const crafted = path.join(dir, 'cross-tenant.shbak');
    await craft(backupFile, crafted, (table, columns, rows) => {
      if (table === 'customers') rows[0][columns.indexOf('organization_id')] = other.orgId;
    });
    const v = await verifyBackup(crafted);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/別の組織/);
    await expect(restoreBackup(t.pool, crafted, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId }))).rejects.toThrow(/別の組織/);
    const n = await withSystemForOrg(t.pool, other.orgId, (q) => q.one<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE organization_id = $1`, [other.orgId]));
    expect(n.n).toBe(0);
  });
});

describe('暗号化', () => {
  it('キーなし・誤ったキーでは読めず、同じキーで検証・復元できる', async () => {
    const key = 'correct-backup-passphrase-2030';
    const file = path.join(dir, 'encrypted.shbak');
    const r = await backup(file, { encryptionKey: key });
    expect(r.encrypted).toBe(true);
    const head = (await readFile(file)).subarray(0, 8).toString('ascii');
    expect(head).toBe('SHBKENC1');
    expect((await readFile(file)).includes(Buffer.from('Sample Wellness'))).toBe(false);

    const noKey = await verifyBackup(file);
    expect(noKey.ok).toBe(false);
    expect(noKey.errors.join()).toMatch(/暗号化/);
    const wrong = await verifyBackup(file, { encryptionKey: 'wrong-backup-passphrase-000' });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors.join()).toMatch(/復号できません/);
    const ok = await verifyBackup(file, { encryptionKey: key });
    expect(ok.ok).toBe(true);
    expect(ok.sha256).toBe(r.sha256);
    const report = await restoreBackup(t.pool, file, restoreOpts({ mode: 'replace', replaceOrgId: ids.orgId, encryptionKey: key, dryRun: true }));
    expect(report.tables.every((x) => x.restored === x.expected)).toBe(true);
  });

  it('SESSION_SECRET が作成元と異なる環境では警告する(予約管理リンクが変わるため)', async () => {
    const v = await verifyBackup(backupFile, { sessionSecret: 'another-secret-0123456789abcdefghijklmnop' });
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/SESSION_SECRET/);
  });
});

describe('既存のログインユーザー', () => {
  it('同じメールの既存ユーザーは上書きせずに紐付け、既存のパスワードでオーナーとしてログインできる', async () => {
    const pool3 = await freshDatabase();
    try {
      const existingId = randomUUID();
      await withSystem(pool3, async (q) => {
        await q.exec(
          `INSERT INTO users (id, email, email_normalized, password_hash, display_name) VALUES ($1, $2, $2, $3, '既存ユーザー')`,
          [existingId, OWNER, await hashPassword('existing-password-123')],
        );
      });
      const report = await restoreBackup(pool3, backupFile, restoreOpts());
      expect(report.users.linked).toBe(1);
      expect(report.tables.find((x) => x.name === 'users')!.digest).toBe('skipped');
      const m = await withSystemForOrg(pool3, ids.orgId, (q) =>
        q.one<{ role: string; status: string }>(`SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2`, [ids.orgId, existingId]),
      );
      expect(m).toEqual({ role: 'owner', status: 'active' });
      const app3 = await makeApp(pool3, new FakeClock(t.clock.now().toISOString()));
      try {
        await expect(login(app3, OWNER, SAMPLE_PASSWORD)).rejects.toThrow();
        const s: ApiSession = await login(app3, OWNER, 'existing-password-123');
        expect((await s.get('/api/v1/org')).body.slug).toBe(SAMPLE_SLUG);
      } finally {
        await app3.close();
      }
      // 同じ組織が既にある環境へ new で復元すると拒否
      await expect(restoreBackup(pool3, backupFile, restoreOpts())).rejects.toThrow(/既に存在/);
    } finally {
      await pool3.end();
    }
  });
});
