/**
 * ServiceHub 名札・受付表(#010 名札・受付チェック表メーカーの統合)
 * GET /api/v1/name-badges: 拠点・日付の回(サービス × 開始時刻)と、回または1日分の予約
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocument, buildParticipants } from '../../src/shared/namebadge/core.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let cat: Catalog;
let IKE = '';
let SHIN = '';
const D = '2030-01-10';
const ids: Record<string, string> = {};

const url = (p: Record<string, string>) => `/api/v1/name-badges?${new URLSearchParams(p).toString()}`;

async function book(name: string, body: Record<string, unknown>): Promise<string> {
  const r = await owner.post('/api/v1/bookings', { customer: { name, nameKana: null, phone: null }, idempotencyKey: idem('nb'), ...body });
  if (r.status !== 200) throw new Error(`booking failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email);
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.ken, SHIN, D, '09:00', '18:00');
  await addShift(owner, cat.staff.aki, IKE, D, '09:00', '18:00');
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '18:00');
  const yoga = { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken };
  // 10:00 のヨガ(定員6): 予約順に 青木(1名) → 佐藤(3名) → 取消(1名) → 渡辺(1名)
  ids.aoki = await book('青木 一郎', { ...yoga, startsAt: at(D, '10:00') });
  ids.sato = await book('佐藤 花子', { ...yoga, startsAt: at(D, '10:00'), partySize: 3 });
  ids.canceled = await book('取消 太郎', { ...yoga, startsAt: at(D, '10:00') });
  ids.watanabe = await book('渡辺 次郎', { ...yoga, startsAt: at(D, '10:00') });
  const c = await owner.post(`/api/v1/bookings/${ids.canceled}/cancel`, { by: 'customer', reason: null });
  expect(c.status).toBe(200);
  // 同じ日の別の回
  ids.late = await book('夕方 さん', { ...yoga, startsAt: at(D, '15:00') });
  // 池袋: Aki(スタッフ本人)と Mika の個別予約
  ids.akiBooking = await book('池袋 アキ客', { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.aki, startsAt: at(D, '10:00') });
  ids.mikaBooking = await book('池袋 ミカ客', { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '13:00') });
});
afterAll(async () => {
  await t.close();
});

describe('ServiceHub name badges: data', () => {
  it('lists the sessions of the day (service × start time) with active people counts', async () => {
    const r = await owner.get(url({ locationId: SHIN, date: D }));
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('day');
    expect(r.body.location.name).toBe('新宿店');
    expect(r.body.sessions.map((s: any) => [s.startTime, s.endTime, s.serviceName, s.bookings, s.people, s.capacity, s.staffNames])).toEqual([
      ['10:00', '11:00', '6名ヨガ', 3, 5, 6, ['Ken']],
      ['15:00', '16:00', '6名ヨガ', 1, 1, 6, ['Ken']],
    ]);
    // 1日分は全予約(取消を含む。番号の計算用)
    expect(r.body.bookings).toHaveLength(5);
  });

  it('returns one session; canceled bookings carry no personal data and keep their number as a gap', async () => {
    const r = await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '10:00') }));
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('session');
    expect(r.body.selected).toMatchObject({ startTime: '10:00', people: 5 });
    expect(r.body.bookings).toHaveLength(4);
    const canceled = r.body.bookings.find((b: any) => b.id === ids.canceled);
    expect(canceled).toMatchObject({ status: 'canceled_customer', customerName: '', customerKana: null, customerTags: [] });
    expect(JSON.stringify(r.body)).not.toContain('取消 太郎');

    // 1人1枚: 佐藤さんの同行者2名は P002-2 / P002-3、取消の P003 は欠番
    const ps = buildParticipants(r.body.bookings, { partyMode: 'person', sort: 'number', orgField: 'none', showKana: true });
    expect(ps.map((p) => `${p.number}:${p.name}`)).toEqual(['P001:青木 一郎', 'P002:佐藤 花子', 'P002-2:', 'P002-3:', 'P004:渡辺 次郎']);
    const doc = buildDocument({ participants: ps, excluded: new Set(), eventName: '6名ヨガ', eventDate: '2030/01/10(木) 10:00〜11:00', mode: 'both', partyMode: 'person' });
    expect(doc.problems).toEqual([]);
    expect(doc.pages).toEqual({ badges: 1, sheet: 1, total: 2 });
    expect(doc.countText).toBe('印刷対象人数：5人');
    // 1予約1枚
    const pb = buildParticipants(r.body.bookings, { partyMode: 'booking', sort: 'number', orgField: 'none', showKana: true });
    expect(pb.map((p) => p.number)).toEqual(['P001', 'P002', 'P004']);
  });

  it('numbers do not change when another booking in the session is canceled later', async () => {
    const before = await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '10:00') }));
    const nums = (body: any) => buildParticipants(body.bookings, { partyMode: 'booking', sort: 'number', orgField: 'none', showKana: false }).map((p) => `${p.number}:${p.name}`);
    expect(nums(before.body)).toEqual(['P001:青木 一郎', 'P002:佐藤 花子', 'P004:渡辺 次郎']);
    const extra = await book('追加 さん', { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '10:00') });
    expect((await owner.post(`/api/v1/bookings/${ids.aoki}/cancel`, { by: 'business', reason: '体調不良' })).status).toBe(200);
    const after = await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '10:00') }));
    expect(nums(after.body)).toEqual(['P002:佐藤 花子', 'P004:渡辺 次郎', 'P005:追加 さん']);
    expect(after.body.bookings.some((b: any) => b.id === extra)).toBe(true);
  });

  it('validates input and unknown sessions', async () => {
    expectError(await owner.get(url({ locationId: SHIN, date: '2030-02-30' })), 400);
    expectError(await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6 })), 400);
    expectError(await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: 'x' })), 400);
    expectError(await owner.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '11:00') })), 404);
    expectError(await owner.get(url({ locationId: randomUUID(), date: D })), 404);
  });
});

describe('ServiceHub name badges: permissions and tenancy', () => {
  it('manager and reception see their own location only', async () => {
    for (const email of [f.users.manager.email, f.users.reception.email]) {
      const s = await login(t.app, email);
      const r = await s.get(url({ locationId: IKE, date: D }));
      expect(r.status).toBe(200);
      expect(r.body.bookings.map((b: any) => b.customerName).sort()).toEqual(['池袋 アキ客', '池袋 ミカ客']);
      const other = await s.get(url({ locationId: SHIN, date: D }));
      expectError(other, 404);
      expect(JSON.stringify(other.body)).not.toContain('佐藤');
    }
  });

  it('staff with own-booking permission only see bookings they are assigned to', async () => {
    const staff = await login(t.app, f.users.staff.email);
    const r = await staff.get(url({ locationId: IKE, date: D }));
    expect(r.status).toBe(200);
    expect(r.body.bookings.map((b: any) => b.customerName)).toEqual(['池袋 アキ客']);
    expect(r.body.sessions).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('ミカ客');
    // 新宿のヨガは Ken 担当なので見えない(回を指定しても存在しない扱い)
    const shin = await staff.get(url({ locationId: SHIN, date: D }));
    expect(shin.status).toBe(200);
    expect(shin.body.bookings).toEqual([]);
    expectError(await staff.get(url({ locationId: SHIN, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '10:00') })), 404);
  });

  it('another organization cannot read it with this organization ids', async () => {
    const other = await createOrgFixture(t.pool);
    const otherOwner = await login(t.app, other.users.owner.email);
    const r = await otherOwner.get(url({ locationId: SHIN, date: D }));
    expectError(r, 404);
    expect(JSON.stringify(r.body)).not.toContain('新宿店');
    // 自組織の拠点 + 他組織のサービスID でも何も出ない
    const own = await otherOwner.get(url({ locationId: other.locations[1].id, date: D, serviceId: cat.services.yoga6, startsAt: at(D, '10:00') }));
    expectError(own, 404);
    const day = await otherOwner.get(url({ locationId: other.locations[1].id, date: D }));
    expect(day.status).toBe(200);
    expect(day.body.bookings).toEqual([]);
  });

  it('requires login', async () => {
    const { anonymous } = await import('./helpers.js');
    expectError(await anonymous(t.app).get(url({ locationId: SHIN, date: D })), 401);
  });
});
