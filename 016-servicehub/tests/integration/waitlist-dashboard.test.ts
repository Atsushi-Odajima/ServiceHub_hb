/**
 * Phase 7: 待機リスト(必須テスト #16 を含む)・定員制の空き・ロール別ダッシュボード
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tx.js';
import { runScheduler } from '../../src/server/jobs/scheduler.js';
import '../../src/server/jobs/register.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { anonymous, type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

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

async function ok<T = any>(p: Promise<{ status: number; body: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new Error(`API failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function customer(label: string, email: string | null = `${label}-${idem('c')}@cust.example`) {
  return (await ok(owner.post('/api/v1/customers', { name: `顧客 ${label}`, email, phone: '090-5555-6666' }))).id as string;
}

async function yoga(customerId: string, partySize: number, time = '10:00') {
  return ok(owner.post('/api/v1/bookings', { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, time), partySize, customer: { customerId }, idempotencyKey: idem('y') }));
}

async function entries(s: ApiSession = owner, query = '') {
  return (await ok(s.get(`/api/v1/waitlist${query}`))).items as any[];
}

async function relogin() {
  owner = await login(t.app, f.users.owner.email);
  manager = await login(t.app, f.users.manager.email);
  staff = await login(t.app, f.users.staff.email);
  reception = await login(t.app, f.users.reception.email);
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  await relogin();
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.ken, SHIN, D, '09:00', '21:00');
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '21:00');
});
afterAll(async () => {
  await t.close();
});

describe('#16 待機リストは自動確定しない', () => {
  let w = '';
  let entryId = '';
  let b1 = '';

  it('満席(6/6)のクラスに待機登録 → 候補なし', async () => {
    const a = await customer('a');
    const b = await customer('b');
    b1 = (await yoga(a, 3)).id;
    await yoga(b, 3);
    w = await customer('waiter');
    const r = await ok(
      owner.post('/api/v1/waitlist', { customer: { customerId: w }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D, timeFrom: '10:00', timeTo: '10:30', partySize: 1 }),
    );
    expect(r.created).toBe(true);
    entryId = r.id;
    const e = (await entries()).find((x) => x.id === entryId);
    expect(e).toMatchObject({ status: 'waiting', source: 'staff', timeFrom: '10:00', timeTo: '10:30' });
    expect(e.matches).toEqual([]);
    // 同じ条件の再登録は同じ待機
    const again = await ok(
      owner.post('/api/v1/waitlist', { customer: { customerId: w }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D, timeFrom: '10:00', timeTo: '10:30', partySize: 1 }),
    );
    expect(again).toMatchObject({ id: entryId, created: false });
  });

  it('キャンセルで空きが出ると候補ができるが、予約は作られず待機のまま', async () => {
    const before = (await ok(owner.get(`/api/v1/bookings?customerId=${w}`))).items.length;
    await ok(owner.post(`/api/v1/bookings/${b1}/cancel`, { by: 'customer', reason: '都合' }));
    const e = (await entries()).find((x) => x.id === entryId);
    expect(e.status).toBe('waiting');
    expect(e.matches).toHaveLength(1);
    expect(e.matches[0]).toMatchObject({ startsAt: at(D, '10:00'), status: 'open' });
    const after = (await ok(owner.get(`/api/v1/bookings?customerId=${w}`))).items.length;
    expect(after).toBe(before); // 自動確定しない
  });

  it('空いた枠は先着順: 別の顧客が先に予約すると候補は stale になり、待機顧客の予約は競合で拒否', async () => {
    const x = await customer('x');
    await yoga(x, 3); // 6/6 に戻る
    const e = (await entries()).find((y) => y.id === entryId);
    expect(e.matches).toEqual([]); // 画面には出ない(stale)
    const r = await owner.post('/api/v1/bookings', {
      locationId: SHIN,
      serviceId: cat.services.yoga6,
      staffId: cat.staff.ken,
      startsAt: at(D, '10:00'),
      customer: { customerId: w },
      waitlistEntryId: entryId,
      idempotencyKey: idem('w'),
    });
    expectError(r, 409, 'SLOT_UNAVAILABLE');
    expect((await entries()).find((y) => y.id === entryId).status).toBe('waiting');
  });
});

describe('候補の通知と予約', () => {
  let w = '';
  let entryId = '';
  let seatBooking = '';

  it('通知はメール1回だけ(冪等)。予約は確定しない', async () => {
    const holder = await customer('holder');
    const others = await customer('others');
    seatBooking = (await yoga(holder, 1, '14:00')).id;
    await yoga(others, 3, '14:00');
    await yoga(await customer('others2'), 2, '14:00'); // 6/6
    w = await customer('notify');
    entryId = (await ok(owner.post('/api/v1/waitlist', { customer: { customerId: w }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D, timeFrom: '14:00', timeTo: '14:30' }))).id;
    await ok(owner.post(`/api/v1/bookings/${seatBooking}/cancel`, { by: 'business', reason: '振替' }));
    const e = (await entries()).find((x) => x.id === entryId);
    const matchId = e.matches[0].id;
    const n1 = await ok(owner.post(`/api/v1/waitlist/matches/${matchId}/notify`, { method: 'email' }));
    expect(n1).toEqual({ result: 'notified', queued: true });
    const n2 = await ok(owner.post(`/api/v1/waitlist/matches/${matchId}/notify`, { method: 'email' }));
    expect(n2.queued).toBe(false);
    const rows = await withTenant(t.pool, { orgId: f.orgId }, (q) =>
      q.many<{ payload: any; recipient: string }>(`SELECT payload, recipient FROM notifications WHERE type = 'waitlist_available' AND idempotency_key = $1`, [`waitlist_available:${matchId}`]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.url).toContain(`/p/${f.slug}/shinjuku?`);
    expect(rows[0].payload.url).toContain('time=14%3A00');
    const e2 = (await entries()).find((x) => x.id === entryId);
    expect(e2.status).toBe('notified');
    expect((await ok(owner.get(`/api/v1/bookings?customerId=${w}`))).items).toHaveLength(0);
  });

  it('待機顧客が予約すると待機は「予約済み」になり候補も閉じる', async () => {
    const b = await ok(
      owner.post('/api/v1/bookings', {
        locationId: SHIN,
        serviceId: cat.services.yoga6,
        staffId: cat.staff.ken,
        startsAt: at(D, '14:00'),
        customer: { customerId: w },
        waitlistEntryId: entryId,
        idempotencyKey: idem('w'),
      }),
    );
    const e = (await entries(owner, '?status=booked')).find((x) => x.id === entryId);
    expect(e).toMatchObject({ status: 'booked', bookedBookingId: b.id });
    // 他の顧客の待機を指定した予約は拒否
    const other = await customer('other');
    const otherEntry = (await ok(owner.post('/api/v1/waitlist', { customer: { customerId: other }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D }))).id;
    const bad = await owner.post('/api/v1/bookings', {
      locationId: SHIN,
      serviceId: cat.services.yoga6,
      staffId: cat.staff.ken,
      startsAt: at(D, '16:00'),
      customer: { customerId: w },
      waitlistEntryId: otherEntry,
      idempotencyKey: idem('w'),
    });
    expectError(bad, 400, 'VALIDATION_ERROR');
    // 指定しなくても、同じ顧客・拠点・サービス・期間内の予約で待機は閉じる
    await ok(owner.post('/api/v1/bookings', { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '17:00'), customer: { customerId: other }, idempotencyKey: idem('w') }));
    expect((await entries(owner, '?status=booked')).find((x) => x.id === otherEntry)?.status).toBe('booked');
  });

  it('通知前に埋まっていたら通知せず stale(409)。メールがない顧客は「連絡済み」で記録', async () => {
    const noMail = await customer('nomail', null);
    const holder = await customer('holder2');
    const hb = (await yoga(holder, 3, '18:00')).id;
    await yoga(await customer('h3'), 3, '18:00');
    const entry = (await ok(owner.post('/api/v1/waitlist', { customer: { customerId: noMail }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D, timeFrom: '18:00', timeTo: '18:30' }))).id;
    await ok(owner.post(`/api/v1/bookings/${hb}/cancel`, { by: 'customer' }));
    const m = (await entries()).find((x) => x.id === entry).matches[0];
    expectError(await owner.post(`/api/v1/waitlist/matches/${m.id}/notify`, { method: 'email' }), 400, 'VALIDATION_ERROR');
    const manual = await ok(owner.post(`/api/v1/waitlist/matches/${m.id}/notify`, { method: 'manual' }));
    expect(manual).toEqual({ result: 'notified', queued: false });
    // 別の顧客が埋める(候補の再計算は createBooking 時にも走るが、通知時にも必ず再判定する)
    await yoga(await customer('filler'), 3, '18:00');
    await withTenant(t.pool, { orgId: f.orgId }, (q) => q.exec(`UPDATE waitlist_matches SET status = 'open' WHERE id = $1`, [m.id]));
    expectError(await owner.post(`/api/v1/waitlist/matches/${m.id}/notify`, { method: 'manual' }), 409, 'SLOT_UNAVAILABLE');
    const st = await withTenant(t.pool, { orgId: f.orgId }, (q) => q.one<{ status: string }>('SELECT status FROM waitlist_matches WHERE id = $1', [m.id]));
    expect(st.status).toBe('stale');
  });
});

describe('公開のキャンセル待ち登録', () => {
  it('フォームトークン・ハニーポット・同意を検査し、登録できる。受付停止の拠点は不可', async () => {
    const pub = anonymous(t.app);
    const tok = await ok(pub.get(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/form-token`));
    expect(tok.allowWaitlist).toBe(true);
    const body = {
      serviceId: cat.services.yoga6,
      dateFrom: D,
      dateTo: '2030-01-12',
      timeFrom: '19:00',
      timeTo: '21:00',
      partySize: 2,
      customer: { name: '公開 待機', email: 'public-wait@cust.example', phone: '090-7777-8888' },
      formToken: tok.formToken,
      agree: true,
    };
    // 送信が早すぎる(3秒未満)
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/waitlist`, body), 400, 'VALIDATION_ERROR');
    t.clock.advanceMinutes(1);
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/waitlist`, { ...body, website: 'http://spam' }), 400, 'VALIDATION_ERROR');
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/waitlist`, { ...body, agree: false }), 400, 'VALIDATION_ERROR');
    const r = await ok(pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/waitlist`, body));
    expect(r).toMatchObject({ ok: true, created: true });
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // 内部IDを返さない
    const e = (await entries()).find((x) => x.customerName === '公開 待機');
    expect(e).toMatchObject({ source: 'public', partySize: 2, dateFrom: D, dateTo: '2030-01-12' });
    // 拠点の設定で受付停止
    await ok(owner.patch(`/api/v1/locations/${SHIN}`, { allowPublicWaitlist: false }));
    const tok2 = await ok(pub.get(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/form-token`));
    t.clock.advanceMinutes(1);
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/waitlist`, { ...body, formToken: tok2.formToken }), 404, 'NOT_FOUND');
    await ok(owner.patch(`/api/v1/locations/${SHIN}`, { allowPublicWaitlist: true }));
  });
});

describe('期限・権限・テナント分離・ダッシュボード', () => {
  it('希望期間を過ぎた待機は日次ジョブで期限切れ', async () => {
    const c = await customer('expire');
    const id = (await ok(owner.post('/api/v1/waitlist', { customer: { customerId: c }, locationId: IKE, serviceId: cat.services.personal60, dateFrom: '2030-01-08', dateTo: '2030-01-08' }))).id;
    t.clock.set('2030-01-09T00:00:00Z');
    await runScheduler(t.deps);
    await relogin();
    const e = (await entries(owner, '?status=expired')).find((x) => x.id === id);
    expect(e?.status).toBe('expired');
    t.clock.set('2030-01-07T00:00:00Z');
    await relogin();
  });

  it('Staff は待機リストを見られない。拠点外の待機・候補は見えず操作できない', async () => {
    expectError(await staff.get('/api/v1/waitlist'), 403, 'FORBIDDEN');
    expectError(await reception.get(`/api/v1/waitlist?locationId=${SHIN}`), 404, 'NOT_FOUND');
    const mine = await entries(reception);
    expect(mine.every((e) => e.locationId === IKE)).toBe(true);
    const shinEntry = (await entries()).find((e) => e.locationId === SHIN && e.status === 'waiting');
    expectError(await manager.post(`/api/v1/waitlist/${shinEntry.id}/cancel`, {}), 404, 'NOT_FOUND');
    // 受付は担当拠点で登録できる
    const c = await customer('recv');
    await ok(owner.post('/api/v1/bookings', { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '12:00'), customer: { customerId: c }, idempotencyKey: idem('v') }));
    const r = await ok(reception.post('/api/v1/waitlist', { customer: { customerId: c }, locationId: IKE, serviceId: cat.services.personal60, dateFrom: D, dateTo: D }));
    expect(r.created).toBe(true);
    expectError(await reception.post('/api/v1/waitlist', { customer: { customerId: c }, locationId: SHIN, serviceId: cat.services.yoga6, dateFrom: D, dateTo: D }), 404, 'NOT_FOUND');
  });

  it('別組織の待機・候補には触れない', async () => {
    const other = await createOrgFixture(t.pool);
    const oo = await login(t.app, other.users.owner.email);
    expect((await ok(oo.get('/api/v1/waitlist?status=all'))).items).toEqual([]);
    const anyEntry = (await entries()).find((e) => e.status === 'waiting');
    expectError(await oo.post(`/api/v1/waitlist/${anyEntry.id}/cancel`, {}), 404, 'NOT_FOUND');
    expectError(await oo.post(`/api/v1/waitlist/${anyEntry.id}/refresh`, {}), 404, 'NOT_FOUND');
  });

  it('ダッシュボードはロールごとに見える項目が違う', async () => {
    const o = await ok(owner.get('/api/v1/dashboard'));
    expect(o.locations.map((l: any) => l.name).sort()).toEqual(['新宿店', '池袋店']);
    expect(o).toHaveProperty('pendingReviews');
    expect(o).toHaveProperty('failedNotifications');
    const shin = o.locations.find((l: any) => l.id === SHIN);
    expect(shin.waitlistActive).toBeGreaterThan(0);
    const r = await ok(reception.get('/api/v1/dashboard'));
    expect(r.locations.map((l: any) => l.id)).toEqual([IKE]);
    expect(r).not.toHaveProperty('pendingReviews');
    expect(r).not.toHaveProperty('failedNotifications');
    const s = await ok(staff.get('/api/v1/dashboard'));
    expect(s).not.toHaveProperty('locations');
    expect(s.mine).toMatchObject({ today: expect.any(Number), upcoming7: expect.any(Number) });
  });
});
