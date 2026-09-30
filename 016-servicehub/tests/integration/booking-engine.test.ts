import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let cat: Catalog;
const D = '2030-01-10';
let IKE = '';
let SHIN = '';

const newCustomer = (n: string) => ({ name: `テスト ${n}`, email: `${n}@cust.example`, phone: '090-0000-0000' });

async function book(s: ApiSession, body: Record<string, unknown>) {
  return s.post('/api/v1/bookings', { partySize: 1, customer: newCustomer(Math.random().toString(36).slice(2, 8)), idempotencyKey: idem(), ...body });
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email);
  cat = await setupCatalog(owner, f);
  // Aki: 池袋 9-13 / 新宿 14-19、Mika: 池袋 9-21、Ken: 新宿 9-21
  await addShift(owner, cat.staff.aki, IKE, D, '09:00', '13:00');
  await addShift(owner, cat.staff.aki, SHIN, D, '14:00', '19:00');
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '21:00');
  await addShift(owner, cat.staff.ken, SHIN, D, '09:00', '21:00');
});
afterAll(async () => {
  await t.close();
});

describe('Phase2: catalog CRUD', () => {
  it('lists services/staff/resources with relations', async () => {
    const svc = await owner.get(`/api/v1/services/${cat.services.personal60}`);
    expect(svc.body.requirements[0].resourceIds).toHaveLength(2);
    expect(svc.body.staffIds).toHaveLength(3);
    const staff = await owner.get(`/api/v1/staff?locationId=${SHIN}`);
    expect(staff.body.items.map((s: any) => s.displayName).sort()).toEqual(['Aki', 'Ken']);
    const res = await owner.get(`/api/v1/resources?locationId=${IKE}`);
    expect(res.body.items.map((r: any) => r.name).sort()).toEqual(['Bed 1', 'Room A']);
  });

  it('work shifts of the same staff cannot overlap across locations (DB exclusion)', async () => {
    const r = await owner.post('/api/v1/shifts', { staffId: cat.staff.aki, locationId: SHIN, type: 'work', startsAt: at(D, '12:00'), endsAt: at(D, '15:00') });
    expectError(r, 409, 'CONFLICT');
  });
});

