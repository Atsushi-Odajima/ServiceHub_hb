import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrgSettings } from '../../../shared/constants.js';
import { localDateOf } from '../../../shared/time.js';
import { can, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zIdempotencyKey, zIso, zOptText, zUuid } from '../../http/validate.js';
import { assertBookingAccess, bookingActor, bookingDto } from '../bookings/routes.js';
import { type BookingRow, loadBookingForUpdate } from '../bookings/service.js';
import { eligiblePasses, eligiblePlans } from '../entitlements/eligibility.js';
import { consumeForBooking, reverseConsumption, waiveConsumption } from '../entitlements/ledger.js';
import { completeBooking, type ServiceRecordRow, updateRecord, voidRecord } from './service.js';

const RecordSchema = z.object({
  startedAt: zIso.nullish(),
  endedAt: zIso.nullish(),
  durationMin: z.number().int().min(0).max(1440).nullish(),
  internalMemo: zOptText(4000),
  customerMemo: zOptText(2000),
  nextRecommendedOn: zDate.nullish(),
  nextRecommendedNote: zOptText(500),
});

function toRecordInput(r: z.infer<typeof RecordSchema> | undefined) {
  if (!r) return undefined;
  return {
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    endedAt: r.endedAt ? new Date(r.endedAt) : null,
    durationMin: r.durationMin ?? null,
    internalMemo: r.internalMemo,
    customerMemo: r.customerMemo,
    nextRecommendedOn: r.nextRecommendedOn ?? null,
    nextRecommendedNote: r.nextRecommendedNote,
  };
}

export function recordDto(r: ServiceRecordRow, showMemos: boolean) {
  return {
    id: r.id,
    bookingId: r.booking_id,
    customerId: r.customer_id,
    locationId: r.location_id,
    staffId: r.staff_id,
    serviceId: r.service_id,
    serviceName: (r.service_snapshot as { name?: string })?.name,
    performedAt: r.performed_at,
    endedAt: r.ended_at,
    durationMin: r.duration_min,
    internalMemo: showMemos ? r.internal_memo : undefined,
    customerMemo: showMemos ? r.customer_memo : undefined,
    nextRecommendedOn: r.next_recommended_on,
    nextRecommendedNote: showMemos ? r.next_recommended_note : undefined,
    nextBookingId: r.next_booking_id,
    status: r.status,
    voidReason: r.void_reason,
    version: r.version,
    createdAt: r.created_at,
  };
}

async function candidates(q: Q, orgId: string, b: BookingRow) {
  const date = localDateOf(b.starts_at, (b.location_snapshot?.timezone as string) ?? 'Asia/Tokyo');
  const passes = await eligiblePasses(q, orgId, b.customer_id, b.service_id, date);
  const plans = await eligiblePlans(q, orgId, b.customer_id, b.service_id, date);
  return { date, passes, plans };
}

