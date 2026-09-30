/**
 * 同時実行(競合)の重点テスト(Phase 9)
 * 高並行の同一枠予約・別拠点の同一スタッフ・同一リソース・定員、回数券/利用プランの同時消化、
 * 同一顧客の同時更新、同一予約の同時状態変更、変更と新規予約の取り合い、キャンセル直後の枠の取り合い。
 * どの場合も「成功は許される件数だけ」「5xx なし」「台帳・定員が崩れない」ことを確認する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystemForOrg } from '../../src/server/db/tx.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { type ApiResponse, type ApiSession, createOrgFixture, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let reception: ApiSession;
let staff: ApiSession;
let cat: Catalog;
let IKE = '';
let SHIN = '';
const D = '2030-01-14'; // 月曜
const D2 = '2030-01-15';

async function ok<T = any>(p: Promise<ApiResponse<T>>): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new Error(`API failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

const customer = (n: string) => ({ name: `並行 ${n}`, email: `${n}-${idem('m')}@cust.example`, phone: '090-3333-4444' });

function book(s: ApiSession, body: Record<string, unknown>) {
  return s.post('/api/v1/bookings', { partySize: 1, customer: customer(Math.random().toString(36).slice(2, 8)), idempotencyKey: idem('cc'), ...body });
}

function summarize(results: ApiResponse[]) {
  return {
    ok: results.filter((r) => r.status === 200).length,
    conflict: results.filter((r) => r.status === 409).length,
    server: results.filter((r) => r.status >= 500).length,
    codes: [...new Set(results.filter((r) => r.status !== 200).map((r) => r.body?.error?.code))],
    statuses: [...new Set(results.map((r) => r.status))],
  };
}

async function activeSeats(startsAt: string, staffId: string) {
  return withSystemForOrg(t.pool, f.orgId, (q) =>
    q.one<{ n: number; seats: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(seats_taken), 0)::int AS seats FROM occupancies
        WHERE organization_id = $1 AND staff_id = $2 AND starts_at = $3 AND status = 'active'`,
      [f.orgId, staffId, startsAt],
    ),
  );
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email);
  reception = await login(t.app, f.users.reception.email); // 受付は池袋のみ担当(フィクスチャ)
  staff = await login(t.app, f.users.staff.email);
  cat = await setupCatalog(owner, f);
  for (const d of [D, D2]) {
    await addShift(owner, cat.staff.aki, IKE, d, '09:00', '13:00');
    await addShift(owner, cat.staff.aki, SHIN, d, '14:00', '21:00');
    await addShift(owner, cat.staff.mika, IKE, d, '09:00', '21:00');
    await addShift(owner, cat.staff.ken, SHIN, d, '09:00', '21:00');
  }
  for (const d of ['2030-01-16', '2030-01-17', '2030-01-18']) await addShift(owner, cat.staff.ken, SHIN, d, '09:00', '21:00');
});

afterAll(async () => {
  await t.close();
});

describe('予約の競合', () => {
  it('同一スタッフ・同一枠へ50並行(管理画面と受付から混在)→ 成功は1件、残りは空きなしで拒否', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => book(i % 2 === 0 ? owner : reception, { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '15:00') })),
    );
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, conflict: 49, server: 0 });
    expect(s.codes).toEqual(['SLOT_UNAVAILABLE']);
    expect(await activeSeats(at(D, '15:00'), cat.staff.mika)).toEqual({ n: 1, seats: 1 });
  });

  it('同じスタッフを同時刻に池袋と新宿で30並行 → 成功は合計1件(複数拠点の二重予約なし)', async () => {
    // Aki は 13:00 まで池袋、14:00 から新宿。両拠点の勤務を 12:00〜 に重ねた日を用意(新宿 11:00-21:00 は排他制約で作れないため、池袋の勤務内で競合させる)
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        book(owner, { locationId: i % 2 === 0 ? IKE : SHIN, serviceId: cat.services.trial30, staffId: cat.staff.aki, startsAt: at(D2, '12:00'), force: i % 2 === 1, forceReason: '強制でも別拠点は不可' }),
      ),
    );
    const s = summarize(results);
    expect(s.ok).toBe(1);
    expect(s.server).toBe(0);
    const occ = await withSystemForOrg(t.pool, f.orgId, (q) =>
      q.many<{ location_id: string }>(
        `SELECT location_id FROM occupancies WHERE organization_id = $1 AND staff_id = $2 AND status = 'active'
            AND block_starts_at < $4 AND block_ends_at > $3`,
        [f.orgId, cat.staff.aki, at(D2, '12:00'), at(D2, '12:40')],
      ),
    );
    expect(occ).toHaveLength(1);
  });

  it('同一リソース(池袋の個室は Room A の1室)を別スタッフが20並行で取り合う → 成功は1件', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        book(owner, { locationId: IKE, serviceId: cat.services.personal60, staffId: i % 2 === 0 ? cat.staff.mika : cat.staff.aki, startsAt: at(D2, '10:00') }),
      ),
    );
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, server: 0 });
    const used = await withSystemForOrg(t.pool, f.orgId, (q) =>
      q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM occupancy_resources r JOIN occupancies o ON o.id = r.occupancy_id
          WHERE r.organization_id = $1 AND r.resource_id = $2 AND r.active AND o.starts_at = $3`,
        [f.orgId, cat.rooms.roomA, at(D2, '10:00')],
      ),
    );
    expect(used.n).toBe(1);
  });

  it('定員6のクラスへ人数1〜3の申込みが40並行 → 合計人数は6を超えない', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        book(owner, { locationId: SHIN, serviceId: cat.services.yoga6, staffId: cat.staff.ken, startsAt: at(D, '18:00'), partySize: (i % 3) + 1 }),
      ),
    );
    const s = summarize(results);
    expect(s.server).toBe(0);
    const seats = await activeSeats(at(D, '18:00'), cat.staff.ken);
    expect(seats.n).toBe(1);
    expect(seats.seats).toBeLessThanOrEqual(6);
    const booked = results.filter((r) => r.status === 200).reduce((sum, r) => sum + r.body.partySize, 0);
    expect(booked).toBe(seats.seats);
    expect(seats.seats).toBeGreaterThanOrEqual(4); // 少なくとも埋まる(1〜3人の組合せで6に近づく)
  });

  it('予約変更と新規予約が同じ枠を取り合う → 枠を得るのは1件だけ。変更が負けたら元の予約はそのまま(#14)', async () => {
    const original = await ok(book(owner, { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '09:00') }));
    const [resched, ...others] = await Promise.all([
      owner.post(`/api/v1/bookings/${original.id}/reschedule`, { startsAt: at(D, '11:00'), staffId: cat.staff.mika, expectedVersion: original.version }),
      ...Array.from({ length: 10 }, () => book(reception, { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '11:00') })),
    ]);
    const winners = [resched, ...others].filter((r) => r.status === 200).length;
    expect(winners).toBe(1);
    expect([resched, ...others].every((r) => r.status < 500)).toBe(true);
    const after = await ok(owner.get(`/api/v1/bookings/${original.id}`));
    if (resched.status === 200) {
      expect(after.startsAt).toBe(at(D, '11:00'));
      expect((await activeSeats(at(D, '09:00'), cat.staff.mika)).n).toBe(0); // 元の枠は開放
    } else {
      expect(after.startsAt).toBe(at(D, '09:00'));
      expect(after.status).toBe('confirmed');
      expect((await activeSeats(at(D, '09:00'), cat.staff.mika)).n).toBe(1);
    }
    expect((await activeSeats(at(D, '11:00'), cat.staff.mika)).n).toBe(1);
  });

  it('キャンセルで空いた枠に10並行で申込み → 成功は1件(二重に埋まらない)', async () => {
    const b = await ok(book(owner, { locationId: SHIN, serviceId: cat.services.trial30, staffId: cat.staff.ken, startsAt: at(D2, '16:00') }));
    await ok(owner.post(`/api/v1/bookings/${b.id}/cancel`, { by: 'customer', expectedVersion: b.version }));
    const results = await Promise.all(Array.from({ length: 10 }, () => book(owner, { locationId: SHIN, serviceId: cat.services.trial30, staffId: cat.staff.ken, startsAt: at(D2, '16:00') })));
    expect(summarize(results)).toMatchObject({ ok: 1, conflict: 9, server: 0 });
    // キャンセル済みの予約は復元できない(枠が埋まったため)
    const restore = await owner.post(`/api/v1/bookings/${b.id}/restore`, { expectedVersion: b.version + 1 });
    expect(restore.status).toBe(409);
  });
});

/** 60分の予約を10件(10分間隔)。Ken の新宿 9:00〜21:00 の勤務内 */
const TEN_SLOTS = ['09:00', '10:10', '11:20', '12:30', '13:40', '14:50', '16:00', '17:10', '18:20', '19:30'];

