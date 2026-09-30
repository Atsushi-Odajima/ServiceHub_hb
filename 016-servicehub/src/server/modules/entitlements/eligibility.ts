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
      ORDER BY cp.expires_on NULLS LAST, cp.granted_at`,
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
