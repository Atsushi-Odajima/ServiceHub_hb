/**
 * Phase 4〜6: 受付・完了/実施記録・次回予約・回数券/利用プラン台帳。
 * 必須テスト #1〜#6, #18 と消化の同時実行を含む。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withSystemForOrg } from '../../src/server/db/tx.js';
import { runScheduler } from '../../src/server/jobs/scheduler.js';
import '../../src/server/jobs/register.js';
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
let pass8 = '';
let pass2 = '';
let passShort = '';
let plan4 = '';
let planCarry = '';

const D = '2030-01-10'; // 木曜
const D2 = '2030-01-11';
const D3 = '2030-01-12';

async function ok<T = any>(p: Promise<{ status: number; body: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new Error(`API failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function newCustomer(label: string, email?: string): Promise<string> {
  const c = await ok(owner.post('/api/v1/customers', { name: `顧客 ${label}`, email: email ?? `${label}-${idem('c')}@cust.example`, phone: '090-1111-2222' }));
  return c.id;
}

/** 池袋で Mika に予約(Mika は D〜D3 の 9-21 勤務) */
async function bookFor(customerId: string, date: string, time: string, serviceId = cat.services.personal60, staffId = cat.staff.mika, locationId = IKE) {
  const b = await ok(owner.post('/api/v1/bookings', { locationId, serviceId, staffId, startsAt: at(date, time), customer: { customerId }, idempotencyKey: idem('b') }));
  return b as { id: string; version: number; status: string };
}

async function grant(customerId: string, productId: string, startsOn?: string) {
  return ok(owner.post(`/api/v1/customers/${customerId}/passes`, { passProductId: productId, startsOn, idempotencyKey: idem('g') }));
}

async function passState(passId: string) {
  return ok(owner.get(`/api/v1/passes/${passId}`));
}

async function relogin() {
  owner = await login(t.app, f.users.owner.email);
  manager = await login(t.app, f.users.manager.email);
  staff = await login(t.app, f.users.staff.email);
  reception = await login(t.app, f.users.reception.email);
}

/** 時計を動かすとセッションが失効(アイドル12時間)するため、各ロールでログインし直す */
async function setClock(iso: string) {
  t.clock.set(iso);
  await relogin();
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  await relogin();
  cat = await setupCatalog(owner, f);
  for (const d of [D, D2, D3]) {
    await addShift(owner, cat.staff.mika, IKE, d, '09:00', '21:00');
    await addShift(owner, cat.staff.ken, SHIN, d, '09:00', '21:00');
  }
  await addShift(owner, cat.staff.aki, IKE, D, '09:00', '13:00');
  pass8 = (await ok(owner.post('/api/v1/pass-products', { name: '8回券', totalUses: 8, validityDays: 180, serviceIds: [cat.services.personal60] }))).id;
  pass2 = (await ok(owner.post('/api/v1/pass-products', { name: '2回券', totalUses: 2, validityDays: null, serviceIds: [cat.services.personal60] }))).id;
  passShort = (await ok(owner.post('/api/v1/pass-products', { name: '1日券', totalUses: 3, validityDays: 1, allServices: true }))).id;
  plan4 = (await ok(owner.post('/api/v1/plan-products', { name: '月4回', usesPerPeriod: 4, serviceIds: [cat.services.personal60, cat.services.yoga6] }))).id;
  planCarry = (await ok(owner.post('/api/v1/plan-products', { name: '月2回(繰越あり)', usesPerPeriod: 2, carryoverEnabled: true, carryoverMax: 1, allServices: true }))).id;
});
afterAll(async () => {
  await t.close();
});

