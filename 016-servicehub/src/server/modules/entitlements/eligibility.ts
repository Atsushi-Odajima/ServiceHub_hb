import type { Q } from '../../db/tx.js';
import { periodFor, type PlanSnapshot } from '../plans/periods.js';

export interface PassCandidate {
  kind: 'pass';
  id: string;
  name: string;
  remaining: number;
  expiresOn: string | null;
}

export interface PlanCandidate {
  kind: 'plan';
  id: string;
  name: string;
  periodId: string | null;
  periodStart: string;
  periodEnd: string;
  remaining: number;
  endsOn: string | null;
}

/**
 * 利用可能な回数券(PASS_LEDGER.md §4):
 * active・残数>0・開始日<=利用日<=期限・対象サービス(付与時スナップショット)・サービスが回数券利用可
 */
export async function eligiblePasses(q: Q, orgId: string, customerId: string, serviceId: string, date: string): Promise<PassCandidate[]> {
  const rows = await q.many<{ id: string; name: string; remaining: number; expires_on: string | null }>(
    `SELECT cp.id, cp.product_snapshot->>'name' AS name, cp.remaining, cp.expires_on
       FROM customer_passes cp
       JOIN services s ON s.id = $3 AND s.organization_id = cp.organization_id
      WHERE cp.organization_id = $1 AND cp.customer_id = $2 AND cp.status = 'active' AND cp.remaining > 0
        AND cp.starts_on <= $4::date AND (cp.expires_on IS NULL OR cp.expires_on >= $4::date)
        AND s.pass_eligible
        AND (coalesce((cp.product_snapshot->>'allServices')::boolean, false)
             OR (cp.product_snapshot->'serviceIds') ? $3::text)
      ORDER BY cp.expires_on NULLS LAST, cp.granted_at, cp.id`,
    [orgId, customerId, serviceId, date],
  );
  return rows.map((r) => ({ kind: 'pass', id: r.id, name: r.name, remaining: r.remaining, expiresOn: r.expires_on }));
}

/**
 * 利用可能な期間プラン(PLAN_USAGE_RULES.md §4)。期間行がまだ無い場合は periodId=null(消化時に生成)。
 * remaining は期間行がなければ商品スナップショットの回数(満額)とする。
 */
export async function eligiblePlans(q: Q, orgId: string, customerId: string, serviceId: string, date: string): Promise<PlanCandidate[]> {
  const rows = await q.many<{
    id: string;
    name: string;
    ends_on: string | null;
    uses: number;
    period_id: string | null;
    period_start: string | null;
    period_end: string | null;
    remaining: number | null;
    starts_on: string;
    snapshot: Record<string, unknown>;
  }>(
    `SELECT p.id, p.product_snapshot->>'name' AS name, p.ends_on, (p.product_snapshot->>'usesPerPeriod')::int AS uses,
            pp.id AS period_id, pp.period_start, pp.period_end, pp.remaining, p.starts_on, p.product_snapshot AS snapshot
       FROM customer_plans p
       JOIN services s ON s.id = $3 AND s.organization_id = p.organization_id
       LEFT JOIN customer_plan_periods pp ON pp.customer_plan_id = p.id AND pp.period_start <= $4::date AND pp.period_end >= $4::date
      WHERE p.organization_id = $1 AND p.customer_id = $2 AND p.status = 'active'
        AND p.starts_on <= $4::date AND (p.ends_on IS NULL OR p.ends_on >= $4::date)
        AND s.plan_eligible
        AND (coalesce((p.product_snapshot->>'allServices')::boolean, false) OR (p.product_snapshot->'serviceIds') ? $3::text)`,
    [orgId, customerId, serviceId, date],
  );
  return rows
    .map((r) => {
      const range = r.period_start ? { start: r.period_start, end: r.period_end! } : periodFor(r.snapshot as unknown as PlanSnapshot, r.starts_on, r.ends_on, date);
      return {
        kind: 'plan' as const,
        id: r.id,
        name: r.name,
        periodId: r.period_id,
        periodStart: range.start,
        periodEnd: range.end,
        remaining: r.remaining ?? r.uses,
        endsOn: r.ends_on,
      };
    })
    .filter((p) => p.remaining > 0);
}

