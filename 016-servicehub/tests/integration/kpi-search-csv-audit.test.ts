/**
 * Phase 8: 運営KPI(必須 #20)・横断検索・CSV 出力/取込・監査ログ
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, unescapeCell } from '../../src/server/modules/csv/format.js';
import { withTenant } from '../../src/server/db/tx.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let manager: ApiSession;
let staff: ApiSession;
let reception: ApiSession;
let cat: Catalog;
let IKE = '';
let SHIN = '';
const D = '2030-01-10';
const D2 = '2030-01-11';
// 台帳の作成日時は DB の現在時刻(テストの時計ではない)。台帳を作成日で絞る指標・出力は実際の日付で確認する
const REAL_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const REAL_FROM = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
const REAL_TO = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);

async function ok<T = any>(p: Promise<{ status: number; body: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new Error(`API failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function customer(name: string, extra: Record<string, unknown> = {}) {
  return (await ok(owner.post('/api/v1/customers', { name, email: `${idem('m')}@cust.example`, phone: '090-1234-0000', ...extra }))).id as string;
}

async function book(locationId: string, serviceId: string, staffId: string | null, date: string, time: string, customerId: string) {
  return ok(owner.post('/api/v1/bookings', { locationId, serviceId, staffId, startsAt: at(date, time), customer: { customerId }, idempotencyKey: idem('b') }));
}

const status = (id: string, to: string) => ok(owner.post(`/api/v1/bookings/${id}/status`, { to }));
const complete = (id: string, body: Record<string, unknown> = {}) => ok(owner.post(`/api/v1/bookings/${id}/complete`, body));

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email);
  manager = await login(t.app, f.users.manager.email);
  staff = await login(t.app, f.users.staff.email);
  reception = await login(t.app, f.users.reception.email);
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '21:00');
  await addShift(owner, cat.staff.ken, SHIN, D, '09:00', '21:00');
  // 稼働率用: Mika 池袋 D2 9-17、休憩 12-13
  await addShift(owner, cat.staff.mika, IKE, D2, '09:00', '17:00');
  await addShift(owner, cat.staff.mika, null, D2, '12:00', '13:00', 'break');
});
afterAll(async () => {
  await t.close();
});

describe('運営KPI', () => {
  let repeater = '';

  it('#20 2拠点の拠点別合計 = 全体、同じ予約を二重計上しない', async () => {
    // 事前の来店(リピーター判定用、期間外の過去)
    repeater = await customer('KPI リピーター');
    const past = await ok(
      owner.post('/api/v1/bookings', {
        locationId: IKE,
        serviceId: cat.services.personal60,
        staffId: cat.staff.mika,
        startsAt: at('2030-01-06', '10:00'),
        customer: { customerId: repeater },
        force: true,
        forceReason: '過去の来店',
        idempotencyKey: idem('p'),
      }),
    );
    await complete(past.id);
    const newbie = await customer('KPI 新規');
    // 池袋: 完了2(うち1人はリピーター)・顧客キャンセル1・無断欠席1、新宿: 完了1(2名)・事業者キャンセル1
    const a = await book(IKE, cat.services.personal60, cat.staff.mika, D, '10:00', repeater);
    const b = await book(IKE, cat.services.personal60, cat.staff.mika, D, '12:00', newbie);
    const c = await book(IKE, cat.services.personal60, cat.staff.mika, D, '14:00', await customer('KPI キャンセル'));
    const d = await book(IKE, cat.services.personal60, cat.staff.mika, D, '16:00', await customer('KPI 欠席'));
    await complete(a.id);
    await complete(b.id);
    await ok(owner.post(`/api/v1/bookings/${c.id}/cancel`, { by: 'customer' }));
    await status(d.id, 'no_show');
    const yogaCustomer = await customer('KPI ヨガ');
    const y = await ok(
      owner.post('/api/v1/bookings', { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '10:00'), partySize: 2, customer: { customerId: yogaCustomer }, idempotencyKey: idem('y') }),
    );
    await complete(y.id);
    const z = await book(SHIN, cat.services.personal60, cat.staff.ken, D, '15:00', await customer('KPI 店都合'));
    await ok(owner.post(`/api/v1/bookings/${z.id}/cancel`, { by: 'business' }));

    const k = await ok(owner.get(`/api/v1/kpi?from=${D}&to=${D}`));
    expect(k.bookings).toMatchObject({ total: 6, completed: 3, canceledCustomer: 1, canceledBusiness: 1, noShow: 1, persons: 4 });
    const sum = (key: string) => k.byLocation.reduce((s: number, l: any) => s + l.bookings[key], 0);
    for (const key of ['total', 'completed', 'canceledCustomer', 'canceledBusiness', 'noShow', 'persons']) expect(sum(key)).toBe(k.bookings[key]);
    // 率は分子・分母を返す(キャンセルを除いた4件のうち完了3・欠席1)
    expect(k.bookings.completionRate).toEqual({ value: 0.75, numerator: 3, denominator: 4 });
    expect(k.bookings.noShowRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(k.bookings.cancelRateCustomer).toMatchObject({ numerator: 1, denominator: 6 });
    // 拠点で絞ると拠点別の値と一致
    const ike = await ok(owner.get(`/api/v1/kpi?from=${D}&to=${D}&locationId=${IKE}`));
    expect(ike.bookings).toEqual(k.byLocation.find((l: any) => l.locationId === IKE).bookings);
    // 顧客: 期間内に完了した3人のうちリピーター1人
    expect(k.customers).toEqual({ withCompleted: 3, newCustomers: 2, repeaters: 1 });
    expect(k.services.find((s: any) => s.serviceId === cat.services.yoga6)).toMatchObject({ completed: 1, persons: 2 });
  });

  it('予約のない期間の率は null(0 にしない)', async () => {
    const k = await ok(owner.get('/api/v1/kpi?from=2030-03-01&to=2030-03-31'));
    expect(k.bookings.total).toBe(0);
    expect(k.bookings.completionRate).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(k.staff.utilization.value).toBeNull();
  });

  it('スタッフ稼働率: 勤務8h・休憩1h・予約3h → 3/7(キャンセルは除き、無断欠席は含む)', async () => {
    const c1 = await customer('稼働1');
    const b1 = await book(IKE, cat.services.personal60, cat.staff.mika, D2, '09:00', c1);
    const b2 = await book(IKE, cat.services.personal60, cat.staff.mika, D2, '10:00', c1);
    const b3 = await book(IKE, cat.services.personal60, cat.staff.mika, D2, '14:00', c1);
    const b4 = await book(IKE, cat.services.personal60, cat.staff.mika, D2, '15:00', c1);
    await complete(b1.id);
    await complete(b2.id);
    await status(b3.id, 'no_show');
    await ok(owner.post(`/api/v1/bookings/${b4.id}/cancel`, { by: 'customer' }));
    const k = await ok(owner.get(`/api/v1/kpi?from=${D2}&to=${D2}&locationId=${IKE}`));
    const mika = k.staff.rows.find((s: any) => s.staffId === cat.staff.mika);
    expect(mika).toMatchObject({ availableMin: 420, occupiedMin: 180, outsideShift: 0 });
    expect(mika.utilization.value).toBeCloseTo(3 / 7, 5);
  });

  it('回数券の純利用数(利用 − 取消戻し)', async () => {
    const product = (await ok(owner.post('/api/v1/pass-products', { name: 'KPI券', totalUses: 5, allServices: true }))).id;
    const pass = await ok(owner.post(`/api/v1/customers/${repeater}/passes`, { passProductId: product, idempotencyKey: idem('g') }));
    const b1 = await book(IKE, cat.services.personal60, cat.staff.mika, D, '18:00', repeater);
    const b2 = await book(IKE, cat.services.personal60, cat.staff.mika, D, '19:00', repeater);
    await complete(b1.id, { consume: { kind: 'pass', entitlementId: pass.id, idempotencyKey: idem('u') } });
    await complete(b2.id, { consume: { kind: 'pass', entitlementId: pass.id, idempotencyKey: idem('u') } });
    await ok(owner.post(`/api/v1/bookings/${b2.id}/consumption/reverse`, { reason: '誤り' }));
    const k = await ok(owner.get(`/api/v1/kpi?from=${REAL_FROM}&to=${REAL_TO}`));
    expect(k.passes).toMatchObject({ uses: 2, reversals: 1, usesNet: 1 });
    expect(REAL_TODAY >= REAL_FROM && REAL_TODAY <= REAL_TO).toBe(true);
  });

  it('権限: Staff・受付は KPI を見られない。Manager は担当拠点のみ', async () => {
    expectError(await staff.get(`/api/v1/kpi?from=${D}&to=${D}`), 403, 'FORBIDDEN');
    expectError(await reception.get(`/api/v1/kpi?from=${D}&to=${D}`), 403, 'FORBIDDEN');
    const m = await ok(manager.get(`/api/v1/kpi?from=${D}&to=${D}`));
    expect(m.locations.map((l: any) => l.id)).toEqual([IKE]);
    expectError(await manager.get(`/api/v1/kpi?from=${D}&to=${D}&locationId=${SHIN}`), 404, 'NOT_FOUND');
    expectError(await owner.get('/api/v1/kpi?from=2030-01-10&to=2029-01-10'), 400, 'VALIDATION_ERROR');
    expectError(await owner.get('/api/v1/kpi?from=2029-01-01&to=2030-06-01'), 400, 'VALIDATION_ERROR');
  });
});

describe('横断検索', () => {
  it('顧客・予約番号・スタッフ・サービスを権限の範囲で返す', async () => {
    const c = await customer('検索 太郎');
    const b = await book(IKE, cat.services.trial30, cat.staff.mika, D, '20:00', c);
    const r = await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('検索')}`));
    expect(r.customers.map((x: any) => x.id)).toContain(c);
    const byCode = await ok(owner.get(`/api/v1/search?q=${b.code.toLowerCase()}`));
    expect(byCode.bookings.map((x: any) => x.id)).toEqual([b.id]);
    expect((await ok(owner.get('/api/v1/search?q=mika'))).staff.map((s: any) => s.id)).toEqual([cat.staff.mika]);
    expect((await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('ヨガ')}`))).services.map((s: any) => s.id)).toEqual([cat.services.yoga6]);
    // Staff(Aki)は他スタッフ(Mika)の予約を予約番号でも見られない
    expect((await ok(staff.get(`/api/v1/search?q=${b.code}`))).bookings).toEqual([]);
    // 受付(池袋)は新宿だけの顧客を見られない
    const shinOnly = await customer('新宿だけ 花子');
    await book(SHIN, cat.services.personal60, cat.staff.ken, D, '18:00', shinOnly);
    const rc = await ok(reception.get(`/api/v1/search?q=${encodeURIComponent('新宿だけ')}`));
    expect(rc.customers).toEqual([]);
    expect((await ok(reception.get('/api/v1/search?q=ken'))).staff).toEqual([]);
  });

  it('回数券(顧客名・券の名前)と拠点も権限の範囲で返す', async () => {
    const product = await ok(owner.post('/api/v1/pass-products', { name: '検索用10回券', totalUses: 10, validityDays: 180, allServices: true, serviceIds: [] }));
    const ike = await customer('回数券 池袋さん');
    await book(IKE, cat.services.trial30, cat.staff.mika, D2, '11:00', ike);
    const shin = await customer('回数券 新宿さん');
    await book(SHIN, cat.services.personal60, cat.staff.ken, D, '11:00', shin);
    const passIke = await ok(owner.post(`/api/v1/customers/${ike}/passes`, { passProductId: product.id, idempotencyKey: idem('grant') }));
    const passShin = await ok(owner.post(`/api/v1/customers/${shin}/passes`, { passProductId: product.id, idempotencyKey: idem('grant') }));
    // 顧客名で: その顧客の有効な回数券
    const byCustomer = await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('回数券 池袋')}`));
    expect(byCustomer.passes.map((p: any) => p.id)).toEqual([passIke.id]);
    expect(byCustomer.passes[0]).toMatchObject({ customerName: '回数券 池袋さん', name: '検索用10回券', remaining: 10 });
    // 券の名前で: 見てよい顧客の分だけ(受付・Manager は池袋の顧客のみ)
    const ownerByName = (await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('検索用10回')}`))).passes.map((p: any) => p.id);
    expect(ownerByName.sort()).toEqual([passIke.id, passShin.id].sort());
    expect((await ok(reception.get(`/api/v1/search?q=${encodeURIComponent('検索用10回')}`))).passes.map((p: any) => p.id)).toEqual([passIke.id]);
    expect((await ok(manager.get(`/api/v1/search?q=${encodeURIComponent('検索用10回')}`))).passes.map((p: any) => p.id)).toEqual([passIke.id]);
    // LIKE の記号は文字として扱う
    expect((await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('%')}`))).passes).toEqual([]);
    // 拠点: 名前・URL名で。担当外の拠点は返さない
    expect((await ok(owner.get(`/api/v1/search?q=${encodeURIComponent('新宿')}`))).locations.map((l: any) => l.id)).toEqual([SHIN]);
    expect((await ok(reception.get(`/api/v1/search?q=${encodeURIComponent('新宿')}`))).locations).toEqual([]);
    const ikeLoc = (await ok(reception.get(`/api/v1/search?q=${encodeURIComponent('池袋')}`))).locations;
    expect(ikeLoc.map((l: any) => l.id)).toEqual([IKE]);
  });
});

describe('CSV 出力', () => {
  it('顧客: BOM・見出し・数式インジェクション対策・引用', async () => {
    const evil = await customer('=HYPERLINK("http://evil.example","x")', { phone: '+81 90 1111 2222' });
    const res = await owner.get('/api/v1/csv/export/customers');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''");
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text);
    expect(rows[0].slice(0, 5)).toEqual(['顧客ID', '氏名', 'フリガナ', 'メール', '電話']);
    const row = rows.find((r) => r[0] === evil)!;
    expect(row[1]).toBe(`'=HYPERLINK("http://evil.example","x")`);
    expect(row[4]).toBe("'+81 90 1111 2222");
    expect(unescapeCell(row[1])).toBe('=HYPERLINK("http://evil.example","x")');
    expect(text).toContain('\r\n');
  });

  it('予約: 期間必須・拠点スコープ。台帳の数値(マイナス)はそのまま', async () => {
    expectError(await owner.get('/api/v1/csv/export/bookings'), 400, 'VALIDATION_ERROR');
    const all = parseCsv((await owner.get(`/api/v1/csv/export/bookings?from=${D}&to=${D}`)).body as string);
    const mine = parseCsv((await manager.get(`/api/v1/csv/export/bookings?from=${D}&to=${D}`)).body as string);
    expect(all.length).toBeGreaterThan(mine.length);
    expect(mine.slice(1).every((r) => r[1] === '池袋店')).toBe(true);
    const ledger = parseCsv((await owner.get(`/api/v1/csv/export/pass-ledger?from=${REAL_FROM}&to=${REAL_TO}`)).body as string);
    const use = ledger.find((r) => r[6] === '利用')!;
    expect(use[7]).toBe('-1');
  });

  it('キャンセル・無断欠席: 区分・理由・日時・操作者・締切後か。拠点スコープ', async () => {
    expectError(await owner.get('/api/v1/csv/export/cancellations'), 400, 'VALIDATION_ERROR');
    const all = parseCsv((await owner.get(`/api/v1/csv/export/cancellations?from=${D}&to=${D}`)).body as string);
    expect(all[0]).toEqual(['予約番号', '拠点', '予約の開始', 'サービス', '担当', '顧客ID', '顧客名', '区分', '理由', '日時', '操作者', '締切後キャンセル', '回数券・プランの消化', '受付経路']);
    const rows = all.slice(1);
    expect(rows.map((r) => r[7]).sort()).toEqual(['キャンセル(事業者)', 'キャンセル(顧客)', '無断欠席']);
    // 完了・来店待ちの予約は含まない。日時と操作者(オーナーの表示名)が入る
    expect(rows.every((r) => r[9] && r[10])).toBe(true);
    const noShow = rows.find((r) => r[7] === '無断欠席')!;
    expect(noShow[6]).toBe('KPI 欠席');
    expect(noShow[1]).toBe('池袋店');
    // Manager(池袋担当)は池袋の分だけ
    const mine = parseCsv((await manager.get(`/api/v1/csv/export/cancellations?from=${D}&to=${D}`)).body as string).slice(1);
    expect(mine.map((r) => r[7]).sort()).toEqual(['キャンセル(顧客)', '無断欠席']);
    expect(mine.every((r) => r[1] === '池袋店')).toBe(true);
  });

  it('権限がない種類は出力できず、出力は監査ログに残る', async () => {
    expectError(await staff.get('/api/v1/csv/export/customers'), 403, 'FORBIDDEN');
    expectError(await reception.get('/api/v1/csv/export/customers'), 403, 'FORBIDDEN');
    const logs = await ok(owner.get('/api/v1/audit?action=csv.exported'));
    expect(logs.items.length).toBeGreaterThanOrEqual(3);
    expect(logs.items[0].metadata.kind).toBeTruthy();
  });
});

describe('CSV 取込', () => {
  const header = '氏名,フリガナ,メール,電話,タグ,よく利用する拠点,メモ\r\n';

  it('エラーのあるファイルは反映できない', async () => {
    const content = `${header},ナシ,x@example.com,,,,\r\n不正 メール,,not-an-email,,,,\r\n拠点違い,,,,,存在しない店,\r\n`;
    const p = await ok(owner.post('/api/v1/csv/import/preview', { kind: 'customers', fileName: 'bad.csv', content }));
    expect(p.errorCount).toBe(3);
    expect(p.rows[0].errors).toHaveProperty('name');
    expect(p.rows[1].errors).toHaveProperty('email');
    expect(p.rows[2].errors).toHaveProperty('location');
    expectError(await owner.post(`/api/v1/csv/import/${p.id}/commit`, {}), 400, 'VALIDATION_ERROR');
  });

  it('プレビュー → 重複確認 → 反映。同じファイルは二度取り込めない', async () => {
    const existing = await customer('既存 一郎', { email: 'dup-existing@cust.example' });
    const content =
      `﻿${header}` +
      `取込 花子,トリコミ ハナコ,import-a@cust.example,090-3000-0001,新規 紹介,池袋店,"メモ, 改行\nあり"\r\n` +
      `取込 次郎,,import-b@cust.example,,,shinjuku,\r\n` +
      `ファイル内 重複,,import-a@cust.example,,,,\r\n` +
      `既存と重複,,dup-existing@cust.example,,,,\r\n` +
      `'=数式 さん,,,,,,\r\n`;
    const p = await ok(owner.post('/api/v1/csv/import/preview', { kind: 'customers', fileName: 'ok.csv', content }));
    expect(p).toMatchObject({ rowCount: 5, errorCount: 0, duplicateCount: 2 });
    expect(p.rows[2].duplicate).toEqual({ kind: 'file', line: 2 });
    expect(p.rows[3].duplicate).toMatchObject({ kind: 'existing', id: existing });
    expect(p.rows[4].values.name).toBe('=数式 さん'); // 出力時の ' を外す
    const r = await ok(owner.post(`/api/v1/csv/import/${p.id}/commit`, { duplicates: 'skip' }));
    expect(r).toMatchObject({ created: 3, skipped: 2 });
    const rows = await withTenant(t.pool, { orgId: f.orgId }, (q) =>
      q.many<{ name: string; source: string; tags: string[]; memo: string | null }>(`SELECT name, source, tags, memo FROM customers WHERE source = 'import' ORDER BY created_at`),
    );
    expect(rows.map((x) => x.name)).toEqual(['取込 花子', '取込 次郎', '=数式 さん']);
    expect(rows[0]).toMatchObject({ tags: ['新規', '紹介'], memo: 'メモ, 改行\nあり' });
    // 同じ内容(改行コードやBOMが違っても)は拒否
    expectError(await owner.post('/api/v1/csv/import/preview', { kind: 'customers', fileName: 'again.csv', content: content.replace(/^﻿/, '') }), 409, 'CONFLICT');
    // 反映済みの再反映も不可
    expectError(await owner.post(`/api/v1/csv/import/${p.id}/commit`, {}), 409, 'INVALID_STATE');
    const hist = await ok(owner.get('/api/v1/csv/imports'));
    expect(hist.items[0]).toMatchObject({ status: 'committed', rowCount: 5 });
  });

  it('サービス・スタッフの取込と権限', async () => {
    const svc = await ok(
      owner.post('/api/v1/csv/import/preview', {
        kind: 'services',
        fileName: 's.csv',
        content: '名称,所要時間(分),定員,最大人数,提供拠点,公開\r\n取込ストレッチ,45,1,1,池袋店;新宿店,はい\r\n60分パーソナル,60,1,1,池袋店,はい\r\n',
      }),
    );
    expect(svc.errorCount).toBe(0);
    expect(svc.rows[1].duplicate).toMatchObject({ kind: 'existing' });
    expect(await ok(owner.post(`/api/v1/csv/import/${svc.id}/commit`, { duplicates: 'skip' }))).toMatchObject({ created: 1, skipped: 1 });
    const services = await ok(owner.get('/api/v1/services'));
    const created = services.items.find((s: any) => s.name === '取込ストレッチ');
    expect(created.locationIds.sort()).toEqual([IKE, SHIN].sort());
    const st = await ok(owner.post('/api/v1/csv/import/preview', { kind: 'staff', fileName: 'st.csv', content: '表示名,所属拠点,予約受付\r\nNana,新宿店,はい\r\n' }));
    expect(await ok(owner.post(`/api/v1/csv/import/${st.id}/commit`, {}))).toMatchObject({ created: 1 });
    expectError(await manager.post('/api/v1/csv/import/preview', { kind: 'customers', fileName: 'x.csv', content: header }), 403, 'FORBIDDEN');
  });
});

describe('監査ログ', () => {
  it('絞り込み・ページング。Manager は担当拠点の記録だけ、Staff は不可。変更・削除は DB が拒否', async () => {
    const page1 = await ok(owner.get('/api/v1/audit?limit=5'));
    expect(page1.items).toHaveLength(5);
    expect(page1.next).toBeTruthy();
    const page2 = await ok(owner.get(`/api/v1/audit?limit=5&before=${encodeURIComponent(page1.next)}`));
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(new Date(page2.items[0].at).getTime()).toBeLessThanOrEqual(new Date(page1.items[4].at).getTime());
    const bookings = await ok(owner.get('/api/v1/audit?action=booking&limit=200'));
    expect(bookings.items.every((x: any) => x.action.startsWith('booking.'))).toBe(true);
    const m = await ok(manager.get('/api/v1/audit?limit=200'));
    expect(m.items.length).toBeGreaterThan(0);
    expect(m.items.every((x: any) => x.locationId === IKE)).toBe(true);
    expectError(await staff.get('/api/v1/audit'), 403, 'FORBIDDEN');
    await expect(withTenant(t.pool, { orgId: f.orgId }, (q) => q.exec(`UPDATE audit_logs SET action = 'x' WHERE organization_id = $1`, [f.orgId]))).rejects.toThrow();
    await expect(withTenant(t.pool, { orgId: f.orgId }, (q) => q.exec(`DELETE FROM audit_logs WHERE organization_id = $1`, [f.orgId]))).rejects.toThrow();
  });
});