describe('Phase5: 回数券 必須テスト', () => {
  let customer = '';
  let passId = '';
  let bookingId = '';

  it('#1 8回券を付与 → 完了時に1回消化 → 残7(台帳から再現可能)', async () => {
    customer = await newCustomer('pass1');
    const g = await grant(customer, pass8, '2030-01-07');
    passId = g.id;
    expect(g).toMatchObject({ remaining: 8, initialUses: 8, expiresOn: '2030-07-05', usable: true, created: true });
    const b = await bookFor(customer, D, '10:00');
    bookingId = b.id;
    // 完了画面: 候補に 8回券 が出る(自動では消化しない)
    const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp.candidates.passes.map((p: any) => p.id)).toEqual([passId]);
    expect(comp.consumptionPrompt).toBe('on_complete');
    await ok(owner.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived' }));
    const done = await ok(
      owner.post(`/api/v1/bookings/${b.id}/complete`, {
        record: { internalMemo: '肩の可動域を中心に', customerMemo: 'ストレッチを継続', nextRecommendedOn: '2030-01-24' },
        consume: { kind: 'pass', entitlementId: passId, idempotencyKey: idem('use') },
      }),
    );
    expect(done.booking.status).toBe('completed');
    expect(done.consumption.balanceAfter).toBe(7);
    const s = await passState(passId);
    expect(s.remaining).toBe(7);
    expect(s.ledger.map((e: any) => [e.type, e.delta, e.balanceAfter])).toEqual([
      ['grant', 8, 8],
      ['use', -1, 7],
    ]);
    expect(s.ledger[1].bookingId).toBe(b.id);
    expect(s.ledger[1].recordId).toBe(done.recordId);
    expect(s.consistent).toBe(true);
  });

  it('#2 同じ予約への二重送信・別キーの再消化でも残7のまま', async () => {
    // 完了時に消化済みの予約へ、同じ操作を2つ同時に送る(別キー) → いずれも拒否
    const again = await Promise.all([
      owner.post(`/api/v1/bookings/${bookingId}/consume`, { kind: 'pass', entitlementId: passId, idempotencyKey: idem('dup') }),
      owner.post(`/api/v1/bookings/${bookingId}/consume`, { kind: 'pass', entitlementId: passId, idempotencyKey: idem('dup') }),
    ]);
    for (const r of again) expectError(r, 409, 'INVALID_STATE');
    // 完了を再送しても二重にならない
    expectError(await owner.post(`/api/v1/bookings/${bookingId}/complete`, {}), 409, 'INVALID_STATE');
    // 別予約で「1回消化」を二重タップ(同じ冪等キーを同時送信) → 1回だけ
    const b2 = await bookFor(customer, D, '12:00');
    await ok(owner.post(`/api/v1/bookings/${b2.id}/complete`, {}));
    const key = idem('tap');
    const taps = await Promise.all([
      owner.post(`/api/v1/bookings/${b2.id}/consume`, { kind: 'pass', entitlementId: passId, idempotencyKey: key }),
      owner.post(`/api/v1/bookings/${b2.id}/consume`, { kind: 'pass', entitlementId: passId, idempotencyKey: key }),
    ]);
    expect(taps.map((r) => r.status)).toEqual([200, 200]);
    expect(taps.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
    expect(taps[0].body.entryId).toBe(taps[1].body.entryId);
    const s = await passState(passId);
    expect(s.remaining).toBe(6);
    expect(s.ledger.filter((e: any) => e.type === 'use')).toHaveLength(2);
    // 1予約目だけで見れば 8→7 のまま(二重消化なし)
    expect(s.ledger.filter((e: any) => e.bookingId === bookingId && e.type === 'use')).toHaveLength(1);
    expect(s.consistent).toBe(true);
  });

  it('#3 消化の取消で +1(元の消化を参照する use_reversal として履歴に残る)', async () => {
    const before = (await passState(passId)).remaining;
    const r = await ok(owner.post(`/api/v1/bookings/${bookingId}/consumption/reverse`, { reason: '誤って消化' }));
    expect(r.balanceAfter).toBe(before + 1);
    const s = await passState(passId);
    const use = s.ledger.find((e: any) => e.type === 'use' && e.bookingId === bookingId);
    const rev = s.ledger.find((e: any) => e.type === 'use_reversal');
    expect(rev).toMatchObject({ delta: 1, reversesEntryId: use.id, bookingId, reason: '誤って消化' });
    expect(s.consistent).toBe(true);
    // 同じ取消の再実行は「取り消せる消化がない」
    expectError(await owner.post(`/api/v1/bookings/${bookingId}/consumption/reverse`, { reason: '再送' }), 409, 'INVALID_STATE');
    // 取消後は改めて消化できる(履歴は4件: grant/use/use/reversal → 再消化で5件)
    const re = await ok(owner.post(`/api/v1/bookings/${bookingId}/consume`, { kind: 'pass', entitlementId: passId, idempotencyKey: idem('re') }));
    expect(re.balanceAfter).toBe(before);
    expect((await passState(passId)).ledger).toHaveLength(5);
  });

  it('8回付与 → 1回利用 → 取消 の単独シナリオで残は 8 に戻る', async () => {
    const c = await newCustomer('pass3');
    const p = await grant(c, pass8, '2030-01-07');
    const b = await bookFor(c, D2, '10:00');
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('u') } }));
    expect((await passState(p.id)).remaining).toBe(7);
    await ok(owner.post(`/api/v1/bookings/${b.id}/consumption/reverse`, { reason: '取消' }));
    const s = await passState(p.id);
    expect(s.remaining).toBe(8);
    expect(s.ledger.map((e: any) => e.type)).toEqual(['grant', 'use', 'use_reversal']);
  });

  it('#5 期限切れの回数券は候補に出ず、消化も拒否。日次ジョブで expire エントリにより0になる', async () => {
    const c = await newCustomer('expired');
    const p = await grant(c, passShort, '2030-01-08'); // 1日券: 2030-01-08 のみ有効
    expect(p.expiresOn).toBe('2030-01-08');
    const b = await bookFor(c, D, '14:00');
    const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp.candidates.passes).toEqual([]);
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
    expectError(await owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x') }), 409, 'INVALID_STATE');
    // 日次ジョブ(失効)
    await setClock('2030-01-09T15:30:00Z'); // JST 2030-01-10 00:30
    await runScheduler(t.deps);
    await runScheduler(t.deps); // 2回実行しても二重に失効しない
    await relogin();
    const s = await passState(p.id);
    expect(s.status).toBe('expired');
    expect(s.remaining).toBe(0);
    expect(s.ledger.filter((e: any) => e.type === 'expire')).toHaveLength(1);
    expect(s.consistent).toBe(true);
    await setClock('2030-01-07T00:00:00Z');
  });

  it('#6 対象外サービスでは消化できない', async () => {
    const c = await newCustomer('ineligible');
    const p = await grant(c, pass8, '2030-01-07'); // 60分パーソナルのみ
    const b = await bookFor(c, D, '16:00', cat.services.trial30);
    const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp.candidates.passes).toEqual([]);
    const r = await owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x') } });
    expectError(r, 409, 'INVALID_STATE');
    // 完了ごとロールバック(消化できないなら完了もしない)
    const after = await ok(owner.get(`/api/v1/bookings/${b.id}`));
    expect(after.status).toBe('confirmed');
    expect((await passState(p.id)).remaining).toBe(8);
  });

  it('他の顧客の回数券は使えない', async () => {
    const a = await newCustomer('owner-a');
    const other = await newCustomer('owner-b');
    const p = await grant(other, pass8, '2030-01-07');
    const b = await bookFor(a, D2, '12:00');
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
    expectError(await owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x') }), 409, 'INVALID_STATE');
  });

  it('同じ回数券への同時消化(残2に対し3予約)でも負にならず、成功は2件だけ', async () => {
    const c = await newCustomer('race');
    const p = await grant(c, pass2);
    const bookings = [];
    for (const time of ['10:00', '12:00', '14:00']) {
      const b = await bookFor(c, D3, time);
      await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
      bookings.push(b);
    }
    const results = await Promise.all(
      bookings.map((b) => owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('race') })),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBe(2);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(['INVALID_STATE', 'INSUFFICIENT_BALANCE']).toContain(r.body.error.code);
    }
    const s = await passState(p.id);
    expect(s.remaining).toBe(0);
    expect(s.consistent).toBe(true);
  });

  it('手動調整は理由必須・負にできない。無効化で残りを訂正し、無効化後は戻せない', async () => {
    const c = await newCustomer('adjust');
    const p = await grant(c, pass2);
    expectError(await owner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_add', delta: 1, reason: '', idempotencyKey: idem('a') }), 400, 'VALIDATION_ERROR');
    const key = idem('a');
    const add = await ok(owner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_add', delta: 1, reason: 'サービス', idempotencyKey: key }));
    expect(add.balanceAfter).toBe(3);
    // 同じキーの再送は同じエントリ
    const again = await ok(owner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_add', delta: 1, reason: 'サービス', idempotencyKey: key }));
    expect(again.entryId).toBe(add.entryId);
    expectError(await owner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_subtract', delta: 5, reason: '誤り', idempotencyKey: idem('a') }), 409, 'INSUFFICIENT_BALANCE');
    const b = await bookFor(c, D2, '14:00');
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('u') } }));
    await ok(owner.post(`/api/v1/passes/${p.id}/void`, { reason: '返金対応' }));
    const s = await passState(p.id);
    expect(s.status).toBe('voided');
    expect(s.remaining).toBe(0);
    expect(s.ledger.map((e: any) => e.type)).toEqual(['grant', 'manual_add', 'use', 'correction']);
    expect(s.consistent).toBe(true);
    // 無効化した回数券への戻しは拒否(予約の消化記録はそのまま)
    expectError(await owner.post(`/api/v1/bookings/${b.id}/consumption/reverse`, { reason: '取消' }), 409, 'INVALID_STATE');
    expectError(await owner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_add', delta: 1, reason: 'x', idempotencyKey: idem('a') }), 409, 'INVALID_STATE');
  });

  it('台帳・残数は DB レベルで直接変更できない', async () => {
    await expect(withSystemForOrg(t.pool, f.orgId, (q) => q.exec('UPDATE pass_ledger_entries SET delta = 100 WHERE customer_pass_id = $1', [passId]))).rejects.toThrow();
    await expect(withSystemForOrg(t.pool, f.orgId, (q) => q.exec('DELETE FROM pass_ledger_entries WHERE customer_pass_id = $1', [passId]))).rejects.toThrow();
    await expect(withSystemForOrg(t.pool, f.orgId, (q) => q.exec('UPDATE customer_passes SET remaining = 100 WHERE id = $1', [passId]))).rejects.toThrow();
    expect((await passState(passId)).consistent).toBe(true);
  });

  it('付与後に種類を変更しても、付与済みの回数券はスナップショットで動く', async () => {
    const c = await newCustomer('snapshot');
    const p = await grant(c, pass8, '2030-01-07');
    await ok(owner.patch(`/api/v1/pass-products/${pass8}`, { totalUses: 10, serviceIds: [cat.services.trial30] }));
    const b = await bookFor(c, D3, '16:00'); // 60分パーソナル(付与時点の対象)
    const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp.candidates.passes.map((x: any) => x.id)).toContain(p.id);
    expect((await passState(p.id)).initialUses).toBe(8);
    await ok(owner.patch(`/api/v1/pass-products/${pass8}`, { totalUses: 8, serviceIds: [cat.services.personal60] }));
  });
});

