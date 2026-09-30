/**
 * RBAC の網羅テスト(RBAC.md「6. テスト」)
 * 1. ロール → 権限の対応表がコードと設計資料(RBAC.md の権限マトリクス)で一致する
 * 2. 全ロール × 代表API の許可/拒否表(サンプル組織: Owner / 池袋 Manager / 池袋 Reception / Staff Aki)
 *    ok=成功, auth=権限・拠点の確認は通過(本文が空のため 400 等), deny=403, hidden=404(担当外の拠点・予約・顧客)
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from '../../src/shared/permissions.js';
import { withSystem, withSystemForOrg } from '../../src/server/db/tx.js';
import { SAMPLE_PASSWORD, SAMPLE_SLUG, seedSampleOrganization, type SampleIds } from '../../src/server/sample/seed.js';
import { login, makeTestContext, TEST_ORIGIN, type ApiSession, type TestContext } from './helpers.js';

type Expect = 'ok' | 'auth' | 'deny' | 'hidden';
type Who = 'owner' | 'manager' | 'reception' | 'staff';

let t: TestContext;
let ids: SampleIds;
const s = {} as Record<Who, ApiSession>;
const ref = {} as Record<string, string>;

async function purgeSample() {
  await withSystem(t.pool, async (q) => {
    await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
    await q.exec('DELETE FROM organizations WHERE slug = $1', [SAMPLE_SLUG]);
  });
}

beforeAll(async () => {
  t = await makeTestContext();
  await purgeSample();
  ids = await seedSampleOrganization(t.pool, { appBaseUrl: TEST_ORIGIN, sessionSecret: 'test-session-secret-0123456789abcdefghijklmnop', now: t.clock.now() });
  s.owner = await login(t.app, 'owner@sample-wellness.example', SAMPLE_PASSWORD);
  s.manager = await login(t.app, 'manager@sample-wellness.example', SAMPLE_PASSWORD);
  s.reception = await login(t.app, 'reception@sample-wellness.example', SAMPLE_PASSWORD);
  s.staff = await login(t.app, 'aki@sample-wellness.example', SAMPLE_PASSWORD);
  await withSystemForOrg(t.pool, ids.orgId, async (q) => {
    const one = async (key: string, sql: string, params: unknown[] = []) => {
      const r = await q.maybeOne<{ id: string }>(sql, [ids.orgId, ...params]);
      if (!r) throw new Error(`fixture not found: ${key}`);
      ref[key] = r.id;
    };
    await one('bookingIkeAki', `SELECT id FROM bookings WHERE organization_id = $1 AND location_id = $2 AND staff_id = $3 ORDER BY starts_at DESC LIMIT 1`, [ids.locations.ikebukuro, ids.staff.aki]);
    await one('bookingIkeOther', `SELECT id FROM bookings WHERE organization_id = $1 AND location_id = $2 AND staff_id <> $3 ORDER BY starts_at DESC LIMIT 1`, [ids.locations.ikebukuro, ids.staff.aki]);
    await one('bookingShinKen', `SELECT id FROM bookings WHERE organization_id = $1 AND location_id = $2 AND staff_id = $3 ORDER BY starts_at DESC LIMIT 1`, [ids.locations.shinjuku, ids.staff.ken]);
    await one('recordIke', `SELECT id FROM service_records WHERE organization_id = $1 AND location_id = $2 ORDER BY performed_at DESC LIMIT 1`, [ids.locations.ikebukuro]);
    await one('pass', `SELECT id FROM customer_passes WHERE organization_id = $1 AND customer_id = $2`, [ids.customers.lastOne]);
    await one('plan', `SELECT id FROM customer_plans WHERE organization_id = $1 LIMIT 1`);
    await one('notificationIke', `SELECT id FROM notifications WHERE organization_id = $1 AND location_id = $2 LIMIT 1`, [ids.locations.ikebukuro]);
  });
});

afterAll(async () => {
  await purgeSample();
  await t.close();
});

describe('ロールと権限の対応表', () => {
  const EXPECTED: Record<Role, Permission[]> = {
    owner: [...PERMISSIONS],
    manager: [
      'location.schedule.manage', 'resource.manage', 'staff.contact.read', 'shift.manage', 'shift.read.all', 'shift.read.own',
      'booking.read.all', 'booking.create.all', 'booking.update.all', 'booking.cancel.all', 'booking.status.all', 'booking.force', 'booking.restore', 'booking.internal_note',
      'reception.operate', 'customer.read', 'customer.create', 'customer.update', 'customer.note.general', 'customer.note.confidential', 'customer.merge', 'customer.archive', 'customer.export',
      'record.read', 'record.write.all', 'record.void', 'pass.read', 'pass.grant', 'pass.consume', 'pass.reverse', 'pass.adjust',
      'plan.read', 'plan.assign', 'plan.consume', 'plan.reverse', 'plan.adjust', 'waitlist.read', 'waitlist.manage',
      'dashboard.operations', 'kpi.read', 'audit.read', 'notification.read', 'notification.retry',
      'csv.export.customers', 'csv.export.bookings', 'csv.export.master', 'csv.export.ledger',
    ],
    staff: [
      'shift.read.own', 'booking.read.own', 'booking.create.own', 'booking.update.own', 'booking.cancel.own', 'booking.status.own', 'booking.internal_note',
      'customer.read', 'customer.create', 'customer.update', 'customer.note.general', 'customer.note.confidential',
      'record.read', 'record.write.own', 'pass.read', 'pass.consume', 'plan.read', 'plan.consume',
    ],
    reception: [
      'shift.read.all', 'booking.read.all', 'booking.create.all', 'booking.update.all', 'booking.cancel.all', 'booking.status.all', 'reception.operate',
      'customer.read', 'customer.create', 'customer.update', 'customer.note.general',
      'pass.read', 'pass.grant', 'pass.consume', 'plan.read', 'plan.assign', 'plan.consume', 'waitlist.read', 'waitlist.manage',
    ],
  };

  it('コードの対応表が期待どおり(権限の追加・削除はこのテストと RBAC.md の更新が必要)', () => {
    for (const role of Object.keys(EXPECTED) as Role[]) {
      expect([...ROLE_PERMISSIONS[role]].sort(), role).toEqual([...EXPECTED[role]].sort());
    }
  });

  it('要件の禁止事項: Reception は経営KPI・機密メモ・内部メモ・監査・設定を持たない / Staff は KPI・他人の予約・設定を持たない', () => {
    for (const p of ['kpi.read', 'dashboard.operations', 'customer.note.confidential', 'record.read', 'audit.read', 'org.manage', 'member.manage', 'booking.force', 'booking.internal_note'] as Permission[]) {
      expect(ROLE_PERMISSIONS.reception.has(p), `reception: ${p}`).toBe(false);
    }
    for (const p of ['kpi.read', 'dashboard.operations', 'booking.read.all', 'audit.read', 'org.manage', 'member.manage', 'reception.operate', 'csv.export.customers'] as Permission[]) {
      expect(ROLE_PERMISSIONS.staff.has(p), `staff: ${p}`).toBe(false);
    }
    for (const p of ['org.manage', 'member.manage', 'location.manage', 'service.manage', 'staff.manage', 'csv.import', 'backup.manage', 'customer.anonymize'] as Permission[]) {
      expect(ROLE_PERMISSIONS.manager.has(p), `manager: ${p}`).toBe(false);
    }
  });

  it('RBAC.md の権限マトリクスに書かれた権限名はすべてコードに存在する', () => {
    const doc = readFileSync('docs/RBAC.md', 'utf8');
    const section = doc.slice(doc.indexOf('## 3.'), doc.indexOf('## 4.'));
    const names = new Set<string>();
    for (const line of section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 権限') && !l.startsWith('|---'))) {
      const cell = line.split('|')[1];
      for (const m of cell.matchAll(/[a-z]+(?:\.[a-z_*]+)+/g)) names.add(m[0]);
    }
    expect(names.size).toBeGreaterThan(20);
    const unknown = [...names].filter((n) => {
      if (n.endsWith('.*')) return !PERMISSIONS.some((p) => p.startsWith(n.slice(0, -1)));
      return !PERMISSIONS.some((p) => p === n || p.startsWith(`${n}.`));
    });
    expect(unknown).toEqual([]);
  });
});

describe('全ロール × 代表API', () => {
  const Q = '?from=2029-11-01T00:00:00Z&to=2030-02-01T00:00:00Z';
  const rows: { name: string; method: string; url: () => string; body?: unknown; expect: Record<Who, Expect> }[] = [
    { name: '組織情報の閲覧', method: 'GET', url: () => '/api/v1/org', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '組織設定の変更', method: 'PATCH', url: () => '/api/v1/org', body: { name: '' }, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: 'メンバー一覧', method: 'GET', url: () => '/api/v1/members', expect: { owner: 'ok', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: 'メンバー招待', method: 'POST', url: () => '/api/v1/members/invitations', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '拠点の作成', method: 'POST', url: () => '/api/v1/locations', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '拠点の設定変更', method: 'PATCH', url: () => `/api/v1/locations/${ids.locations.ikebukuro}`, body: { name: '' }, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '臨時休業(自拠点)', method: 'POST', url: () => `/api/v1/locations/${ids.locations.ikebukuro}/exceptions`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '臨時休業(担当外の拠点)', method: 'POST', url: () => `/api/v1/locations/${ids.locations.shinjuku}/exceptions`, body: {}, expect: { owner: 'auth', manager: 'hidden', reception: 'deny', staff: 'deny' } },
    { name: 'サービスの作成', method: 'POST', url: () => '/api/v1/services', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: 'スタッフの作成', method: 'POST', url: () => '/api/v1/staff', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: 'リソースの作成', method: 'POST', url: () => '/api/v1/resources', body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: 'シフトの作成', method: 'POST', url: () => '/api/v1/shifts', body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: 'シフトの閲覧', method: 'GET', url: () => `/api/v1/shifts${Q}`, expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '予約一覧', method: 'GET', url: () => `/api/v1/bookings${Q}`, expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '予約(自分の担当)', method: 'GET', url: () => `/api/v1/bookings/${ref.bookingIkeAki}`, expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '予約(同じ拠点の他スタッフ)', method: 'GET', url: () => `/api/v1/bookings/${ref.bookingIkeOther}`, expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'hidden' } },
    { name: '予約(担当外の拠点)', method: 'GET', url: () => `/api/v1/bookings/${ref.bookingShinKen}`, expect: { owner: 'ok', manager: 'hidden', reception: 'hidden', staff: 'hidden' } },
    // 本文は有効な値(期待する版を 0 にして、実際には変更されないようにする)
    { name: '来店・完了などの状態変更', method: 'POST', url: () => `/api/v1/bookings/${ref.bookingIkeOther}/status`, body: { to: 'arrived', expectedVersion: 0 }, expect: { owner: 'auth', manager: 'auth', reception: 'auth', staff: 'hidden' } },
    { name: 'キャンセルの取り消し(復元)', method: 'POST', url: () => `/api/v1/bookings/${ref.bookingIkeAki}/restore`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '予約の作成', method: 'POST', url: () => '/api/v1/bookings', body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'auth', staff: 'auth' } },
    { name: '受付ボード', method: 'GET', url: () => `/api/v1/reception/board?locationId=${ids.locations.ikebukuro}`, expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'deny' } },
    { name: '顧客一覧', method: 'GET', url: () => '/api/v1/customers', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '機密メモの追加', method: 'POST', url: () => `/api/v1/customers/${ids.customers.repeater}/notes`, body: { body: '機密', visibility: 'confidential' }, expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'ok' } },
    { name: '顧客の統合', method: 'POST', url: () => `/api/v1/customers/${ids.customers.repeater}/merge`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '顧客の匿名化', method: 'POST', url: () => `/api/v1/customers/${ids.customers.repeater}/anonymize`, body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '顧客データの書き出し', method: 'GET', url: () => `/api/v1/customers/${ids.customers.repeater}/export`, expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'deny' } },
    { name: '実施記録(内部メモ含む)の一覧', method: 'GET', url: () => '/api/v1/records', expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'ok' } },
    { name: '実施記録の取消', method: 'POST', url: () => `/api/v1/records/${ref.recordIke}/void`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '回数券一覧', method: 'GET', url: () => '/api/v1/passes', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '回数券の付与', method: 'POST', url: () => `/api/v1/customers/${ids.customers.repeater}/passes`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'auth', staff: 'deny' } },
    { name: '回数券の手動調整', method: 'POST', url: () => `/api/v1/passes/${ref.pass}/adjust`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '消化の取消(戻し)', method: 'POST', url: () => `/api/v1/bookings/${ref.bookingIkeAki}/consumption/reverse`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '利用プランの契約', method: 'POST', url: () => `/api/v1/customers/${ids.customers.repeater}/plans`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'auth', staff: 'deny' } },
    { name: '利用プランの手動調整', method: 'POST', url: () => `/api/v1/plans/${ref.plan}/adjust`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: '回数券の種類の作成', method: 'POST', url: () => '/api/v1/pass-products', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '待機リスト', method: 'GET', url: () => '/api/v1/waitlist', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'deny' } },
    { name: '待機の登録', method: 'POST', url: () => '/api/v1/waitlist', body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'auth', staff: 'deny' } },
    { name: 'ダッシュボード(ロール別)', method: 'GET', url: () => '/api/v1/dashboard', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
    { name: '運営KPI', method: 'GET', url: () => '/api/v1/kpi?from=2029-12-01&to=2029-12-31', expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'deny' } },
    { name: '監査ログ', method: 'GET', url: () => '/api/v1/audit', expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'deny' } },
    { name: '通知履歴', method: 'GET', url: () => '/api/v1/notifications', expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'deny' } },
    { name: '通知の再送', method: 'POST', url: () => `/api/v1/notifications/${ref.notificationIke}/retry`, body: {}, expect: { owner: 'auth', manager: 'auth', reception: 'deny', staff: 'deny' } },
    { name: 'CSV出力(顧客)', method: 'GET', url: () => '/api/v1/csv/export/customers', expect: { owner: 'ok', manager: 'ok', reception: 'deny', staff: 'deny' } },
    { name: 'CSV取込', method: 'POST', url: () => '/api/v1/csv/import/preview', body: {}, expect: { owner: 'auth', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: 'バックアップ', method: 'GET', url: () => '/api/v1/backup/status', expect: { owner: 'ok', manager: 'deny', reception: 'deny', staff: 'deny' } },
    { name: '横断検索', method: 'GET', url: () => '/api/v1/search?q=%E5%B8%B8%E9%80%A3', expect: { owner: 'ok', manager: 'ok', reception: 'ok', staff: 'ok' } },
  ];

  const matches = (status: number, e: Expect) =>
    e === 'ok' ? status >= 200 && status < 300 : e === 'auth' ? status !== 401 && status !== 403 && status !== 404 && status < 500 : e === 'deny' ? status === 403 : status === 404;

  it('期待どおりに許可/拒否される', async () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      for (const who of ['owner', 'manager', 'reception', 'staff'] as Who[]) {
        const res = await s[who].request(row.method, row.url(), row.method === 'GET' ? undefined : row.body);
        if (!matches(res.status, row.expect[who])) mismatches.push(`${row.name} / ${who}: 期待 ${row.expect[who]} 実際 ${res.status} ${JSON.stringify(res.body?.error?.message ?? '')}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('担当外の拠点のデータは一覧・検索・KPIに含まれない(Manager は池袋のみ)', async () => {
    const bookings = await s.manager.get(`/api/v1/bookings${Q}&limit=500`);
    expect(bookings.body.items.length).toBeGreaterThan(0);
    expect(bookings.body.items.every((b: { locationId: string }) => b.locationId === ids.locations.ikebukuro)).toBe(true);
    const shin = await s.manager.get(`/api/v1/bookings${Q}&locationId=${ids.locations.shinjuku}`);
    expect(shin.status).toBe(404);
    const kpi = await s.manager.get(`/api/v1/kpi?from=2029-12-01&to=2029-12-31&locationId=${ids.locations.shinjuku}`);
    expect(kpi.status).toBe(404);
    const audit = await s.manager.get('/api/v1/audit?limit=200');
    expect(audit.body.items.every((a: { locationId: string | null }) => a.locationId === ids.locations.ikebukuro)).toBe(true);
    // Staff Aki は自分の担当予約のみ
    const mine = await s.staff.get(`/api/v1/bookings${Q}&limit=500`);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((b: { staffId: string }) => b.staffId === ids.staff.aki)).toBe(true);
  });
});