describe('回数券・利用プランの同時消化', () => {
  async function completedBookings(customerId: string, times: string[], date = D2): Promise<{ id: string }[]> {
    const out = [];
    for (const time of times) {
      const b = await ok(owner.post('/api/v1/bookings', { locationId: SHIN, serviceId: cat.services.personal60, staffId: cat.staff.ken, startsAt: at(date, time), customer: { customerId }, idempotencyKey: idem('b') }));
      await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
      out.push(b);
    }
    return out;
  }

  it('残1回の回数券へ別々の予約10件から同時に消化 → 成功は1件、残0、台帳合計と一致', async () => {
    const product = await ok(owner.post('/api/v1/pass-products', { name: '1回券', totalUses: 1, validityDays: null, allServices: true }));
    const c = (await ok(owner.post('/api/v1/customers', customer('pass-race')))).id;
    const pass = await ok(owner.post(`/api/v1/customers/${c}/passes`, { passProductId: product.id, idempotencyKey: idem('g') }));
    const bookings = await completedBookings(c, TEN_SLOTS, '2030-01-18');
    const results = await Promise.all(bookings.map((b) => owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: pass.id, idempotencyKey: idem('use') })));
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, conflict: 9, server: 0 });
    const state = await ok(owner.get(`/api/v1/passes/${pass.id}`));
    expect(state.remaining).toBe(0);
    expect(state.consistent).toBe(true);
    expect(state.ledger.filter((e: { type: string }) => e.type === 'use')).toHaveLength(1);
  });

  it('同じ予約を別々の操作キーで10回同時に消化 → 1予約につき消化は1回だけ', async () => {
    const product = await ok(owner.post('/api/v1/pass-products', { name: '5回券', totalUses: 5, validityDays: null, allServices: true }));
    const c = (await ok(owner.post('/api/v1/customers', customer('same-booking')))).id;
    const pass = await ok(owner.post(`/api/v1/customers/${c}/passes`, { passProductId: product.id, idempotencyKey: idem('g') }));
    const [b] = await completedBookings(c, ['09:00'], '2030-01-16');
    const results = await Promise.all(Array.from({ length: 10 }, () => owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: pass.id, idempotencyKey: idem('tap') })));
    expect(summarize(results)).toMatchObject({ ok: 1, server: 0 });
    const state = await ok(owner.get(`/api/v1/passes/${pass.id}`));
    expect(state.remaining).toBe(4);
    expect(state.consistent).toBe(true);
  });

  it('残1回の利用プラン期間へ10件同時に消化 → 成功は1件、期間の残0', async () => {
    const product = await ok(owner.post('/api/v1/plan-products', { name: '月1回', usesPerPeriod: 1, allServices: true }));
    const c = (await ok(owner.post('/api/v1/customers', customer('plan-race')))).id;
    const plan = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: product.id, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    const bookings = await completedBookings(c, TEN_SLOTS, '2030-01-17');
    const results = await Promise.all(bookings.map((b) => owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('use') })));
    expect(summarize(results)).toMatchObject({ ok: 1, conflict: 9, server: 0 });
    const detail = await ok(owner.get(`/api/v1/plans/${plan.id}`));
    const period = detail.periods.find((p: { start: string }) => p.start === '2030-01-01');
    expect(period.remaining).toBe(0);
    expect(period.consistent).toBe(true);
    const sum = await withSystemForOrg(t.pool, f.orgId, (q) =>
      q.one<{ s: number }>(`SELECT coalesce(sum(delta), 0)::int AS s FROM plan_ledger_entries WHERE organization_id = $1 AND customer_plan_id = $2`, [f.orgId, plan.id]),
    );
    expect(sum.s).toBe(0);
  });
});