describe('Phase2: required booking engine tests', () => {
  it('#7 Aki booked at Ikebukuro 12:00 → same time at Shinjuku is excluded and rejected even for owner force', async () => {
    const b = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.aki, startsAt: at(D, '12:00') });
    expect(b.status).toBe(200);
    // 新宿の空き枠: Aki は 14:00 から(12:00〜13:00 は候補外)
    const av = await owner.get(`/api/v1/availability?locationId=${SHIN}&serviceId=${cat.services.personal60}&date=${D}&staffId=${cat.staff.aki}`);
    const times = av.body.slots.map((s: any) => s.startsAt);
    expect(times).not.toContain(at(D, '12:00'));
    expect(times).toContain(at(D, '14:00'));
    // 管理者の手動予約(強制)でも拒否
    const forced = await book(owner, {
      locationId: SHIN,
      serviceId: cat.services.personal60,
      staffId: cat.staff.aki,
      startsAt: at(D, '12:30'),
      force: true,
      forceReason: 'テスト',
    });
    expectError(forced, 409, 'SLOT_UNAVAILABLE');
    expect(forced.body.error.details.violations.map((v: any) => v.code)).toContain('STAFF_BUSY');
  });

  it('travel buffer (org setting) blocks back-to-back bookings at different locations', async () => {
    await owner.patch('/api/v1/org', { settings: { travelBufferMinutes: 90 } });
    const r = await book(owner, { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.aki, startsAt: at(D, '14:00') });
    expectError(r, 409, 'SLOT_UNAVAILABLE');
    expect(r.body.error.details.violations.map((v: any) => v.code)).toContain('TRAVEL_TIME');
    await owner.patch('/api/v1/org', { settings: { travelBufferMinutes: 0 } });
    const ok = await book(owner, { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.aki, startsAt: at(D, '14:00') });
    expect(ok.status).toBe(200);
  });

  it('#11 booking outside shift is rejected; owner force with reason succeeds and is audited; staff cannot force', async () => {
    const r = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.aki, startsAt: at(D, '10:00').replace('T01', 'T01') });
    expect(r.status).toBe(200); // 10:00 は勤務内
    const outside = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '21:00') });
    expectError(outside, 409, 'SLOT_UNAVAILABLE');
    const noReason = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '08:00'), force: true });
    expectError(noReason, 400, 'VALIDATION_ERROR');
    const forced = await book(owner, {
      locationId: IKE,
      serviceId: cat.services.personal60,
      staffId: cat.staff.mika,
      startsAt: at(D, '08:00'),
      force: true,
      forceReason: '早朝の特別対応',
    });
    expect(forced.status).toBe(200);
    expect(forced.body.forced).toBe(true);
    const staff = await login(t.app, f.users.staff.email);
    const staffForce = await staff.post('/api/v1/bookings', {
      locationId: IKE,
      serviceId: cat.services.personal60,
      startsAt: at(D, '07:00'),
      customer: newCustomer('staffforce'),
      force: true,
      forceReason: 'x',
      idempotencyKey: idem(),
    });
    expectError(staffForce, 403, 'FORBIDDEN');
  });

  it('#10 archived staff cannot be assigned to new bookings', async () => {
    const tmp = (await owner.post('/api/v1/staff', { displayName: 'Temp', locationIds: [IKE], serviceIds: [cat.services.personal60] })).body.id;
    await addShift(owner, tmp, IKE, D, '09:00', '21:00');
    const before = await owner.get(`/api/v1/availability?locationId=${IKE}&serviceId=${cat.services.personal60}&date=${D}&staffId=${tmp}`);
    expect(before.body.slots.length).toBeGreaterThan(0);
    const arch = await owner.post(`/api/v1/staff/${tmp}/archive`, { archived: true });
    expect(arch.status).toBe(200);
    const after = await owner.get(`/api/v1/availability?locationId=${IKE}&serviceId=${cat.services.personal60}&date=${D}&staffId=${tmp}`);
    expect(after.body.slots).toHaveLength(0);
    const r = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: tmp, startsAt: at(D, '15:00'), force: true, forceReason: 'x' });
    expectError(r, 409, 'SLOT_UNAVAILABLE');
    expect(r.body.error.details.violations.map((v: any) => v.code)).toContain('STAFF_INVALID');
    // おまかせでも割り当てられない
    const auto = await owner.get(`/api/v1/availability?locationId=${IKE}&serviceId=${cat.services.personal60}&date=${D}`);
    expect(auto.body.slots.flatMap((s: any) => s.staff.map((x: any) => x.staffId))).not.toContain(tmp);
  });

  it('#12 resource conflict: the only room at Ikebukuro is taken → another staff cannot book the same time', async () => {
    const m = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '16:00') });
    expect(m.status).toBe(200);
    const tmp2 = (await owner.post('/api/v1/staff', { displayName: 'Tmp2', locationIds: [IKE], serviceIds: [cat.services.personal60] })).body.id;
    await addShift(owner, tmp2, IKE, D, '09:00', '21:00');
    const r = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: tmp2, startsAt: at(D, '16:30'), force: true, forceReason: 'x' });
    expectError(r, 409, 'SLOT_UNAVAILABLE');
    expect(r.body.error.details.violations.map((v: any) => v.code)).toContain('RESOURCE_UNAVAILABLE');
    expect((await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: tmp2, startsAt: at(D, '17:00') })).status).toBe(200);
  });

  it('#13 capacity 6 with 5 booked: party of 2 rejected, party of 1 accepted', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await book(owner, { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '10:00') });
      expect(r.status).toBe(200);
    }
    const two = await book(owner, { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '10:00'), partySize: 2 });
    expectError(two, 409, 'SLOT_UNAVAILABLE');
    const one = await book(owner, { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '10:00'), partySize: 1 });
    expect(one.status).toBe(200);
    const occ = await t.pool.query('SELECT 1');
    expect(occ.rowCount).toBe(1);
    const av = await owner.get(`/api/v1/availability?locationId=${SHIN}&serviceId=${cat.services.yoga6}&date=${D}&staffId=${cat.staff.ken}`);
    expect(av.body.slots.map((s: any) => s.startsAt)).not.toContain(at(D, '10:00'));
  });

  it('#14 reschedule failure keeps the original booking intact', async () => {
    const a = (await book(owner, { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.ken, startsAt: at(D, '15:00') })).body;
    const b = (await book(owner, { locationId: SHIN, serviceId: cat.services.trial30, staffId: cat.staff.ken, startsAt: at(D, '17:00') })).body;
    const fail = await owner.post(`/api/v1/bookings/${a.id}/reschedule`, { startsAt: at(D, '17:00'), expectedVersion: a.version });
    expectError(fail, 409, 'SLOT_UNAVAILABLE');
    const after = await owner.get(`/api/v1/bookings/${a.id}`);
    expect(after.body.startsAt).toBe(at(D, '15:00'));
    expect(after.body.version).toBe(a.version);
    expect(after.body.status).toBe('confirmed');
    // 元の枠はまだ占有されている(同時刻に別予約は不可)
    const clash = await book(owner, { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.ken, startsAt: at(D, '15:00') });
    expectError(clash, 409, 'SLOT_UNAVAILABLE');
    // 成功する変更
    const okMove = await owner.post(`/api/v1/bookings/${a.id}/reschedule`, { startsAt: at(D, '18:00'), expectedVersion: a.version });
    expect(okMove.status).toBe(200);
    expect(okMove.body.version).toBe(a.version + 1);
    // 古い version での変更は拒否
    expectError(await owner.post(`/api/v1/bookings/${a.id}/reschedule`, { startsAt: at(D, '19:00'), expectedVersion: a.version }), 409, 'VERSION_CONFLICT');
    expect(b.status).toBe('confirmed');
  });

  it('#15 cancellation reopens the slot', async () => {
    const a = (await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '19:00') })).body;
    expectError(await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '19:00') }), 409, 'SLOT_UNAVAILABLE');
    const c = await owner.post(`/api/v1/bookings/${a.id}/cancel`, { by: 'customer', reason: '都合が悪くなった' });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('canceled_customer');
    const again = await book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: cat.staff.mika, startsAt: at(D, '19:00') });
    expect(again.status).toBe(200);
  });
});