export async function registerRecordRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  // 完了画面用: 予約・既存の実施記録・利用可能な回数券/プラン候補
  app.get('/api/v1/bookings/:id/completion', async (req) => {
    const ctx = requireAuth(req, 'booking.status.all', 'booking.status.own', 'record.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const b = await q.maybeOne<BookingRow>('SELECT * FROM bookings WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!b) throw notFound('予約');
      assertBookingAccess(ctx, b, 'booking.read.all', 'booking.read.own');
      const rec = await q.maybeOne<ServiceRecordRow>(
        `SELECT * FROM service_records WHERE organization_id = $1 AND booking_id = $2 ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`,
        [ctx.orgId, id],
      );
      const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [ctx.orgId]);
      const settings = parseOrgSettings(org.settings);
      const cand = can(ctx, 'pass.read') || can(ctx, 'plan.read') ? await candidates(q, ctx.orgId, b) : { date: null, passes: [], plans: [] };
      let consumption: { kind: string; name: string; balanceAfter: number } | null = null;
      if (b.consumption_entry_id && b.consumption_kind === 'pass') {
        const e = await q.maybeOne<{ name: string; balance_after: number }>(
          `SELECT cp.product_snapshot->>'name' AS name, l.balance_after FROM pass_ledger_entries l JOIN customer_passes cp ON cp.id = l.customer_pass_id
            WHERE l.organization_id = $1 AND l.id = $2`,
          [ctx.orgId, b.consumption_entry_id],
        );
        if (e) consumption = { kind: 'pass', name: e.name, balanceAfter: e.balance_after };
      } else if (b.consumption_entry_id && b.consumption_kind === 'plan') {
        const e = await q.maybeOne<{ name: string; balance_after: number }>(
          `SELECT p.product_snapshot->>'name' AS name, l.balance_after FROM plan_ledger_entries l JOIN customer_plans p ON p.id = l.customer_plan_id
            WHERE l.organization_id = $1 AND l.id = $2`,
          [ctx.orgId, b.consumption_entry_id],
        );
        if (e) consumption = { kind: 'plan', name: e.name, balanceAfter: e.balance_after };
      }
      const showMemos = can(ctx, 'record.read');
      return {
        booking: bookingDto(b, ctx),
        record: rec ? recordDto(rec, showMemos) : null,
        candidates: cand,
        consumption,
        consumptionPrompt: settings.consumptionPrompt,
        permissions: {
          writeRecord: can(ctx, 'record.write.all') || (can(ctx, 'record.write.own') && b.staff_id === ctx.staffId),
          consumePass: can(ctx, 'pass.consume'),
          consumePlan: can(ctx, 'plan.consume'),
          reverse: can(ctx, 'pass.reverse') || can(ctx, 'plan.reverse'),
          voidRecord: can(ctx, 'record.void'),
          review: can(ctx, 'pass.adjust') || can(ctx, 'plan.adjust'),
        },
      };
    });
  });

  app.post('/api/v1/bookings/:id/complete', async (req) => {
    const ctx = requireAuth(req, 'booking.status.all', 'booking.status.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({
        expectedVersion: z.number().int().optional(),
        record: RecordSchema.optional(),
        consume: z.object({ kind: z.enum(['pass', 'plan']), entitlementId: zUuid, idempotencyKey: zIdempotencyKey }).nullish(),
      }),
      req.body ?? {},
    );
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.status.all', 'booking.status.own');
        const canWriteRecord = can(ctx, 'record.write.all') || (can(ctx, 'record.write.own') && b.staff_id === ctx.staffId);
        if (body.consume) {
          const perm = body.consume.kind === 'pass' ? 'pass.consume' : 'plan.consume';
          if (!can(ctx, perm)) throw forbidden('回数券/プランを消化する権限がありません');
        }
        const r = await completeBooking(q, deps, ctx.orgId, { ...bookingActor(ctx, req.id), canWriteRecord, canConsume: true }, id, {
          expectedVersion: body.expectedVersion,
          record: toRecordInput(body.record),
          consume: body.consume ?? null,
        });
        return { booking: bookingDto(r.booking, ctx), recordId: r.recordId, consumption: r.consumption ? { entryId: r.consumption.id, balanceAfter: r.consumption.balance_after } : null };
      },
      { lockTimeoutMs: 10000 },
    );
  });

  // 完了後の消化(completion で消化しなかった場合 / 締切後キャンセル・無断欠席の確認)
  app.post('/api/v1/bookings/:id/consume', async (req) => {
    const ctx = requireAuth(req, 'pass.consume', 'plan.consume');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ kind: z.enum(['pass', 'plan']), entitlementId: zUuid, idempotencyKey: zIdempotencyKey, reason: zOptText(500) }), req.body);
    if (!can(ctx, body.kind === 'pass' ? 'pass.consume' : 'plan.consume')) throw forbidden();
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.status.all', 'booking.status.own');
        if (b.consumption_review === 'pending' && !can(ctx, 'pass.adjust') && !can(ctx, 'plan.adjust')) {
          throw forbidden('締切後キャンセル/無断欠席の消化判断はオーナー/マネージャーが行います');
        }
        const r = await consumeForBooking(q, ctx.orgId, bookingActor(ctx, req.id).actor, {
          bookingId: id,
          kind: body.kind,
          entitlementId: body.entitlementId,
          idempotencyKey: body.idempotencyKey,
          reason: body.reason,
          requestId: req.id,
        });
        return { entryId: r.entry.id, balanceAfter: r.entry.balance_after, duplicate: r.duplicate };
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.post('/api/v1/bookings/:id/consumption/reverse', async (req) => {
    const ctx = requireAuth(req, 'pass.reverse', 'plan.reverse');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '理由を入力してください').max(500) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const b = await loadBookingForUpdate(q, ctx.orgId, id);
      assertBookingAccess(ctx, b, 'booking.read.all', 'booking.read.own');
      const e = await reverseConsumption(q, ctx.orgId, bookingActor(ctx, req.id).actor, { bookingId: id, reason: body.reason, requestId: req.id });
      if (!e) throw new AppError('INVALID_STATE', 'この予約には取り消せる消化がありません');
      return { entryId: e.id, balanceAfter: e.balance_after };
    });
  });

  app.post('/api/v1/bookings/:id/consumption/waive', async (req) => {
    const ctx = requireAuth(req, 'pass.adjust', 'plan.adjust');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ reason: zOptText(500) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const b = await loadBookingForUpdate(q, ctx.orgId, id);
      assertBookingAccess(ctx, b, 'booking.read.all', 'booking.read.own');
      await waiveConsumption(q, ctx.orgId, bookingActor(ctx, req.id).actor, { bookingId: id, reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  // ---- 実施記録 ----
  app.get('/api/v1/records', async (req) => {
    const ctx = requireAuth(req, 'record.read');
    const qy = parse(
      z.object({ customerId: zUuid.optional(), staffId: zUuid.optional(), from: zIso.optional(), to: zIso.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
      req.query,
    );
    const ownOnly = !can(ctx, 'booking.read.all');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<ServiceRecordRow & { customer_name: string }>(
        `SELECT r.*, c.name AS customer_name FROM service_records r JOIN customers c ON c.id = r.customer_id
          WHERE r.organization_id = $1 AND ($2::uuid IS NULL OR r.customer_id = $2) AND ($3::uuid IS NULL OR r.staff_id = $3)
            AND ($4::timestamptz IS NULL OR r.performed_at >= $4) AND ($5::timestamptz IS NULL OR r.performed_at < $5)
            AND ($6::uuid[] IS NULL OR r.location_id = ANY($6::uuid[]))
          ORDER BY r.performed_at DESC, r.id DESC LIMIT $7`,
        [ctx.orgId, qy.customerId ?? null, ownOnly ? (ctx.staffId ?? '00000000-0000-0000-0000-000000000000') : (qy.staffId ?? null), qy.from ?? null, qy.to ?? null, locationScope(ctx), qy.limit],
      );
      return { items: rows.map((r) => ({ ...recordDto(r, true), customerName: r.customer_name })) };
    });
  });

  app.patch('/api/v1/records/:id', async (req) => {
    const ctx = requireAuth(req, 'record.write.all', 'record.write.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(RecordSchema.extend({ expectedVersion: z.number().int() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const r = await q.maybeOne<ServiceRecordRow>('SELECT * FROM service_records WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!r) throw notFound('実施記録');
      assertBookingAccess(ctx, { location_id: r.location_id, staff_id: r.staff_id }, 'record.write.all', 'record.write.own');
      const { expectedVersion, ...rest } = body;
      const input = toRecordInput(rest)!;
      const partial = Object.fromEntries(Object.entries(input).filter(([k]) => (rest as Record<string, unknown>)[k] !== undefined));
      const updated = await updateRecord(q, ctx.orgId, bookingActor(ctx, req.id), id, expectedVersion, partial);
      return recordDto(updated, true);
    });
  });

  app.post('/api/v1/records/:id/void', async (req) => {
    const ctx = requireAuth(req, 'record.void');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '理由を入力してください').max(500), reverseConsumption: z.boolean() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const r = await q.maybeOne<ServiceRecordRow>('SELECT * FROM service_records WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      if (!r) throw notFound('実施記録');
      assertBookingAccess(ctx, { location_id: r.location_id, staff_id: r.staff_id }, 'booking.read.all', 'booking.read.own');
      return voidRecord(q, deps, ctx.orgId, bookingActor(ctx, req.id), id, body);
    });
  });
}
