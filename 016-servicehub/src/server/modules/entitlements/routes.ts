import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { todayIn } from '../../../shared/time.js';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { type AuthContext, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zIdempotencyKey, zOptText, zUuid } from '../../http/validate.js';
import { assertCustomerVisible, customerVisibility } from '../customers/visibility.js';
import { periodContaining, type PlanSnapshot } from '../plans/periods.js';
import { adjustPass, adjustPlan, assignPlan, changePassExpiry, endPlan, grantPass, voidPass } from './ledger.js';

const PassProductSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: zOptText(1000),
  totalUses: z.number().int().min(1).max(1000),
  validityDays: z.number().int().min(1).max(3660).nullable().default(null),
  allServices: z.boolean().default(false),
  serviceIds: z.array(zUuid).max(500).default([]),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

const PlanProductSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: zOptText(1000),
  usesPerPeriod: z.number().int().min(1).max(1000),
  periodMonths: z.number().int().min(1).max(12).default(1),
  alignment: z.enum(['calendar', 'anniversary']).default('calendar'),
  carryoverEnabled: z.boolean().default(false),
  carryoverMax: z.number().int().min(0).max(1000).nullable().default(null),
  allServices: z.boolean().default(false),
  serviceIds: z.array(zUuid).max(500).default([]),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

async function assertServices(q: Q, orgId: string, ids: string[]) {
  if (ids.length === 0) return;
  const r = await q.one<{ n: number }>('SELECT count(*) AS n FROM services WHERE organization_id = $1 AND id = ANY($2::uuid[])', [orgId, [...new Set(ids)]]);
  if (r.n !== new Set(ids).size) throw new AppError('VALIDATION_ERROR', '存在しないサービスが含まれています');
}

async function setProductServices(q: Q, table: 'pass_product_services' | 'plan_product_services', col: string, orgId: string, id: string, serviceIds: string[]) {
  await q.exec(`DELETE FROM ${table} WHERE organization_id = $1 AND ${col} = $2`, [orgId, id]);
  for (const s of new Set(serviceIds)) {
    await q.exec(`INSERT INTO ${table} (organization_id, ${col}, service_id) VALUES ($1,$2,$3)`, [orgId, id, s]);
  }
}

function orgToday(ctx: AuthContext, now: Date): string {
  return todayIn(ctx.orgTimezone, now);
}

interface PassRow {
  id: string;
  customer_id: string;
  customer_name?: string;
  product_snapshot: { name: string; totalUses: number; validityDays: number | null; allServices: boolean; serviceIds: string[] };
  starts_on: string;
  expires_on: string | null;
  initial_uses: number;
  remaining: number;
  status: string;
  memo: string | null;
  granted_at: Date;
  version: number;
}

function passDto(p: PassRow, today: string) {
  const expired = p.status === 'expired' || (p.expires_on !== null && p.expires_on < today);
  return {
    id: p.id,
    customerId: p.customer_id,
    customerName: p.customer_name,
    name: p.product_snapshot.name,
    serviceIds: p.product_snapshot.serviceIds,
    allServices: p.product_snapshot.allServices,
    startsOn: p.starts_on,
    expiresOn: p.expires_on,
    initialUses: p.initial_uses,
    remaining: p.remaining,
    status: p.status,
    usable: p.status === 'active' && !expired && p.remaining > 0 && p.starts_on <= today,
    expiredByDate: expired,
    memo: p.memo,
    grantedAt: p.granted_at,
    version: p.version,
  };
}

interface PlanRow {
  id: string;
  customer_id: string;
  customer_name?: string;
  product_snapshot: PlanSnapshot;
  starts_on: string;
  ends_on: string | null;
  status: string;
  memo: string | null;
  created_at: Date;
  version: number;
}