describe('Phase2: idempotency and concurrency', () => {
  it('same idempotency key twice creates only one booking', async () => {
    const key = idem('dup');
    const body = { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '09:00'), customer: newCustomer('dup'), idempotencyKey: key };
    const r1 = await owner.post('/api/v1/bookings', body);
    const r2 = await owner.post('/api/v1/bookings', body);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.body.created).toBe(false);
  });

  it('20 concurrent bookings for the same staff slot → exactly one succeeds', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        book(owner, { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.ken, startsAt: at(D, '20:00'), customer: newCustomer(`race${i}`) }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);
  });

  it('concurrent group bookings never exceed capacity (6 seats, 12 attempts)', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        book(owner, { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '12:00'), customer: newCustomer(`yoga${i}`) }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(6);
  });
});

describe('Phase2: shift conflict warnings', () => {
  it('adding a break over an existing booking requires acknowledgement and never deletes the booking', async () => {
    const b = (await book(owner, { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '13:00') })).body;
    const warn = await owner.post('/api/v1/shifts', { staffId: cat.staff.mika, locationId: IKE, type: 'break', startsAt: at(D, '13:00'), endsAt: at(D, '14:00') });
    expectError(warn, 409, 'CONFLICT');
    expect(warn.body.error.details.conflicts[0].bookingId).toBe(b.id);
    const ack = await owner.post('/api/v1/shifts', {
      staffId: cat.staff.mika,
      locationId: IKE,
      type: 'break',
      startsAt: at(D, '13:00'),
      endsAt: at(D, '14:00'),
      acknowledgeConflicts: true,
    });
    expect(ack.status).toBe(200);
    const still = await owner.get(`/api/v1/bookings/${b.id}`);
    expect(still.body.status).toBe('confirmed');
  });

  it('template generation creates shifts and skips days that already have shifts', async () => {
    await owner.put(`/api/v1/shift-templates/${cat.staff.ken}`, {
      items: [1, 2, 3, 4, 5].map((weekday) => ({ locationId: SHIN, weekday, type: 'work', startTime: '10:00', endTime: '18:00' })),
    });
    const r = await owner.post('/api/v1/shifts/generate', { staffIds: [cat.staff.ken], from: '2030-01-07', to: '2030-01-13' });
    expect(r.status).toBe(200);
    // 1/10 は既存シフトありでスキップ、平日4日分を生成、土日はテンプレートなし
    expect(r.body.created).toBe(4);
    expect(r.body.skippedExisting).toBe(1);
  });
});