describe('同一データの同時更新', () => {
  it('同じ顧客を20人が同時に編集(同じ版から)→ 反映されるのは1件、他は「他の操作で更新されています」', async () => {
    const c = await ok(owner.post('/api/v1/customers', customer('edit')));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? owner : reception).patch(`/api/v1/customers/${c.id}`, { memo: `編集 ${i}`, expectedVersion: c.version })),
    );
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, conflict: 19, server: 0 });
    expect(s.codes).toEqual(['VERSION_CONFLICT']);
    const after = await ok(owner.get(`/api/v1/customers/${c.id}`));
    expect(after.version).toBe(c.version + 1);
    const winner = results.find((r) => r.status === 200)!;
    expect(after.memo).toBe(winner.body.memo);
  });

  it('同じ予約を受付とスタッフが同時に更新(来店/無断欠席)→ 1件だけ反映され、状態の履歴も1件', async () => {
    const b = await ok(book(owner, { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.aki, startsAt: at(D, '10:00') }));
    const results = await Promise.all([
      reception.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived', expectedVersion: b.version }),
      staff.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived', expectedVersion: b.version }),
      owner.post(`/api/v1/bookings/${b.id}/status`, { to: 'no_show', expectedVersion: b.version }),
      reception.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived', expectedVersion: b.version }),
    ]);
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, server: 0 });
    const events = await withSystemForOrg(t.pool, f.orgId, (q) =>
      q.one<{ n: number }>(`SELECT count(*)::int AS n FROM booking_events WHERE organization_id = $1 AND booking_id = $2 AND event_type IN ('arrived', 'no_show', 'status_changed')`, [f.orgId, b.id]),
    );
    expect(events.n).toBeLessThanOrEqual(1);
    const after = await ok(owner.get(`/api/v1/bookings/${b.id}`));
    expect(after.version).toBe(b.version + 1);
  });
});
