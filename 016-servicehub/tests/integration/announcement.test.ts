/**
 * ServiceHub 空き枠お知らせ画像(#005 サロン空き枠お知らせ画像メーカーの統合)
 * GET /api/v1/availability/announcement: 予約エンジンの空きから7日分の候補時刻と空きの有無を返す
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAnnouncementState, emptyOverrides, visibleSlots } from '../../src/shared/announcement/core.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let cat: Catalog;
let IKE = '';
let SHIN = '';
const FROM = '2030-01-10';
const D2 = '2030-01-11';
const CLOSED = '2030-01-12';

const url = (p: Record<string, string>) => `/api/v1/availability/announcement?${new URLSearchParams(p).toString()}`;

beforeAll(async () => {
  // 2030-01-07 09:00 JST
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email);
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.mika, IKE, FROM, '09:00', '12:00');
  await addShift(owner, cat.staff.mika, IKE, D2, '13:00', '15:00');
  await addShift(owner, cat.staff.mika, IKE, CLOSED, '09:00', '18:00');
  await addShift(owner, cat.staff.mika, IKE, '2030-01-07', '09:00', '21:00');
  const ex = await owner.post(`/api/v1/locations/${IKE}/exceptions`, { kind: 'closed', date: CLOSED, note: '臨時休業' });
  expect(ex.status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('ServiceHub announcement image: availability data', () => {
  it('returns 7 days with candidate times and availability from the booking engine', async () => {
    const r = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, basis: 'staff' }));
    expect(r.status).toBe(200);
    expect(r.body.from).toBe(FROM);
    expect(r.body.to).toBe('2030-01-16');
    expect(r.body.location.name).toBe('池袋店');
    expect(r.body.service.name).toBe('60分パーソナル');
    expect(r.body.days.map((d: any) => d.date)).toEqual(['2030-01-10', '2030-01-11', '2030-01-12', '2030-01-13', '2030-01-14', '2030-01-15', '2030-01-16']);
    const d1 = r.body.days[0];
    expect(d1.closed).toBe(false);
    // 営業 09:00-21:00、60分、30分刻み → 候補 09:00〜20:00
    expect(d1.slots[0].time).toBe('09:00');
    expect(d1.slots.at(-1).time).toBe('20:00');
    expect(d1.slots.filter((s: any) => s.available).map((s: any) => s.time)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(d1.slots[0].startsAt).toBe(at(FROM, '09:00'));
    expect(r.body.days[1].slots.filter((s: any) => s.available).map((s: any) => s.time)).toEqual(['13:00', '13:30', '14:00']);
    // 臨時休業日は closed、シフトのない日は候補はあるが空きなし
    expect(r.body.days[2]).toMatchObject({ date: CLOSED, closed: true, slots: [] });
    expect(r.body.days[3].closed).toBe(false);
    expect(r.body.days[3].slots.length).toBeGreaterThan(0);
    expect(r.body.days[3].slots.every((s: any) => !s.available)).toBe(true);
  });

  it('reflects bookings: a booked time is no longer available', async () => {
    const b = await owner.post('/api/v1/bookings', {
      locationId: IKE,
      serviceId: cat.services.personal60,
      staffId: cat.staff.mika,
      startsAt: at(FROM, '10:00'),
      customer: { name: '告知 花子', phone: '090-0000-1111' },
      idempotencyKey: idem('ann'),
    });
    expect(b.status).toBe(200);
    const r = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, basis: 'staff' }));
    // 10:00-11:00 が埋まる → 09:30(〜10:30)と 10:30(〜11:30)も重なる
    expect(r.body.days[0].slots.filter((s: any) => s.available).map((s: any) => s.time)).toEqual(['09:00', '11:00']);
  });

  it('feeds the image state: auto day modes, picked slots and closed days', async () => {
    const r = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, basis: 'staff' }));
    const state = buildAnnouncementState({
      shop: { name: 'テスト整体院', booking: 'ご予約はWebから', note: '' },
      design: { palette: 'white', size: 'square' },
      output: { mode: 'week', singleKey: null, singleTitle: 'vacancy' },
      startDate: FROM,
      days: r.body.days,
      overrides: emptyOverrides(),
    });
    expect(state.days.map((d) => d.mode)).toEqual(['slots', 'slots', 'closed', 'full', 'full', 'full', 'full']);
    expect(visibleSlots(state.days[0]).map((s) => `${s.time}:${s.status}`)).toEqual(['09:00:open', '11:00:open']);
  });

  it('does not list times that have already passed', async () => {
    // 現在 2030-01-07 09:00 JST
    const r = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: '2030-01-07', basis: 'staff' }));
    expect(r.status).toBe(200);
    expect(r.body.today).toBe('2030-01-07');
    expect(r.body.days[0].slots[0].time).toBe('09:30');
  });

  it('public basis applies the public booking page rules (non-public service has no availability)', async () => {
    const pub = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM }));
    expect(pub.status).toBe(200);
    expect(pub.body.basis).toBe('public');
    const hidden = await owner.post('/api/v1/services', {
      name: '非公開メニュー',
      durationMin: 30,
      isPublic: false,
      locationIds: [IKE],
      staffIds: [cat.staff.mika],
    });
    expect(hidden.status).toBe(200);
    const hiddenId = hidden.body.id as string;
    const r = await owner.get(url({ locationId: IKE, serviceId: hiddenId, from: FROM }));
    expect(r.status).toBe(200);
    expect(r.body.service.isPublic).toBe(false);
    expect(r.body.days[0].slots.some((s: any) => s.available)).toBe(false);
    const staffBasis = await owner.get(url({ locationId: IKE, serviceId: hiddenId, from: FROM, basis: 'staff' }));
    expect(staffBasis.body.days[0].slots.some((s: any) => s.available)).toBe(true);
  });

  it('filters by staff when given', async () => {
    const r = await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, basis: 'staff', staffId: cat.staff.aki }));
    expect(r.status).toBe(200);
    expect(r.body.days[0].slots.some((s: any) => s.available)).toBe(false);
    expectError(await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, staffId: randomUUID() })), 404);
  });

  it('validates input', async () => {
    expectError(await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: '2030-13-01' })), 400);
    expectError(await owner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM, basis: 'other' })), 400);
    expectError(await owner.get(url({ locationId: IKE, serviceId: randomUUID(), from: FROM })), 404);
  });
});

describe('ServiceHub announcement image: permissions and tenancy', () => {
  it('manager and reception can use it for their own location only; staff cannot', async () => {
    const manager = await login(t.app, f.users.manager.email);
    const reception = await login(t.app, f.users.reception.email);
    const staff = await login(t.app, f.users.staff.email);
    for (const s of [manager, reception]) {
      expect((await s.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM }))).status).toBe(200);
      expectError(await s.get(url({ locationId: SHIN, serviceId: cat.services.personal60, from: FROM })), 404);
    }
    expectError(await staff.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM })), 403);
  });

  it('another organization cannot read it with this organization ids', async () => {
    const other = await createOrgFixture(t.pool);
    const otherOwner = await login(t.app, other.users.owner.email);
    const r = await otherOwner.get(url({ locationId: IKE, serviceId: cat.services.personal60, from: FROM }));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('池袋店');
    const own = await otherOwner.get(url({ locationId: other.locations[0].id, serviceId: cat.services.personal60, from: FROM }));
    expect(own.status).toBe(404);
  });
});