export async function hasEligibleEntitlement(q: Q, orgId: string, customerId: string, serviceId: string, date: string): Promise<boolean> {
  if ((await eligiblePasses(q, orgId, customerId, serviceId, date)).length > 0) return true;
  return (await eligiblePlans(q, orgId, customerId, serviceId, date)).length > 0;
}

export interface EntitlementHint {
  kind: 'pass' | 'plan';
  id: string;
  name: string;
  remaining: number;
  /** 回数券の有効期限 / プランの当期末 */
  until: string | null;
  expiringSoon: boolean;
}

/**
 * 受付ボード・今日の予定用: 予約ごとに使えそうな回数券/プランの要約(表示用の目安。消化時は eligiblePasses/Plans で再判定)。
 * 予約件数に関係なく4クエリで取得する。
 */
export async function entitlementHints(
  q: Q,
  orgId: string,
  items: { bookingId: string; customerId: string; serviceId: string; date: string }[],
  today: string,
  soonDays = 14,
): Promise<Map<string, EntitlementHint[]>> {
  const out = new Map<string, EntitlementHint[]>();
  if (items.length === 0) return out;
  const customerIds = [...new Set(items.map((i) => i.customerId))];
  const serviceIds = [...new Set(items.map((i) => i.serviceId))];
  const services = await q.many<{ id: string; pass_eligible: boolean; plan_eligible: boolean }>(
    'SELECT id, pass_eligible, plan_eligible FROM services WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [orgId, serviceIds],
  );
  const svc = new Map(services.map((s) => [s.id, s]));
  const passes = await q.many<{ id: string; customer_id: string; snap: { name: string; allServices?: boolean; serviceIds?: string[] }; remaining: number; starts_on: string; expires_on: string | null }>(
    `SELECT id, customer_id, product_snapshot AS snap, remaining, starts_on, expires_on FROM customer_passes
      WHERE organization_id = $1 AND customer_id = ANY($2::uuid[]) AND status = 'active' AND remaining > 0
      ORDER BY expires_on NULLS LAST, granted_at, id`,
    [orgId, customerIds],
  );
  const plans = await q.many<{ id: string; customer_id: string; snap: PlanSnapshot; starts_on: string; ends_on: string | null }>(
    `SELECT id, customer_id, product_snapshot AS snap, starts_on, ends_on FROM customer_plans
      WHERE organization_id = $1 AND customer_id = ANY($2::uuid[]) AND status = 'active'`,
    [orgId, customerIds],
  );
  const periods = plans.length
    ? await q.many<{ customer_plan_id: string; period_start: string; period_end: string; remaining: number }>(
        `SELECT customer_plan_id, period_start, period_end, remaining FROM customer_plan_periods
          WHERE organization_id = $1 AND customer_plan_id = ANY($2::uuid[])`,
        [orgId, plans.map((p) => p.id)],
      )
    : [];
  const soon = addDaysIso(today, soonDays);
  for (const it of items) {
    const s = svc.get(it.serviceId);
    const hints: EntitlementHint[] = [];
    if (s?.pass_eligible) {
      for (const p of passes) {
        if (p.customer_id !== it.customerId || p.starts_on > it.date || (p.expires_on !== null && p.expires_on < it.date)) continue;
        if (!p.snap.allServices && !(p.snap.serviceIds ?? []).includes(it.serviceId)) continue;
        hints.push({ kind: 'pass', id: p.id, name: p.snap.name, remaining: p.remaining, until: p.expires_on, expiringSoon: p.expires_on !== null && p.expires_on <= soon });
      }
    }
    if (s?.plan_eligible) {
      for (const p of plans) {
        if (p.customer_id !== it.customerId || p.starts_on > it.date || (p.ends_on !== null && p.ends_on < it.date)) continue;
        if (!p.snap.allServices && !(p.snap.serviceIds ?? []).includes(it.serviceId)) continue;
        const period = periods.find((x) => x.customer_plan_id === p.id && x.period_start <= it.date && x.period_end >= it.date);
        const range = period ? { start: period.period_start, end: period.period_end } : periodFor(p.snap, p.starts_on, p.ends_on, it.date);
        const remaining = period ? period.remaining : p.snap.usesPerPeriod;
        if (remaining <= 0) continue;
        hints.push({ kind: 'plan', id: p.id, name: p.snap.name, remaining, until: range.end, expiringSoon: false });
      }
    }
    out.set(it.bookingId, hints);
  }
  return out;
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
