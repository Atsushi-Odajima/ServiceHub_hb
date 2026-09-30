/**
 * 設定 > バックアップ の API(Owner のみ)
 * ダウンロード → 検証 → 復元テスト → 復元 / 確認入力・直近バックアップの必須化 / 別組織のファイル / 上限
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withSystemForOrg } from '../../src/server/db/tx.js';
import { SAMPLE_PASSWORD, SAMPLE_SLUG, seedSampleOrganization, type SampleIds } from '../../src/server/sample/seed.js';
import { createOrgFixture, login, makeTestContext, TEST_ORIGIN, type ApiSession, type TestContext } from './helpers.js';

const SECRET = 'test-session-secret-0123456789abcdefghijklmnop';
let t: TestContext;
let ids: SampleIds;
let owner: ApiSession;
let file: Buffer;

async function purgeSample() {
  await withSystem(t.pool, async (q) => {
    await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
    await q.exec('DELETE FROM organizations WHERE slug = $1', [SAMPLE_SLUG]);
  });
}

async function download(s: ApiSession) {
  const res = await t.app.inject({ method: 'GET', url: '/api/v1/backup/download', headers: { origin: TEST_ORIGIN, cookie: s.cookie! } });
  return res;
}

function upload(s: ApiSession, url: string, body: Buffer) {
  return s.request('POST', url, body, { 'content-type': 'application/octet-stream' });
}

async function bookingCount(orgId: string) {
  return withSystemForOrg(t.pool, orgId, (q) => q.one<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1', [orgId]));
}

beforeAll(async () => {
  t = await makeTestContext();
  await purgeSample();
  ids = await seedSampleOrganization(t.pool, { appBaseUrl: TEST_ORIGIN, sessionSecret: SECRET, now: t.clock.now() });
  owner = await login(t.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
});

afterAll(async () => {
  await purgeSample();
  await t.close();
});

describe('バックアップ API', () => {
  it('Owner 以外は状態の確認・作成・検証・復元のすべてを拒否される', async () => {
    for (const email of ['manager@sample-wellness.example', 'reception@sample-wellness.example', 'aki@sample-wellness.example']) {
      const s = await login(t.app, email, SAMPLE_PASSWORD);
      expect((await s.get('/api/v1/backup/status')).status).toBe(403);
      expect((await download(s)).statusCode).toBe(403);
      expect((await upload(s, '/api/v1/backup/verify', Buffer.from('x'))).status).toBe(403);
      expect((await upload(s, `/api/v1/backup/restore?confirm=${SAMPLE_SLUG}`, Buffer.from('x'))).status).toBe(403);
    }
  });

  it('作成したバックアップをダウンロードでき、作成の記録が残る', async () => {
    const before = await owner.get('/api/v1/backup/status');
    expect(before.status).toBe(200);
    expect(before.body.hasRecentBackup).toBe(false);
    expect(before.body.excluded.map((e: { name: string }) => e.name)).toContain('auth_sessions');
    const res = await download(owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.headers['content-disposition'])).toMatch(/servicehub-backup_sample-wellness_\d{8}-\d{4}\.shbak/);
    expect(res.headers['cache-control']).toBe('no-store');
    file = res.rawPayload;
    expect(file[0]).toBe(0x1f);
    expect(file[1]).toBe(0x8b);
    const after = await owner.get('/api/v1/backup/status');
    expect(after.body.hasRecentBackup).toBe(true);
    expect(after.body.history[0]).toMatchObject({ action: 'backup.created', via: 'web', encrypted: false });
    const audit = await owner.get('/api/v1/audit?action=backup.created');
    expect(audit.body.items.length).toBe(1);
  });

  it('検証は内容を読んで結果を返し、DBは変更しない', async () => {
    const r = await upload(owner, '/api/v1/backup/verify', file);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sameOrganization).toBe(true);
    expect(r.body.backup.organization.slug).toBe(SAMPLE_SLUG);
    expect(r.body.counts.find((c: { name: string }) => c.name === 'bookings').count).toBeGreaterThan(20);

    const broken = Buffer.from(file);
    broken[broken.length - 10] ^= 0xff;
    const bad = await upload(owner, '/api/v1/backup/verify', broken);
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors.length).toBeGreaterThan(0);

    const json = await owner.post('/api/v1/backup/verify', { hello: 'world' });
    expect(json.status).toBe(400);
  });

  it('確認入力が違うと復元しない / 復元テストは変更せずに記録だけ残る', async () => {
    const wrong = await upload(owner, '/api/v1/backup/restore?confirm=other-org', file);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields.confirm).toContain(SAMPLE_SLUG);
    const n = await bookingCount(ids.orgId);
    const dry = await upload(owner, `/api/v1/backup/restore?confirm=${SAMPLE_SLUG}&dryRun=true`, file);
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.reloginRequired).toBe(false);
    expect(dry.body.tables.every((x: { restored: number; expected: number }) => x.restored === x.expected)).toBe(true);
    expect((await bookingCount(ids.orgId)).n).toBe(n.n);
    expect((await owner.get('/api/v1/org')).status).toBe(200);
    const audit = await owner.get('/api/v1/audit?action=backup.restore_tested');
    expect(audit.body.items.length).toBe(1);
  });

  it('復元するとバックアップ時点に戻り、全員が再ログインになる', async () => {
    const n = await bookingCount(ids.orgId);
    // バックアップ後に予約を1件キャンセル → 復元で元に戻る
    const b = await withSystemForOrg(t.pool, ids.orgId, (q) =>
      q.one<{ id: string; version: number }>(`SELECT id, version FROM bookings WHERE organization_id = $1 AND status = 'confirmed' ORDER BY starts_at DESC LIMIT 1`, [ids.orgId]),
    );
    const cancel = await owner.post(`/api/v1/bookings/${b.id}/cancel`, { reason: '復元テスト', by: 'business', expectedVersion: b.version });
    expect(cancel.status).toBe(200);
    expect((await owner.get(`/api/v1/bookings/${b.id}`)).body.status).toBe('canceled_business');
    const res = await upload(owner, `/api/v1/backup/restore?confirm=${SAMPLE_SLUG}`, file);
    expect(res.status).toBe(200);
    expect(res.body.reloginRequired).toBe(true);
    expect((await owner.get('/api/v1/org')).status).toBe(401);
    owner = await login(t.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
    const after = await owner.get(`/api/v1/bookings/${b.id}`);
    expect(after.body.status).toBe('confirmed');
    expect((await bookingCount(ids.orgId)).n).toBe(n.n);
    const audit = await owner.get('/api/v1/audit?action=backup.restored');
    expect(audit.body.items.length).toBe(1);
  });

  it('現在のデータのバックアップが直近にない組織では復元を拒否する', async () => {
    const other = await createOrgFixture(t.pool);
    const s = await login(t.app, other.users.owner.email);
    const r = await upload(s, `/api/v1/backup/restore?confirm=${other.slug}&allowOtherOrg=true`, file);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/現在のデータのバックアップ/);
  });

  it('別の組織のバックアップは明示の確認が必要で、その組織が同じ環境に存在すれば置き換えない', async () => {
    const other = await createOrgFixture(t.pool);
    const s = await login(t.app, other.users.owner.email);
    expect((await download(s)).statusCode).toBe(200); // 直近のバックアップ
    const v = await upload(s, '/api/v1/backup/verify', file);
    expect(v.body.ok).toBe(true);
    expect(v.body.sameOrganization).toBe(false);
    const noFlag = await upload(s, `/api/v1/backup/restore?confirm=${other.slug}`, file);
    expect(noFlag.status).toBe(409);
    expect(noFlag.body.error.message).toMatch(/別の組織/);
    const flagged = await upload(s, `/api/v1/backup/restore?confirm=${other.slug}&allowOtherOrg=true`, file);
    expect(flagged.status).toBe(409);
    expect(flagged.body.error.message).toMatch(/既に存在/);
    // 置き換えは行われていない
    const org = await withSystem(t.pool, (q) => q.maybeOne('SELECT id FROM organizations WHERE id = $1', [other.orgId]));
    expect(org).not.toBeNull();
    expect((await s.get('/api/v1/org')).status).toBe(200);
  });

  it('上限を超えるファイルは受け付けない', async () => {
    const small = await makeTestContext({ env: { BACKUP_UPLOAD_MAX_MB: '1' } });
    try {
      const s = await login(small.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
      const big = Buffer.alloc(1024 * 1024 + 10, 1);
      const r = await s.request('POST', '/api/v1/backup/verify', big, { 'content-type': 'application/octet-stream' });
      expect(r.status).toBe(413);
    } finally {
      await small.close();
    }
  });
});