async function planDto(q: Q, orgId: string, p: PlanRow, today: string) {
  const range = p.status === 'active' ? periodContaining(p.product_snapshot, p.starts_on, p.ends_on, today) : null;
  let current: { start: string; end: string; granted: number; used: number; remaining: number; materialized: boolean } | null = null;
  if (range) {
    const period = await q.maybeOne<{ id: string; remaining: number }>(
      'SELECT id, remaining FROM customer_plan_periods WHERE organization_id = $1 AND customer_plan_id = $2 AND period_start = $3',
      [orgId, p.id, range.start],
    );
    if (period) {
      const agg = await q.one<{ granted: number; used: number }>(
        `SELECT coalesce(sum(delta) FILTER (WHERE delta > 0 AND entry_type <> 'use_reversal'), 0) AS granted,
                coalesce(-sum(delta) FILTER (WHERE entry_type = 'use'), 0) - coalesce(sum(delta) FILTER (WHERE entry_type = 'use_reversal'), 0) AS used
           FROM plan_ledger_entries WHERE organization_id = $1 AND customer_plan_period_id = $2`,
        [orgId, period.id],
      );
      current = { start: range.start, end: range.end, granted: agg.granted, used: agg.used, remaining: period.remaining, materialized: true };
    } else {
      current = { start: range.start, end: range.end, granted: p.product_snapshot.usesPerPeriod, used: 0, remaining: p.product_snapshot.usesPerPeriod, materialized: false };
    }
  }
  return {
    id: p.id,
    customerId: p.customer_id,
    customerName: p.customer_name,
    name: p.product_snapshot.name,
    usesPerPeriod: p.product_snapshot.usesPerPeriod,
    periodMonths: p.product_snapshot.periodMonths,
    alignment: p.product_snapshot.alignment,
    carryoverEnabled: p.product_snapshot.carryoverEnabled,
    serviceIds: p.product_snapshot.serviceIds,
    allServices: p.product_snapshot.allServices,
    startsOn: p.starts_on,
    endsOn: p.ends_on,
    status: p.status,
    memo: p.memo,
    currentPeriod: current,
    version: p.version,
  };
}

