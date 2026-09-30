/**
 * サンプル組織の過去データ(サンプル組織説明.txt と対応)。
 * 予約エンジン・完了処理・台帳を通して作るため、残数は台帳から再現できる。
 * - 常連 太郎: 池袋で4回完了(実施記録あり)
 * - 残一 次郎: 8回券を7回利用 → 残1回
 * - 期限 美咲: 8回券(期限が約9日後)を3回利用 → 残5回。締切後キャンセル1件が「消化の確認待ち」
 * - 欠席 健一: 無断欠席1件・完了1件
 * - 会員 由美: 月4回プラン。先月4回利用、今月は利用あり
 */
import type pg from 'pg';
import { addDays, isoWeekday, localToUtcLenient, startOfMonth, todayIn, addMonthsClamped } from '../../shared/time.js';
import type { Actor } from '../audit.js';
import { withSystemForOrg, type Q } from '../db/tx.js';
import type { Deps } from '../deps.js';
import { type BookingActor, type BookingRow, cancelBooking, changeStatus, createBooking } from '../modules/bookings/service.js';
import { assignPlan, closePlanPeriods, grantPass } from '../modules/entitlements/ledger.js';
import { completeBooking } from '../modules/records/service.js';
import type { SampleIds } from './seed.js';

const TZ = 'Asia/Tokyo';

