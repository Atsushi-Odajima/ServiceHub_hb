import { parseOrgSettings } from '../../../shared/constants.js';
import type { AuthContext } from '../../auth/context.js';
import type { Q } from '../../db/tx.js';
import { notFound } from '../../errors.js';

/**
 * 顧客の可視性(DECISIONS D-017 / RBAC.md §4)を SQL 条件にする。
 * params には既存パラメータ配列を渡し、必要な値を追加して返す($番号を正しく振るため)。
 */
export async function customerVisibility(
  q: Q,
  ctx: AuthContext,
  alias: string,
  params: unknown[],
  now: Date,
): Promise<string> {
  if (ctx.allLocations && ctx.role !== 'staff') return 'TRUE';
  if (ctx.role === 'staff') {
    const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [ctx.orgId]);
    const settings = parseOrgSettings(org.settings);
    params.push(ctx.staffId ?? '00000000-0000-0000-0000-000000000000');
    const staffIdx = params.length;
    params.push(ctx.membershipId);
    const mIdx = params.length;
    params.push(new Date(now.getTime() - 24 * 3600_000));
    const recentIdx = params.length;
    const conds = [
      `EXISTS (SELECT 1 FROM bookings vb WHERE vb.organization_id = ${alias}.organization_id AND vb.customer_id = ${alias}.id AND vb.staff_id = $${staffIdx})`,
      `(${alias}.created_by_membership_id = $${mIdx} AND ${alias}.created_at > $${recentIdx})`,
    ];
    if (settings.staffCanSearchLocationCustomers) {
      params.push(ctx.allLocations ? null : ctx.locationIds);
      const locIdx = params.length;
      conds.push(`($${locIdx}::uuid[] IS NULL OR ${alias}.preferred_location_id = ANY($${locIdx}::uuid[])
        OR EXISTS (SELECT 1 FROM bookings vb2 WHERE vb2.organization_id = ${alias}.organization_id AND vb2.customer_id = ${alias}.id AND vb2.location_id = ANY($${locIdx}::uuid[])))`);
    }
    return `(${conds.join(' OR ')})`;
  }
  params.push(ctx.locationIds);
  const idx = params.length;
  return `(${alias}.preferred_location_id = ANY($${idx}::uuid[])
    OR EXISTS (SELECT 1 FROM bookings vb WHERE vb.organization_id = ${alias}.organization_id AND vb.customer_id = ${alias}.id AND vb.location_id = ANY($${idx}::uuid[]))
    OR (${alias}.preferred_location_id IS NULL AND NOT EXISTS (SELECT 1 FROM bookings vb3 WHERE vb3.organization_id = ${alias}.organization_id AND vb3.customer_id = ${alias}.id)))`;
}

/** 顧客1件の可視性チェック(不可なら 404) */
export async function assertCustomerVisible(q: Q, ctx: AuthContext, customerId: string, now: Date): Promise<void> {
  const params: unknown[] = [ctx.orgId, customerId];
  const cond = await customerVisibility(q, ctx, 'c', params, now);
  const r = await q.maybeOne(`SELECT 1 FROM customers c WHERE c.organization_id = $1 AND c.id = $2 AND ${cond}`, params);
  if (!r) throw notFound('顧客');
}