describe('Phase6: 利用プラン 必須テスト', () => {
  it('#4 月4回プランで3回利用 → 当期の残り1。台帳の合計と一致', async () => {
    const c = await newCustomer('plan');
    const plan = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    expect(plan.currentPeriod).toMatchObject({ start: '2030-01-01', end: '2030-01-31', remaining: 4, materialized: false });
    for (const [d, time] of [
      [D, '17:00'],
      [D2, '16:00'],
      [D3, '18:00'],
    ] as const) {
      const b = await bookFor(c, d, time);
      const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
      expect(comp.candidates.plans.map((p: any) => p.id)).toEqual([plan.id]);
      await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('pu') } }));
    }
    const s = await ok(owner.get(`/api/v1/plans/${plan.id}`));
    expect(s.currentPeriod).toMatchObject({ granted: 4, used: 3, remaining: 1, materialized: true });
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]).toMatchObject({ start: '2030-01-01', end: '2030-01-31', remaining: 1, consistent: true });
    expect(s.ledger.map((e: any) => e.type)).toEqual(['grant', 'use', 'use', 'use']);
  });

  it('プランの消化も同じ冪等キーで1回・対象外サービス/期間外は拒否', async () => {
    const c = await newCustomer('plan2');
    const plan = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-11', idempotencyKey: idem('p') }));
    const early = await bookFor(c, D, '13:00'); // 契約開始前
    await ok(owner.post(`/api/v1/bookings/${early.id}/complete`, {}));
    expectError(await owner.post(`/api/v1/bookings/${early.id}/consume`, { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('x') }), 409, 'INVALID_STATE');
    const trial = await bookFor(c, D2, '18:00', cat.services.trial30);
    await ok(owner.post(`/api/v1/bookings/${trial.id}/complete`, {}));
    expectError(await owner.post(`/api/v1/bookings/${trial.id}/consume`, { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('x') }), 409, 'INVALID_STATE');
    const b = await bookFor(c, D2, '19:00');
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
    const key = idem('k');
    const r = await Promise.all([1, 2].map(() => owner.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'plan', entitlementId: plan.id, idempotencyKey: key })));
    expect(r.map((x) => x.status)).toEqual([200, 200]);
    const s = await ok(owner.get(`/api/v1/plans/${plan.id}`));
    // 今日(1/7)は契約開始前のため当期なし。1/11〜1/31 の期間で 4−1=3
    expect(s.currentPeriod).toBeNull();
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]).toMatchObject({ start: '2030-01-11', end: '2030-01-31', remaining: 3, consistent: true });
  });

  it('同じ期間の同時消化で枠を超えない(月4回に5予約)', async () => {
    const c = await newCustomer('planrace');
    const plan = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    const ids: string[] = [];
    for (const time of ['09:00', '10:00', '11:00', '12:00', '13:00']) {
      const b = await bookFor(c, D, time, cat.services.yoga6, cat.staff.ken, SHIN);
      await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
      ids.push(b.id);
    }
    const res = await Promise.all(ids.map((id) => owner.post(`/api/v1/bookings/${id}/consume`, { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('r') })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(4);
    const s = await ok(owner.get(`/api/v1/plans/${plan.id}`));
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]).toMatchObject({ remaining: 0, consistent: true });
  });

  it('期間締め: 繰越なしは失効、繰越ありは上限まで次期間へ(日次ジョブ・二重実行なし)', async () => {
    const c = await newCustomer('carry');
    const noCarry = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    const carry = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: planCarry, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    // 1月の期間を実体化: 繰越なしプランは1回利用、繰越ありプランは手動で1回減らす
    const b = await bookFor(c, D3, '19:00');
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'plan', entitlementId: noCarry.id, idempotencyKey: idem('u') } }));
    await ok(owner.post(`/api/v1/plans/${carry.id}/adjust`, { date: '2030-01-15', type: 'manual_subtract', delta: 1, reason: '前倒し調整', idempotencyKey: idem('adj') }));
    await setClock('2030-02-01T01:00:00Z'); // JST 2/1 10:00
    await runScheduler(t.deps);
    await runScheduler(t.deps);
    await relogin();
    const a = await ok(owner.get(`/api/v1/plans/${noCarry.id}`));
    const jan = a.periods.find((p: any) => p.start === '2030-01-01');
    expect(jan).toMatchObject({ status: 'closed', remaining: 0, consistent: true });
    expect(a.ledger.filter((e: any) => e.type === 'expire')).toHaveLength(1);
    expect(a.ledger.find((e: any) => e.type === 'expire').delta).toBe(-3);
    const cr = await ok(owner.get(`/api/v1/plans/${carry.id}`));
    // 1月: 2 付与 − 1 調整 = 1 → 上限1まで繰越
    expect(cr.ledger.filter((e: any) => e.type === 'carryover_out')).toHaveLength(1);
    expect(cr.ledger.filter((e: any) => e.type === 'carryover_in')).toHaveLength(1);
    const feb = cr.periods.find((p: any) => p.start === '2030-02-01');
    expect(feb).toMatchObject({ remaining: 3, consistent: true }); // 2 付与 + 1 繰越
    expect(cr.currentPeriod).toMatchObject({ start: '2030-02-01', remaining: 3 });
    await setClock('2030-01-07T00:00:00Z');
  });

  it('契約終了: 終了日までは利用可、解約は即時停止、延長は不可', async () => {
    const c = await newCustomer('end');
    const p = await ok(owner.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    const r = await ok(owner.post(`/api/v1/plans/${p.id}/end`, { endsOn: '2030-01-20', status: 'ended', reason: '退会' }));
    expect(r.status).toBe('active'); // 終了日までは使える
    const b = await bookFor(c, D2, '20:00');
    const comp = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp.candidates.plans.map((x: any) => x.id)).toContain(p.id);
    expectError(await owner.post(`/api/v1/plans/${p.id}/end`, { endsOn: '2030-03-31', status: 'ended' }), 400, 'VALIDATION_ERROR');
    const cancel = await ok(owner.post(`/api/v1/plans/${p.id}/end`, { endsOn: '2030-01-15', status: 'canceled', reason: '解約' }));
    expect(cancel.status).toBe('canceled');
    const comp2 = await ok(owner.get(`/api/v1/bookings/${b.id}/completion`));
    expect(comp2.candidates.plans).toEqual([]);
    expectError(await owner.post(`/api/v1/plans/${p.id}/end`, { endsOn: '2030-01-14', status: 'ended' }), 409, 'INVALID_STATE');
  });
});