export async function sampleExtras(pool: pg.Pool, deps: Deps, ids: SampleIds, now: Date): Promise<void> {
  const today = todayIn(TZ, now);
  const at = (d: string, t: string) => localToUtcLenient(d, t, TZ);
  const depsAt = (d: Date): Deps => ({ ...deps, clock: { now: () => d } });
  const actor: BookingActor = { actor: { type: 'operator', label: 'サンプル投入' }, membershipId: null, mode: 'staff', canForce: true };
  const recordActor = { ...actor, canWriteRecord: true, canConsume: true };
  const op: Actor = { type: 'operator', label: 'サンプル投入' };
  let seq = 0;

  /** 指定曜日(1=月…7=日)のうち date 以前で最も近い日 */
  const onOrBefore = (date: string, weekdays: number[]) => {
    let d = date;
    while (!weekdays.includes(isoWeekday(d))) d = addDays(d, -1);
    return d;
  };

  await withSystemForOrg(pool, ids.orgId, async (q: Q) => {
    // ---- 回数券・利用プランの種類 ----
    const pass8 = await q.one<{ id: string }>(
      `INSERT INTO pass_products (organization_id, name, description, total_uses, validity_days, all_services, sort_order)
       VALUES ($1, '8回券', '60分パーソナル 8回分(180日間有効)', 8, 180, false, 0) RETURNING id`,
      [ids.orgId],
    );
    await q.exec('INSERT INTO pass_product_services (organization_id, pass_product_id, service_id) VALUES ($1,$2,$3)', [ids.orgId, pass8.id, ids.services.personal60]);
    const plan4 = await q.one<{ id: string }>(
      `INSERT INTO plan_products (organization_id, name, description, uses_per_period, period_months, alignment, carryover_enabled, all_services, sort_order)
       VALUES ($1, '月4回', '6名ヨガ・60分パーソナルを月4回まで(繰越なし)', 4, 1, 'calendar', false, false, 0) RETURNING id`,
      [ids.orgId],
    );
    for (const s of [ids.services.yoga6, ids.services.personal60]) {
      await q.exec('INSERT INTO plan_product_services (organization_id, plan_product_id, service_id) VALUES ($1,$2,$3)', [ids.orgId, plan4.id, s]);
    }

    const past = async (p: { location: string; service: string; staff: string; date: string; time: string; customer: string }): Promise<BookingRow> => {
      const start = at(p.date, p.time);
      const r = await createBooking(q, depsAt(new Date(start.getTime() - 3 * 86400_000)), ids.orgId, actor, {
        locationId: p.location,
        serviceId: p.service,
        staffId: p.staff,
        startsAt: start,
        partySize: 1,
        customer: { customerId: p.customer },
        channel: 'staff',
        idempotencyKey: `sample-past-${++seq}`,
      });
      return r.booking;
    };
    const complete = async (b: BookingRow, record: { internalMemo?: string; customerMemo?: string } = {}, consume?: { kind: 'pass' | 'plan'; entitlementId: string }) => {
      await changeStatus(q, depsAt(new Date(b.starts_at.getTime() - 5 * 60000)), ids.orgId, actor, b.id, 'arrived');
      await completeBooking(q, depsAt(b.ends_at), ids.orgId, recordActor, b.id, {
        record: { startedAt: b.starts_at, endedAt: b.ends_at, internalMemo: record.internalMemo ?? null, customerMemo: record.customerMemo ?? null },
        consume: consume ? { ...consume, idempotencyKey: `sample-use-${++seq}` } : null,
      });
    };

    // ---- 常連 太郎: 池袋 Mika(火〜日)で4回 ----
    const memos = ['姿勢の確認と体幹トレーニング', '肩周りの可動域を中心に', '下半身のトレーニングを追加', 'フォームが安定してきた'];
    for (let i = 0; i < 4; i++) {
      const d = onOrBefore(addDays(today, -7 * (4 - i)), [2, 3, 4, 5, 6, 7]);
      const b = await past({ location: ids.locations.ikebukuro, service: ids.services.personal60, staff: ids.staff.mika, date: d, time: '11:00', customer: ids.customers.repeater });
      await complete(b, { internalMemo: memos[i], customerMemo: '自宅でのストレッチを続けてください' });
    }

    // ---- 残一 次郎: 8回券を7回利用 → 残1 ----
    const jiroPass = await grantPass(q, ids.orgId, op, {
      customerId: ids.customers.lastOne,
      passProductId: pass8.id,
      startsOn: addDays(today, -60),
      memo: '店頭で購入(サンプル)',
      idempotencyKey: 'sample-grant-jiro',
    });
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, -56 + i * 7);
      const b = await past({ location: ids.locations.shinjuku, service: ids.services.personal60, staff: ids.staff.ken, date: d, time: '10:00', customer: ids.customers.lastOne });
      await complete(b, { internalMemo: `${i + 1}回目` }, { kind: 'pass', entitlementId: jiroPass.passId });
    }

    // ---- 期限 美咲: 期限が約9日後の8回券を3回利用 → 残5、締切後キャンセル1件(確認待ち) ----
    const misakiPass = await grantPass(q, ids.orgId, op, {
      customerId: ids.customers.expiring,
      passProductId: pass8.id,
      startsOn: addDays(today, -170),
      idempotencyKey: 'sample-grant-misaki',
    });
    for (const offset of [-30, -20, -10]) {
      const b = await past({ location: ids.locations.shinjuku, service: ids.services.personal60, staff: ids.staff.ken, date: addDays(today, offset), time: '12:00', customer: ids.customers.expiring });
      await complete(b, {}, { kind: 'pass', entitlementId: misakiPass.passId });
    }
    const lateDay = addDays(today, -3);
    const late = await past({ location: ids.locations.shinjuku, service: ids.services.personal60, staff: ids.staff.ken, date: lateDay, time: '12:00', customer: ids.customers.expiring });
    await cancelBooking(q, depsAt(new Date(late.starts_at.getTime() - 2 * 3600_000)), ids.orgId, actor, late.id, { by: 'customer', reason: '急用のため(サンプル)' });

    // ---- 欠席 健一: 完了1件・無断欠席1件 ----
    const kenichiDone = await past({
      location: ids.locations.ikebukuro,
      service: ids.services.trial30,
      staff: ids.staff.mika,
      date: onOrBefore(addDays(today, -21), [2, 3, 4, 5, 6, 7]),
      time: '15:00',
      customer: ids.customers.noShow,
    });
    await complete(kenichiDone, { internalMemo: '体験。次回はパーソナルを検討' });
    const noShow = await past({
      location: ids.locations.ikebukuro,
      service: ids.services.trial30,
      staff: ids.staff.mika,
      date: onOrBefore(addDays(today, -14), [2, 3, 4, 5, 6, 7]),
      time: '15:00',
      customer: ids.customers.noShow,
    });
    await changeStatus(q, depsAt(new Date(noShow.starts_at.getTime() + 30 * 60000)), ids.orgId, actor, noShow.id, 'no_show');

    // ---- 会員 由美: 月4回(先月から契約)。先月4回、今月は今日より前の日に最大2回 ----
    const lastMonth = startOfMonth(addMonthsClamped(today, -1));
    const plan = await assignPlan(q, ids.orgId, op, {
      customerId: ids.customers.planMember,
      planProductId: plan4.id,
      startsOn: lastMonth,
      memo: '月会費は店頭で受領(サンプル。請求機能はありません)',
      idempotencyKey: 'sample-plan-yumi',
    });
    const yumiDays = [3, 10, 17, 24].map((n) => addDays(lastMonth, n));
    const thisMonth = startOfMonth(today);
    for (const n of [2, 9]) {
      const d = addDays(thisMonth, n);
      if (d < today) yumiDays.push(d);
    }
    for (const d of yumiDays) {
      const b = await past({ location: ids.locations.shinjuku, service: ids.services.yoga6, staff: ids.staff.ken, date: d, time: '11:00', customer: ids.customers.planMember });
      await complete(b, {}, { kind: 'plan', entitlementId: plan.planId });
    }
    // 終了した期間を締める(繰越なし → 残りは失効)
    await closePlanPeriods(q, ids.orgId, today);
  });
}
