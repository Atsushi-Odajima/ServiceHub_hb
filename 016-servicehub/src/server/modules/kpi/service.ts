/**
 * 運営KPI(CALCULATION_RULES.md)。
 * - 期間 [from, to] は拠点ローカル日付(両端含む)。予約は開始時刻の拠点ローカル日付で期間に属する
 * - 率は分子・分母を返し、分母0は null(0 と表示しない)
 * - 拠点ごとに集計して合算(予約・占有・勤務は1拠点にのみ属するため二重計上しない)
 */
import { addDays, localDayRange, todayIn } from '../../../shared/time.js';
import type { Q } from '../../db/tx.js';

export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
}

export function rate(numerator: number, denominator: number): Rate {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

export interface BookingKpi {
  total: number;
  confirmed: number;
  arrivedOrInService: number;
  completed: number;
  canceledCustomer: number;
  canceledBusiness: number;
  noShow: number;
  persons: number;
  completionRate: Rate;
  noShowRate: Rate;
  cancelRateCustomer: Rate;
  cancelRateBusiness: Rate;
}

function bookingKpi(c: Record<string, { n: number; persons: number }>): BookingKpi {
  const g = (s: string) => c[s]?.n ?? 0;
  const total = Object.values(c).reduce((s, x) => s + x.n, 0);
  const cancels = g('canceled_customer') + g('canceled_business');
  const effective = total - cancels;
  return {
    total,
    confirmed: g('confirmed'),
    arrivedOrInService: g('arrived') + g('in_service'),
    completed: g('completed'),
    canceledCustomer: g('canceled_customer'),
    canceledBusiness: g('canceled_business'),
    noShow: g('no_show'),
    persons: c.completed?.persons ?? 0,
    completionRate: rate(g('completed'), effective),
    noShowRate: rate(g('no_show'), effective),
    cancelRateCustomer: rate(g('canceled_customer'), total),
    cancelRateBusiness: rate(g('canceled_business'), total),
  };
}

function sumCounts(list: Record<string, { n: number; persons: number }>[]): Record<string, { n: number; persons: number }> {
  const out: Record<string, { n: number; persons: number }> = {};
  for (const c of list) {
    for (const [k, v] of Object.entries(c)) {
      out[k] = { n: (out[k]?.n ?? 0) + v.n, persons: (out[k]?.persons ?? 0) + v.persons };
    }
  }
  return out;
}

// ---------------- 区間計算(ミリ秒) ----------------
export type Iv = [number, number];

export function mergeIvs(list: Iv[]): Iv[] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** base − cut(どちらも結合済みであること) */
export function subtractIvs(base: Iv[], cut: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const [a0, b0] of base) {
    let pieces: Iv[] = [[a0, b0]];
    for (const [c, d] of cut) {
      const next: Iv[] = [];
      for (const [a, b] of pieces) {
        if (d <= a || c >= b) next.push([a, b]);
        else {
          if (c > a) next.push([a, c]);
          if (d < b) next.push([d, b]);
        }
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

export function overlapLen(ivs: Iv[], [a, b]: Iv): number {
  let n = 0;
  for (const [c, d] of ivs) n += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return n;
}

export const totalLen = (ivs: Iv[]) => ivs.reduce((s, [a, b]) => s + (b - a), 0);

/**
 * スタッフ稼働率(CALCULATION_RULES.md §5)の純粋計算。
 * available = work(拠点)を結合 − 非勤務(休憩・休暇・研修・他業務・予約不可)を結合
 * occupied = 各占有のサービス時間(buffer除く)と available の重なり。1分でもはみ出す占有は「シフト外予約」として数える
 */
export function utilizationOf(work: Iv[], nonWork: Iv[], occupancies: Iv[], range: Iv): { availableMin: number; occupiedMin: number; outsideShift: number } {
  const clip = (ivs: Iv[]) => ivs.map(([a, b]) => [Math.max(a, range[0]), Math.min(b, range[1])] as Iv);
  const available = subtractIvs(mergeIvs(clip(work)), mergeIvs(clip(nonWork)));
  let occupied = 0;
  let outside = 0;
  for (const o of occupancies) {
    const len = overlapLen(available, o);
    occupied += len;
    if (len < o[1] - o[0]) outside++;
  }
  return { availableMin: Math.round(totalLen(available) / 60000), occupiedMin: Math.round(occupied / 60000), outsideShift: outside };
}

// ---------------- 集計 ----------------
export interface KpiOptions {
  from: string;
  to: string;
  /** null = 全拠点(Owner) */
  locationIds: string[] | null;
  /** 顧客に紐づく指標の可視性。params(クエリの既存パラメータ)に必要な値を追加し、alias c に対する SQL 条件を返す */
  customerVis: (params: unknown[]) => Promise<string>;
  orgTimezone: string;
  now: Date;
}

const OCCUPYING = ['completed', 'in_service', 'arrived', 'confirmed', 'no_show'];

export async function computeKpi(q: Q, orgId: string, o: KpiOptions) {
  const locs = await q.many<{ id: string; name: string; timezone: string }>(
    `SELECT id, name, timezone FROM locations WHERE organization_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) AND status <> 'archived' ORDER BY sort_order, name`,
    [orgId, o.locationIds],
  );
  const ranges = locs.map((l) => ({ ...l, start: localDayRange(o.from, l.timezone).start, end: localDayRange(o.to, l.timezone).end }));
  const orgRange = { start: localDayRange(o.from, o.orgTimezone).start, end: localDayRange(o.to, o.orgTimezone).end };
  const locIds = ranges.map((r) => r.id);
  const starts = ranges.map((r) => r.start);
  const ends = ranges.map((r) => r.end);

  // ---- 予約(拠点ごと → 合算) ----
  const byLocRows = await q.many<{ location_id: string; status: string; n: number; persons: number }>(
    `SELECT b.location_id, b.status, count(*)::int AS n, coalesce(sum(b.party_size), 0)::int AS persons
       FROM bookings b JOIN unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS r(location_id, s, e) ON b.location_id = r.location_id
      WHERE b.organization_id = $1 AND b.starts_at >= r.s AND b.starts_at < r.e
      GROUP BY b.location_id, b.status`,
    [orgId, locIds, starts, ends],
  );
  const countsByLoc = new Map<string, Record<string, { n: number; persons: number }>>();
  for (const r of byLocRows) {
    const m = countsByLoc.get(r.location_id) ?? {};
    m[r.status] = { n: r.n, persons: r.persons };
    countsByLoc.set(r.location_id, m);
  }

  // ---- スタッフ稼働率(拠点ごと) ----
  const minStart = new Date(Math.min(...starts.map((d) => d.getTime()), orgRange.start.getTime()));
  const maxEnd = new Date(Math.max(...ends.map((d) => d.getTime()), orgRange.end.getTime()));
  const shifts = locIds.length
    ? await q.many<{ staff_id: string; location_id: string | null; shift_type: string; starts_at: Date; ends_at: Date }>(
        `SELECT staff_id, location_id, shift_type, starts_at, ends_at FROM staff_shifts
          WHERE organization_id = $1 AND starts_at < $3 AND ends_at > $2`,
        [orgId, minStart, maxEnd],
      )
    : [];
  const occ = locIds.length
    ? await q.many<{ id: string; staff_id: string; location_id: string; starts_at: Date; ends_at: Date }>(
        `SELECT DISTINCT o.id, o.staff_id, o.location_id, o.starts_at, o.ends_at
           FROM bookings b JOIN unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS r(location_id, s, e) ON b.location_id = r.location_id
           JOIN occupancies o ON o.id = b.occupancy_id AND o.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.starts_at >= r.s AND b.starts_at < r.e AND b.status = ANY($5::text[]) AND o.staff_id IS NOT NULL`,
        [orgId, locIds, starts, ends, OCCUPYING],
      )
    : [];
  const staffNames = new Map(
    (await q.many<{ id: string; display_name: string; status: string }>('SELECT id, display_name, status FROM staff WHERE organization_id = $1', [orgId])).map((s) => [s.id, s]),
  );
  const iv = (a: Date, b: Date): Iv => [a.getTime(), b.getTime()];
  const staffRows: { staffId: string; name: string; locationId: string; availableMin: number; occupiedMin: number; outsideShift: number }[] = [];
  for (const r of ranges) {
    const staffIds = new Set([
      ...shifts.filter((s) => s.shift_type === 'work' && s.location_id === r.id).map((s) => s.staff_id),
      ...occ.filter((x) => x.location_id === r.id).map((x) => x.staff_id),
    ]);
    for (const sid of staffIds) {
      const work = shifts.filter((s) => s.staff_id === sid && s.shift_type === 'work' && s.location_id === r.id).map((s) => iv(s.starts_at, s.ends_at));
      const nonWork = shifts.filter((s) => s.staff_id === sid && s.shift_type !== 'work').map((s) => iv(s.starts_at, s.ends_at));
      const mine = occ.filter((x) => x.staff_id === sid && x.location_id === r.id).map((x) => iv(x.starts_at, x.ends_at));
      const u = utilizationOf(work, nonWork, mine, iv(r.start, r.end));
      staffRows.push({ staffId: sid, name: staffNames.get(sid)?.display_name ?? '(削除済み)', locationId: r.id, ...u });
    }
  }
  const utilRate = (rows: typeof staffRows) => {
    const a = rows.reduce((s, x) => s + x.availableMin, 0);
    const b = rows.reduce((s, x) => s + x.occupiedMin, 0);
    return { availableMin: a, occupiedMin: b, outsideShift: rows.reduce((s, x) => s + x.outsideShift, 0), utilization: rate(b, a) };
  };

  // ---- サービス別(完了) ----
  const services = locIds.length
    ? await q.many<{ service_id: string; name: string; n: number; persons: number }>(
        `SELECT b.service_id, s.name, count(*)::int AS n, coalesce(sum(b.party_size), 0)::int AS persons
           FROM bookings b JOIN unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS r(location_id, s, e) ON b.location_id = r.location_id
           JOIN services s ON s.id = b.service_id AND s.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.starts_at >= r.s AND b.starts_at < r.e AND b.status = 'completed'
          GROUP BY b.service_id, s.name ORDER BY n DESC, s.name`,
        [orgId, locIds, starts, ends],
      )
    : [];

  // ---- 顧客(新規・リピーター。人数は重複なし。境界は組織のタイムゾーン) ----
  const cust = await q.one<{ new_customers: number; repeaters: number; customers: number }>(
    `WITH pc AS (
       SELECT DISTINCT b.customer_id FROM bookings b
        WHERE b.organization_id = $1 AND b.status = 'completed' AND b.starts_at >= $2 AND b.starts_at < $3
          AND ($4::uuid[] IS NULL OR b.location_id = ANY($4::uuid[]))
     ), f AS (
       SELECT b.customer_id, min(b.starts_at) AS first_at FROM bookings b JOIN pc ON pc.customer_id = b.customer_id
        WHERE b.organization_id = $1 AND b.status = 'completed' GROUP BY b.customer_id
     )
     SELECT count(*)::int AS customers, count(*) FILTER (WHERE first_at >= $2)::int AS new_customers, count(*) FILTER (WHERE first_at < $2)::int AS repeaters FROM f`,
    [orgId, orgRange.start, orgRange.end, o.locationIds],
  );

  // ---- 回数券・利用プラン ----
  const passParams: unknown[] = [orgId, orgRange.start, orgRange.end, o.locationIds];
  const passVis = await o.customerVis(passParams);
  const passUse = await q.one<{ uses: number; reversals: number; expired: number }>(
    `SELECT count(*) FILTER (WHERE l.entry_type = 'use')::int AS uses,
            count(*) FILTER (WHERE l.entry_type = 'use_reversal')::int AS reversals,
            coalesce(-sum(l.delta) FILTER (WHERE l.entry_type = 'expire'), 0)::int AS expired
       FROM pass_ledger_entries l
       LEFT JOIN bookings b ON b.id = l.booking_id AND b.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.created_at >= $2 AND l.created_at < $3
        AND ($4::uuid[] IS NULL OR b.location_id = ANY($4::uuid[]) OR (l.booking_id IS NULL AND EXISTS (
              SELECT 1 FROM customer_passes cp2 JOIN customers c ON c.id = cp2.customer_id WHERE cp2.id = l.customer_pass_id AND ${passVis})))`,
    passParams,
  );
  const today = todayIn(o.orgTimezone, o.now);
  const expParams: unknown[] = [orgId, today, addDays(today, 30)];
  const expVis = await o.customerVis(expParams);
  const expiring = await q.one<{ n: number; remaining: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(cp.remaining), 0)::int AS remaining
       FROM customer_passes cp JOIN customers c ON c.id = cp.customer_id
      WHERE cp.organization_id = $1 AND cp.status = 'active' AND cp.remaining > 0 AND cp.expires_on BETWEEN $2::date AND $3::date AND ${expVis}`,
    expParams,
  );
  const planParams: unknown[] = [orgId, today];
  const planVis = await o.customerVis(planParams);
  const plan = await q.one<{ granted: number; used: number; remaining: number; plans: number }>(
    `SELECT count(DISTINCT p.id)::int AS plans,
            coalesce(sum(x.granted), 0)::int AS granted, coalesce(sum(x.used), 0)::int AS used, coalesce(sum(pp.remaining), 0)::int AS remaining
       FROM customer_plans p JOIN customers c ON c.id = p.customer_id
       JOIN customer_plan_periods pp ON pp.customer_plan_id = p.id AND pp.period_start <= $2::date AND pp.period_end >= $2::date
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(l.delta) FILTER (WHERE l.delta > 0 AND l.entry_type <> 'use_reversal'), 0) AS granted,
                coalesce(-sum(l.delta) FILTER (WHERE l.entry_type = 'use'), 0) - coalesce(sum(l.delta) FILTER (WHERE l.entry_type = 'use_reversal'), 0) AS used
           FROM plan_ledger_entries l WHERE l.customer_plan_period_id = pp.id
       ) x
      WHERE p.organization_id = $1 AND p.status = 'active' AND ${planVis}`,
    planParams,
  );

  // ---- 待機・通知 ----
  const wl = await q.one<{ waiting: number; converted: number }>(
    `SELECT count(*) FILTER (WHERE e.status IN ('waiting','notified'))::int AS waiting,
            count(*) FILTER (WHERE e.status = 'booked' AND b.created_at >= $2 AND b.created_at < $3)::int AS converted
       FROM waitlist_entries e LEFT JOIN bookings b ON b.id = e.booked_booking_id AND b.organization_id = e.organization_id
      WHERE e.organization_id = $1 AND ($4::uuid[] IS NULL OR e.location_id = ANY($4::uuid[]))`,
    [orgId, orgRange.start, orgRange.end, o.locationIds],
  );
  const failed = await q.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE organization_id = $1 AND status = 'failed' AND created_at >= $2 AND created_at < $3
        AND ($4::uuid[] IS NULL OR location_id = ANY($4::uuid[]))`,
    [orgId, orgRange.start, orgRange.end, o.locationIds],
  );

  const perLocation = ranges.map((r) => {
    const rows = staffRows.filter((s) => s.locationId === r.id);
    return { locationId: r.id, name: r.name, timezone: r.timezone, bookings: bookingKpi(countsByLoc.get(r.id) ?? {}), staff: utilRate(rows) };
  });
  // スタッフ別(全拠点合計。勤務・占有は1拠点に属するため単純合計で二重計上なし)
  const byStaff = new Map<string, { staffId: string; name: string; availableMin: number; occupiedMin: number; outsideShift: number; locations: string[] }>();
  for (const s of staffRows) {
    const cur = byStaff.get(s.staffId) ?? { staffId: s.staffId, name: s.name, availableMin: 0, occupiedMin: 0, outsideShift: 0, locations: [] };
    cur.availableMin += s.availableMin;
    cur.occupiedMin += s.occupiedMin;
    cur.outsideShift += s.outsideShift;
    cur.locations.push(s.locationId);
    byStaff.set(s.staffId, cur);
  }
  return {
    period: { from: o.from, to: o.to, today },
    locations: ranges.map((r) => ({ id: r.id, name: r.name, timezone: r.timezone })),
    bookings: bookingKpi(sumCounts(ranges.map((r) => countsByLoc.get(r.id) ?? {}))),
    byLocation: perLocation,
    staff: {
      ...utilRate(staffRows),
      rows: [...byStaff.values()]
        .map((s) => ({ ...s, utilization: rate(s.occupiedMin, s.availableMin) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    },
    services: services.map((s) => ({ serviceId: s.service_id, name: s.name, completed: s.n, persons: s.persons })),
    customers: { withCompleted: cust.customers, newCustomers: cust.new_customers, repeaters: cust.repeaters },
    passes: {
      usesNet: passUse.uses - passUse.reversals,
      uses: passUse.uses,
      reversals: passUse.reversals,
      expiredUses: passUse.expired,
      expiringWithin30Days: { count: expiring.n, remaining: expiring.remaining },
    },
    plans: { activeWithCurrentPeriod: plan.plans, granted: plan.granted, used: plan.used, remaining: plan.remaining, usageRate: rate(plan.used, plan.granted) },
    waitlist: { waiting: wl.waiting, convertedInPeriod: wl.converted },
    notifications: { failedInPeriod: failed.n },
  };
}

export type KpiResult = Awaited<ReturnType<typeof computeKpi>>;