describe('#18 顧客統合後も回数券台帳・消化の紐付けが保たれる', () => {
  it('統合で回数券が統合先に移り、台帳・予約の消化参照・残数が一致', async () => {
    const email = `merge-${idem('m')}@cust.example`;
    const a = await newCustomer('merge-a', email);
    const b = await newCustomer('merge-b', `other-${idem('m')}@cust.example`);
    const p = await grant(b, pass8, '2030-01-07');
    const bk = await bookFor(b, D3, '20:00');
    await ok(owner.post(`/api/v1/bookings/${bk.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('u') } }));
    const before = await passState(p.id);
    const m = await ok(owner.post(`/api/v1/customers/${a}/merge`, { mergeFromId: b, confirm: true, reason: '同一人物' }));
    expect(m.moved.passes).toBe(1);
    const after = await passState(p.id);
    expect(after.customerId).toBe(a);
    expect(after.remaining).toBe(7);
    expect(after.ledger.map((e: any) => e.id)).toEqual(before.ledger.map((e: any) => e.id));
    expect(after.consistent).toBe(true);
    const booking = await ok(owner.get(`/api/v1/bookings/${bk.id}`));
    expect(booking.customerId).toBe(a);
    const passes = await ok(owner.get(`/api/v1/customers/${a}/passes`));
    expect(passes.items.map((x: any) => x.id)).toContain(p.id);
    // 統合先で引き続き利用できる
    const bk2 = await bookFor(a, D3, '09:00');
    const comp = await ok(owner.get(`/api/v1/bookings/${bk2.id}/completion`));
    expect(comp.candidates.passes.map((x: any) => x.id)).toContain(p.id);
  });
});

describe('Phase4: 完了・実施記録・次回予約・受付', () => {
  it('実施記録: メモは記録権限者のみ。受付は内部メモを見られない', async () => {
    const c = await newCustomer('record');
    const b = await bookFor(c, D, '09:00', cat.services.personal60, cat.staff.aki);
    const done = await ok(staff.post(`/api/v1/bookings/${b.id}/complete`, { record: { internalMemo: '内部メモ', customerMemo: 'お客様向け' } }));
    const recs = await ok(staff.get(`/api/v1/records?customerId=${c}`));
    expect(recs.items[0]).toMatchObject({ id: done.recordId, internalMemo: '内部メモ', customerMemo: 'お客様向け' });
    const rc = await ok(reception.get(`/api/v1/bookings/${b.id}/completion`));
    expect(rc.record.internalMemo).toBeUndefined();
    expectError(await reception.get(`/api/v1/records?customerId=${c}`), 403, 'FORBIDDEN');
    // Staff は他スタッフの予約の記録を編集できない
    const other = await bookFor(c, D, '11:00');
    const od = await ok(owner.post(`/api/v1/bookings/${other.id}/complete`, {}));
    const rec = (await ok(owner.get(`/api/v1/records?customerId=${c}`))).items.find((r: any) => r.id === od.recordId);
    expectError(await staff.patch(`/api/v1/records/${od.recordId}`, { expectedVersion: rec.version, internalMemo: 'x' }), 404, 'NOT_FOUND');
  });

  it('実施取消: 消化を戻す/戻さないを明示。戻す場合は +1、予約は対応中へ', async () => {
    const c = await newCustomer('void');
    const p = await grant(c, pass8, '2030-01-07');
    const b = await bookFor(c, D2, '09:00');
    const done = await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('u') } }));
    expectError(await staff.post(`/api/v1/records/${done.recordId}/void`, { reason: '誤操作', reverseConsumption: true }), 403, 'FORBIDDEN');
    const v = await ok(owner.post(`/api/v1/records/${done.recordId}/void`, { reason: '誤操作', reverseConsumption: true }));
    expect(v.reversed).toBe(true);
    expect((await passState(p.id)).remaining).toBe(8);
    const bk = await ok(owner.get(`/api/v1/bookings/${b.id}`));
    expect(bk.status).toBe('in_service');
    // 再完了で新しい実施記録
    const again = await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('u') } }));
    expect(again.recordId).not.toBe(done.recordId);
    const v2 = await ok(owner.post(`/api/v1/records/${again.recordId}/void`, { reason: '記録のみ取消', reverseConsumption: false }));
    expect(v2.reversed).toBe(false);
    expect((await passState(p.id)).remaining).toBe(7);
  });

  it('次回予約: 完了した予約から作成すると実施記録に紐付く', async () => {
    const c = await newCustomer('next');
    const b = await bookFor(c, D, '15:00');
    const done = await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, { record: { nextRecommendedOn: '2030-01-24' } }));
    const next = await ok(
      owner.post('/api/v1/bookings', {
        locationId: IKE,
        serviceId: cat.services.personal60,
        staffId: cat.staff.mika,
        startsAt: at(D3, '11:00'),
        customer: { customerId: c },
        previousBookingId: b.id,
        idempotencyKey: idem('n'),
      }),
    );
    expect(next.previousBookingId).toBe(b.id);
    const rec = (await ok(owner.get(`/api/v1/records?customerId=${c}`))).items.find((r: any) => r.id === done.recordId);
    expect(rec.nextBookingId).toBe(next.id);
  });

  it('締切後キャンセル/無断欠席: 自動では消化しない。確認待ち → 管理者が消化 or 消化しない', async () => {
    await ok(owner.patch('/api/v1/org', { settings: { lateCancelPolicy: 'confirm' } }));
    const c = await newCustomer('late');
    const p = await grant(c, pass8, '2030-01-07');
    const b1 = await bookFor(c, D, '18:00');
    const b2 = await bookFor(c, D, '19:00');
    const b3 = await bookFor(c, D, '20:00');
    await setClock(at(D, '09:00')); // 開始の24時間以内
    const canceled = await ok(owner.post(`/api/v1/bookings/${b1.id}/cancel`, { by: 'customer', reason: '体調不良' }));
    expect(canceled).toMatchObject({ status: 'canceled_customer', cancelLate: true, consumptionReview: 'pending' });
    expect((await passState(p.id)).remaining).toBe(8); // 自動では減らない
    // 受付は判断できない(確認はオーナー/マネージャー)
    expectError(await reception.post(`/api/v1/bookings/${b1.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x') }), 403, 'FORBIDDEN');
    const r = await ok(manager.post(`/api/v1/bookings/${b1.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x'), reason: '規約に基づき消化' }));
    expect(r.balanceAfter).toBe(7);
    expect((await ok(owner.get(`/api/v1/bookings/${b1.id}`))).consumptionReview).toBe('consumed');
    // 無断欠席 → 確認待ち → 消化しない
    await setClock(at(D, '19:30'));
    const ns = await ok(owner.post(`/api/v1/bookings/${b2.id}/status`, { to: 'no_show' }));
    expect(ns.consumptionReview).toBe('pending');
    await ok(owner.post(`/api/v1/bookings/${b2.id}/consumption/waive`, { reason: '初回のため' }));
    expect((await ok(owner.get(`/api/v1/bookings/${b2.id}`))).consumptionReview).toBe('waived');
    expectError(await owner.post(`/api/v1/bookings/${b2.id}/consume`, { kind: 'pass', entitlementId: p.id, idempotencyKey: idem('x') }), 409, 'INVALID_STATE');
    // 店舗都合キャンセルは確認対象外
    const biz = await ok(owner.post(`/api/v1/bookings/${b3.id}/cancel`, { by: 'business', reason: '設備故障' }));
    expect(biz.consumptionReview).toBeNull();
    expect((await passState(p.id)).remaining).toBe(7);
    // 既定値(confirm)のまま
    await setClock('2030-01-07T00:00:00Z');
  });

  it('受付ボード: 担当拠点の当日予約のみ、内部メモなし。他拠点は見えない', async () => {
    const c = await newCustomer('board');
    const b = await ok(
      owner.post('/api/v1/bookings', {
        locationId: IKE,
        serviceId: cat.services.trial30,
        staffId: cat.staff.mika,
        startsAt: at(D2, '11:00'),
        customer: { customerId: c },
        internalNote: '受付に見せない',
        idempotencyKey: idem('r'),
      }),
    );
    const board = await ok(reception.get(`/api/v1/reception/board?locationId=${IKE}&date=${D2}`));
    const item = board.items.find((x: any) => x.id === b.id);
    expect(item).toBeTruthy();
    expect(item.internalNote).toBeUndefined();
    expect(board.items.every((x: any) => x.locationId === IKE)).toBe(true);
    expect(board.counts.confirmed).toBeGreaterThan(0);
    expectError(await reception.get(`/api/v1/reception/board?locationId=${SHIN}&date=${D2}`), 404, 'NOT_FOUND');
    expectError(await staff.get(`/api/v1/reception/board?locationId=${IKE}&date=${D2}`), 403, 'FORBIDDEN');
    // 受付で来店 → 対応中
    await ok(reception.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived' }));
    await ok(reception.post(`/api/v1/bookings/${b.id}/status`, { to: 'in_service' }));
  });

  it('今日の予定: Staff は自分の予約だけ(全拠点)、Manager は拠点指定', async () => {
    await setClock(at(D, '08:00'));
    const mine = await ok(staff.get('/api/v1/today'));
    expect(mine.date).toBe(D);
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((x: any) => x.staffId === cat.staff.aki)).toBe(true);
    expectError(await manager.get('/api/v1/today'), 400, 'VALIDATION_ERROR');
    const mgr = await ok(manager.get(`/api/v1/today?locationId=${IKE}`));
    expect(mgr.items.every((x: any) => x.locationId === IKE)).toBe(true);
    expectError(await manager.get(`/api/v1/today?locationId=${SHIN}`), 404, 'NOT_FOUND');
    await setClock('2030-01-07T00:00:00Z');
  });
});

describe('回数券/プランの権限', () => {
  it('Staff は付与・調整できない。受付は付与できるが調整できない', async () => {
    const c = await newCustomer('rbac');
    expectError(await staff.post(`/api/v1/customers/${c}/passes`, { passProductId: pass8, idempotencyKey: idem('g') }), 403, 'FORBIDDEN');
    // 受付は担当拠点で予約のある顧客のみ見える
    const b = await bookFor(c, D2, '17:00');
    const g = await ok(reception.post(`/api/v1/customers/${c}/passes`, { passProductId: pass8, idempotencyKey: idem('g') }));
    expect(g.remaining).toBe(8);
    expectError(await reception.post(`/api/v1/passes/${g.id}/adjust`, { type: 'manual_add', delta: 1, reason: 'x', idempotencyKey: idem('a') }), 403, 'FORBIDDEN');
    expectError(await staff.post('/api/v1/pass-products', { name: 'x', totalUses: 1 }), 403, 'FORBIDDEN');
    const pl = await ok(reception.post(`/api/v1/customers/${c}/plans`, { planProductId: plan4, startsOn: '2030-01-01', idempotencyKey: idem('p') }));
    expect(pl.created).toBe(true);
    expectError(await reception.post(`/api/v1/plans/${pl.id}/adjust`, { type: 'manual_add', delta: 1, reason: 'x', idempotencyKey: idem('a') }), 403, 'FORBIDDEN');
    // Staff は他スタッフ(Mika)の予約を消化できない
    await ok(owner.post(`/api/v1/bookings/${b.id}/complete`, {}));
    expectError(await staff.post(`/api/v1/bookings/${b.id}/consume`, { kind: 'pass', entitlementId: g.id, idempotencyKey: idem('u') }), 404, 'NOT_FOUND');
  });

  it('別組織の回数券・プランには触れない', async () => {
    const other = await createOrgFixture(t.pool);
    const otherOwner = await login(t.app, other.users.owner.email);
    const c = await newCustomer('tenant');
    const p = await grant(c, pass8);
    expectError(await otherOwner.get(`/api/v1/passes/${p.id}`), 404, 'NOT_FOUND');
    expectError(await otherOwner.post(`/api/v1/passes/${p.id}/adjust`, { type: 'manual_add', delta: 5, reason: 'x', idempotencyKey: idem('a') }), 404, 'NOT_FOUND');
    const list = await ok(otherOwner.get('/api/v1/passes?status=all'));
    expect(list.items).toEqual([]);
    const rows = await withSystem(t.pool, (q) => q.many('SELECT id FROM pass_ledger_entries WHERE customer_pass_id = $1', [p.id]));
    expect(rows).toHaveLength(1);
  });
});