export async function registerEntitlementRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  // ======================= 回数券の種類 =======================
  app.get('/api/v1/pass-products', async (req) => {
    const ctx = requireAuth(req, 'pass.read', 'pass.product.manage');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{ id: string; name: string; description: string | null; total_uses: number; validity_days: number | null; all_services: boolean; status: string; sort_order: number; service_ids: string[] }>(
        `SELECT p.*, coalesce((SELECT array_agg(service_id ORDER BY service_id) FROM pass_product_services s WHERE s.pass_product_id = p.id), '{}') AS service_ids
           FROM pass_products p WHERE p.organization_id = $1 ORDER BY p.status, p.sort_order, p.name, p.id`,
        [ctx.orgId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          totalUses: r.total_uses,
          validityDays: r.validity_days,
          allServices: r.all_services,
          serviceIds: r.service_ids,
          status: r.status,
          sortOrder: r.sort_order,
        })),
      };
    });
  });

  app.post('/api/v1/pass-products', async (req) => {
    const ctx = requireAuth(req, 'pass.product.manage');
    const b = parse(PassProductSchema, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertServices(q, ctx.orgId, b.serviceIds);
      const r = await q.one<{ id: string }>(
        `INSERT INTO pass_products (organization_id, name, description, total_uses, validity_days, all_services, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.orgId, b.name, b.description, b.totalUses, b.validityDays, b.allServices, b.sortOrder],
      );
      await setProductServices(q, 'pass_product_services', 'pass_product_id', ctx.orgId, r.id, b.serviceIds);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'pass_product.created', targetType: 'pass_product', targetId: r.id, after: b, requestId: req.id });
      return { id: r.id };
    });
  });

  app.patch('/api/v1/pass-products/:id', async (req) => {
    const ctx = requireAuth(req, 'pass.product.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(PassProductSchema.partial().extend({ status: z.enum(['active', 'inactive']).optional() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<{ name: string; description: string | null; total_uses: number; validity_days: number | null; all_services: boolean; status: string; sort_order: number }>(
        'SELECT name, description, total_uses, validity_days, all_services, status, sort_order FROM pass_products WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [ctx.orgId, id],
      );
      if (!cur) throw notFound('回数券の種類');
      if (b.serviceIds) await assertServices(q, ctx.orgId, b.serviceIds);
      const next = {
        name: b.name ?? cur.name,
        description: b.description !== undefined ? b.description : cur.description,
        total_uses: b.totalUses ?? cur.total_uses,
        validity_days: b.validityDays !== undefined ? b.validityDays : cur.validity_days,
        all_services: b.allServices ?? cur.all_services,
        status: b.status ?? cur.status,
        sort_order: b.sortOrder ?? cur.sort_order,
      };
      await q.exec(
        `UPDATE pass_products SET name=$3, description=$4, total_uses=$5, validity_days=$6, all_services=$7, status=$8, sort_order=$9 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, next.name, next.description, next.total_uses, next.validity_days, next.all_services, next.status, next.sort_order],
      );
      if (b.serviceIds) await setProductServices(q, 'pass_product_services', 'pass_product_id', ctx.orgId, id, b.serviceIds);
      const diff = changes(cur as unknown as Record<string, unknown>, next);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'pass_product.updated', targetType: 'pass_product', targetId: id, before: diff?.before, after: diff?.after, requestId: req.id });
      // 付与済みの回数券は付与時スナップショットで動くため影響しない
      return { ok: true };
    });
  });

  // ======================= 顧客の回数券 =======================
  app.get('/api/v1/customers/:id/passes', async (req) => {
    const ctx = requireAuth(req, 'pass.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      await assertCustomerVisible(q, ctx, id, clock.now());
      const rows = await q.many<PassRow>('SELECT * FROM customer_passes WHERE organization_id = $1 AND customer_id = $2 ORDER BY status, expires_on NULLS LAST, granted_at', [ctx.orgId, id]);
      const today = orgToday(ctx, clock.now());
      return { items: rows.map((r) => passDto(r, today)) };
    });
  });

  app.post('/api/v1/customers/:id/passes', async (req) => {
    const ctx = requireAuth(req, 'pass.grant');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ passProductId: zUuid, startsOn: zDate.optional(), memo: zOptText(500), idempotencyKey: zIdempotencyKey }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertCustomerVisible(q, ctx, id, clock.now());
      const r = await grantPass(q, ctx.orgId, actorOf(ctx), {
        customerId: id,
        passProductId: b.passProductId,
        startsOn: b.startsOn ?? orgToday(ctx, clock.now()),
        memo: b.memo,
        idempotencyKey: b.idempotencyKey,
        requestId: req.id,
      });
      const p = await q.one<PassRow>('SELECT * FROM customer_passes WHERE organization_id = $1 AND id = $2', [ctx.orgId, r.passId]);
      return { ...passDto(p, orgToday(ctx, clock.now())), created: r.created };
    });
  });

  app.get('/api/v1/passes', async (req) => {
    const ctx = requireAuth(req, 'pass.read');
    const qy = parse(
      z.object({ status: z.enum(['active', 'expired', 'voided', 'all']).default('active'), expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const today = orgToday(ctx, clock.now());
      const params: unknown[] = [ctx.orgId];
      const vis = await customerVisibility(q, ctx, 'c', params, clock.now());
      const where = ['cp.organization_id = $1', vis];
      if (qy.status !== 'all') {
        params.push(qy.status);
        where.push(`cp.status = $${params.length}`);
      }
      if (qy.expiringWithinDays !== undefined) {
        params.push(today);
        const t = params.length;
        params.push(qy.expiringWithinDays);
        where.push(`cp.remaining > 0 AND cp.expires_on BETWEEN $${t}::date AND $${t}::date + $${params.length}::int`);
      }
      params.push(qy.limit);
      const rows = await q.many<PassRow>(
        `SELECT cp.*, c.name AS customer_name FROM customer_passes cp JOIN customers c ON c.id = cp.customer_id
          WHERE ${where.join(' AND ')} ORDER BY cp.expires_on NULLS LAST, cp.granted_at DESC, cp.id DESC LIMIT $${params.length}`,
        params,
      );
      return { items: rows.map((r) => passDto(r, today)) };
    });
  });

  app.get('/api/v1/passes/:id', async (req) => {
    const ctx = requireAuth(req, 'pass.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const p = await q.maybeOne<PassRow>('SELECT cp.*, c.name AS customer_name FROM customer_passes cp JOIN customers c ON c.id = cp.customer_id WHERE cp.organization_id = $1 AND cp.id = $2', [
        ctx.orgId,
        id,
      ]);
      if (!p) throw notFound('回数券');
      await assertCustomerVisible(q, ctx, p.customer_id, clock.now());
      const entries = await q.many<{ id: string; entry_type: string; delta: number; balance_after: number; booking_id: string | null; service_record_id: string | null; reverses_entry_id: string | null; reason: string | null; actor_label: string | null; actor_type: string; created_at: Date; booking_code: string | null; booking_starts_at: Date | null }>(
        `SELECT l.*, b.code AS booking_code, b.starts_at AS booking_starts_at FROM pass_ledger_entries l
           LEFT JOIN bookings b ON b.id = l.booking_id
          WHERE l.organization_id = $1 AND l.customer_pass_id = $2 ORDER BY l.created_at, l.id`,
        [ctx.orgId, id],
      );
      const sum = entries.reduce((s, e) => s + e.delta, 0);
      return {
        ...passDto(p, orgToday(ctx, clock.now())),
        ledger: entries.map((e) => ({
          id: e.id,
          type: e.entry_type,
          delta: e.delta,
          balanceAfter: e.balance_after,
          bookingId: e.booking_id,
          bookingCode: e.booking_code,
          bookingStartsAt: e.booking_starts_at,
          recordId: e.service_record_id,
          reversesEntryId: e.reverses_entry_id,
          reason: e.reason,
          actor: e.actor_type === 'system' ? 'システム' : e.actor_label,
          at: e.created_at,
        })),
        // 台帳から残数を再現できることの確認値(不一致は異常)
        ledgerSum: sum,
        consistent: sum === p.remaining,
      };
    });
  });

  const passAction = async (req: any, fn: (q: Q, ctx: AuthContext, passId: string) => Promise<unknown>) => {
    const ctx = requireAuth(req, 'pass.adjust');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const p = await q.maybeOne<{ customer_id: string }>('SELECT customer_id FROM customer_passes WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!p) throw notFound('回数券');
      await assertCustomerVisible(q, ctx, p.customer_id, clock.now());
      return fn(q, ctx, id);
    });
  };

  app.post('/api/v1/passes/:id/adjust', async (req) => {
    requireAuth(req, 'pass.adjust'); // 本文の検査より先に認証・権限を確認
    const b = parse(
      z.object({ type: z.enum(['manual_add', 'manual_subtract', 'correction']), delta: z.number().int().min(-1000).max(1000), reason: z.string().trim().min(1, '理由を入力してください').max(500), idempotencyKey: zIdempotencyKey }),
      req.body,
    );
    return passAction(req, async (q, ctx, id) => {
      const e = await adjustPass(q, ctx.orgId, actorOf(ctx), { passId: id, ...b, requestId: req.id });
      return { entryId: e.id, balanceAfter: e.balance_after };
    });
  });

  app.post('/api/v1/passes/:id/expiry', async (req) => {
    requireAuth(req, 'pass.adjust'); // 本文の検査より先に認証・権限を確認
    const b = parse(z.object({ expiresOn: zDate.nullable(), reactivate: z.boolean().default(false) }), req.body);
    return passAction(req, async (q, ctx, id) => {
      await changePassExpiry(q, ctx.orgId, actorOf(ctx), { passId: id, expiresOn: b.expiresOn, reactivate: b.reactivate, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/v1/passes/:id/void', async (req) => {
    requireAuth(req, 'pass.adjust'); // 本文の検査より先に認証・権限を確認
    const b = parse(z.object({ reason: z.string().trim().min(1).max(500) }), req.body);
    return passAction(req, async (q, ctx, id) => {
      await voidPass(q, ctx.orgId, actorOf(ctx), { passId: id, reason: b.reason, requestId: req.id });
      return { ok: true };
    });
  });

  // ======================= 利用プランの種類 =======================
  app.get('/api/v1/plan-products', async (req) => {
    const ctx = requireAuth(req, 'plan.read', 'plan.product.manage');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{
        id: string;
        name: string;
        description: string | null;
        uses_per_period: number;
        period_months: number;
        alignment: string;
        carryover_enabled: boolean;
        carryover_max: number | null;
        all_services: boolean;
        status: string;
        sort_order: number;
        service_ids: string[];
      }>(
        `SELECT p.*, coalesce((SELECT array_agg(service_id ORDER BY service_id) FROM plan_product_services s WHERE s.plan_product_id = p.id), '{}') AS service_ids
           FROM plan_products p WHERE p.organization_id = $1 ORDER BY p.status, p.sort_order, p.name, p.id`,
        [ctx.orgId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          usesPerPeriod: r.uses_per_period,
          periodMonths: r.period_months,
          alignment: r.alignment,
          carryoverEnabled: r.carryover_enabled,
          carryoverMax: r.carryover_max,
          allServices: r.all_services,
          serviceIds: r.service_ids,
          status: r.status,
          sortOrder: r.sort_order,
        })),
      };
    });
  });

  app.post('/api/v1/plan-products', async (req) => {
    const ctx = requireAuth(req, 'plan.product.manage');
    const b = parse(PlanProductSchema, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertServices(q, ctx.orgId, b.serviceIds);
      const r = await q.one<{ id: string }>(
        `INSERT INTO plan_products (organization_id, name, description, uses_per_period, period_months, alignment, carryover_enabled, carryover_max, all_services, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ctx.orgId, b.name, b.description, b.usesPerPeriod, b.periodMonths, b.alignment, b.carryoverEnabled, b.carryoverMax, b.allServices, b.sortOrder],
      );
      await setProductServices(q, 'plan_product_services', 'plan_product_id', ctx.orgId, r.id, b.serviceIds);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'plan_product.created', targetType: 'plan_product', targetId: r.id, after: b, requestId: req.id });
      return { id: r.id };
    });
  });

  app.patch('/api/v1/plan-products/:id', async (req) => {
    const ctx = requireAuth(req, 'plan.product.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(PlanProductSchema.partial().extend({ status: z.enum(['active', 'inactive']).optional() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<Record<string, any>>('SELECT * FROM plan_products WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.orgId, id]);
      if (!cur) throw notFound('利用プランの種類');
      if (b.serviceIds) await assertServices(q, ctx.orgId, b.serviceIds);
      const next = {
        name: b.name ?? cur.name,
        description: b.description !== undefined ? b.description : cur.description,
        uses_per_period: b.usesPerPeriod ?? cur.uses_per_period,
        period_months: b.periodMonths ?? cur.period_months,
        alignment: b.alignment ?? cur.alignment,
        carryover_enabled: b.carryoverEnabled ?? cur.carryover_enabled,
        carryover_max: b.carryoverMax !== undefined ? b.carryoverMax : cur.carryover_max,
        all_services: b.allServices ?? cur.all_services,
        status: b.status ?? cur.status,
        sort_order: b.sortOrder ?? cur.sort_order,
      };
      await q.exec(
        `UPDATE plan_products SET name=$3, description=$4, uses_per_period=$5, period_months=$6, alignment=$7, carryover_enabled=$8, carryover_max=$9,
                all_services=$10, status=$11, sort_order=$12 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, next.name, next.description, next.uses_per_period, next.period_months, next.alignment, next.carryover_enabled, next.carryover_max, next.all_services, next.status, next.sort_order],
      );
      if (b.serviceIds) await setProductServices(q, 'plan_product_services', 'plan_product_id', ctx.orgId, id, b.serviceIds);
      const diff = changes(cur, next);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'plan_product.updated', targetType: 'plan_product', targetId: id, before: diff?.before, after: diff?.after, requestId: req.id });
      return { ok: true };
    });
  });

  // ======================= 顧客の利用プラン =======================
  app.get('/api/v1/customers/:id/plans', async (req) => {
    const ctx = requireAuth(req, 'plan.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      await assertCustomerVisible(q, ctx, id, clock.now());
      const rows = await q.many<PlanRow>('SELECT * FROM customer_plans WHERE organization_id = $1 AND customer_id = $2 ORDER BY status, starts_on DESC', [ctx.orgId, id]);
      const today = orgToday(ctx, clock.now());
      const items = [];
      for (const r of rows) items.push(await planDto(q, ctx.orgId, r, today));
      return { items };
    });
  });

  app.post('/api/v1/customers/:id/plans', async (req) => {
    const ctx = requireAuth(req, 'plan.assign');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ planProductId: zUuid, startsOn: zDate, endsOn: zDate.nullable().optional(), memo: zOptText(500), idempotencyKey: zIdempotencyKey }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertCustomerVisible(q, ctx, id, clock.now());
      const r = await assignPlan(q, ctx.orgId, actorOf(ctx), { customerId: id, ...b, requestId: req.id });
      const p = await q.one<PlanRow>('SELECT * FROM customer_plans WHERE organization_id = $1 AND id = $2', [ctx.orgId, r.planId]);
      return { ...(await planDto(q, ctx.orgId, p, orgToday(ctx, clock.now()))), created: r.created };
    });
  });

  app.get('/api/v1/plans', async (req) => {
    const ctx = requireAuth(req, 'plan.read');
    const qy = parse(z.object({ status: z.enum(['active', 'ended', 'canceled', 'all']).default('active'), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const today = orgToday(ctx, clock.now());
      const params: unknown[] = [ctx.orgId];
      const vis = await customerVisibility(q, ctx, 'c', params, clock.now());
      const where = ['p.organization_id = $1', vis];
      if (qy.status !== 'all') {
        params.push(qy.status);
        where.push(`p.status = $${params.length}`);
      }
      params.push(qy.limit);
      const rows = await q.many<PlanRow>(
        `SELECT p.*, c.name AS customer_name FROM customer_plans p JOIN customers c ON c.id = p.customer_id
          WHERE ${where.join(' AND ')} ORDER BY p.starts_on DESC, p.id DESC LIMIT $${params.length}`,
        params,
      );
      const items = [];
      for (const r of rows) items.push(await planDto(q, ctx.orgId, r, today));
      return { items };
    });
  });

  app.get('/api/v1/plans/:id', async (req) => {
    const ctx = requireAuth(req, 'plan.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const p = await q.maybeOne<PlanRow>('SELECT p.*, c.name AS customer_name FROM customer_plans p JOIN customers c ON c.id = p.customer_id WHERE p.organization_id = $1 AND p.id = $2', [ctx.orgId, id]);
      if (!p) throw notFound('利用プラン');
      await assertCustomerVisible(q, ctx, p.customer_id, clock.now());
      const periods = await q.many<{ id: string; period_start: string; period_end: string; remaining: number; status: string }>(
        'SELECT id, period_start, period_end, remaining, status FROM customer_plan_periods WHERE organization_id = $1 AND customer_plan_id = $2 ORDER BY period_start DESC',
        [ctx.orgId, id],
      );
      const entries = await q.many<{ id: string; customer_plan_period_id: string; entry_type: string; delta: number; balance_after: number; booking_id: string | null; reason: string | null; actor_label: string | null; actor_type: string; created_at: Date; booking_code: string | null; booking_starts_at: Date | null }>(
        `SELECT l.*, b.code AS booking_code, b.starts_at AS booking_starts_at FROM plan_ledger_entries l LEFT JOIN bookings b ON b.id = l.booking_id
          WHERE l.organization_id = $1 AND l.customer_plan_id = $2 ORDER BY l.created_at, l.id`,
        [ctx.orgId, id],
      );
      return {
        ...(await planDto(q, ctx.orgId, p, orgToday(ctx, clock.now()))),
        periods: periods.map((x) => {
          const sum = entries.filter((e) => e.customer_plan_period_id === x.id).reduce((s, e) => s + e.delta, 0);
          return { id: x.id, start: x.period_start, end: x.period_end, remaining: x.remaining, status: x.status, consistent: sum === x.remaining };
        }),
        ledger: entries.map((e) => ({
          id: e.id,
          periodId: e.customer_plan_period_id,
          type: e.entry_type,
          delta: e.delta,
          balanceAfter: e.balance_after,
          bookingId: e.booking_id,
          bookingCode: e.booking_code,
          bookingStartsAt: e.booking_starts_at,
          reason: e.reason,
          actor: e.actor_type === 'system' ? 'システム' : e.actor_label,
          at: e.created_at,
        })),
      };
    });
  });

  app.post('/api/v1/plans/:id/adjust', async (req) => {
    const ctx = requireAuth(req, 'plan.adjust');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z.object({
        date: zDate.optional(),
        type: z.enum(['manual_add', 'manual_subtract', 'correction']),
        delta: z.number().int().min(-1000).max(1000),
        reason: z.string().trim().min(1, '理由を入力してください').max(500),
        idempotencyKey: zIdempotencyKey,
      }),
      req.body,
    );
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const p = await q.maybeOne<{ customer_id: string }>('SELECT customer_id FROM customer_plans WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!p) throw notFound('利用プラン');
      await assertCustomerVisible(q, ctx, p.customer_id, clock.now());
      const e = await adjustPlan(q, ctx.orgId, actorOf(ctx), { planId: id, date: b.date ?? orgToday(ctx, clock.now()), type: b.type, delta: b.delta, reason: b.reason, idempotencyKey: b.idempotencyKey, requestId: req.id });
      return { entryId: e.id, balanceAfter: e.balance_after };
    });
  });

  app.post('/api/v1/plans/:id/end', async (req) => {
    const ctx = requireAuth(req, 'plan.adjust');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ endsOn: zDate, status: z.enum(['ended', 'canceled']).default('ended'), reason: zOptText(500) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const p = await q.maybeOne<{ customer_id: string }>('SELECT customer_id FROM customer_plans WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!p) throw notFound('利用プラン');
      await assertCustomerVisible(q, ctx, p.customer_id, clock.now());
      const r = await endPlan(q, ctx.orgId, actorOf(ctx), { planId: id, endsOn: b.endsOn, status: b.status, today: orgToday(ctx, clock.now()), reason: b.reason, requestId: req.id });
      return { ok: true, status: r.status };
    });
  });
}
