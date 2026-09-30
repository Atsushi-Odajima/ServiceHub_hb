import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BOOKING_STATUSES } from '../../../shared/constants.js';
import type { Permission } from '../../../shared/permissions.js';
import { localDayRange } from '../../../shared/time.js';
import { actorOf, writeAudit } from '../../audit.js';
import { type AuthContext, can, canAccessLocation, locationScope, requireAuth } from '../../auth/context.js';
import { evaluateStart, listSlots } from '../../engine/availability.js';
import { loadEngineInput } from '../../engine/loader.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zIdempotencyKey, zIso, zOptEmail, zOptText, zPhone, zUuid } from '../../http/validate.js';
import {
  type BookingActor,
  type BookingRow,
  cancelBooking,
  changeStatus,
  createBooking,
  loadBookingForUpdate,
  rescheduleBooking,
  restoreBooking,
} from './service.js';

export function bookingActor(ctx: AuthContext, requestId?: string): BookingActor {
  return { actor: actorOf(ctx), membershipId: ctx.membershipId, mode: 'staff', canForce: can(ctx, 'booking.force'), requestId };
}

/** 予約単位の認可: 拠点スコープ + (.own のみの場合)担当スタッフ一致。権限外は存在を明かさず 404 */
export function assertBookingAccess(ctx: AuthContext, b: { location_id: string; staff_id: string | null }, all: Permission, own: Permission): void {
  if (!canAccessLocation(ctx, b.location_id)) throw notFound('予約');
  if (can(ctx, all)) return;
  if (can(ctx, own) && ctx.staffId && b.staff_id === ctx.staffId) return;
  if (can(ctx, own) || can(ctx, 'booking.read.own')) throw notFound('予約');
  throw forbidden();
}

export interface BookingListRow extends BookingRow {
  customer_name: string;
  customer_kana: string | null;
  customer_status: string;
}

export function bookingDto(b: BookingListRow | BookingRow, ctx: AuthContext | null) {
  const showInternal = ctx ? can(ctx, 'booking.internal_note') : false;
  return {
    id: b.id,
    code: b.code,
    locationId: b.location_id,
    locationName: b.location_snapshot?.name,
    timezone: b.location_snapshot?.timezone ?? 'Asia/Tokyo',
    customerId: b.customer_id,
    customerName: 'customer_name' in b ? b.customer_name : (b.contact_snapshot?.name as string),
    customerKana: 'customer_kana' in b ? b.customer_kana : null,
    serviceId: b.service_id,
    serviceName: b.service_snapshot?.name,
    durationMin: b.service_snapshot?.durationMin,
    capacity: (b.service_snapshot?.capacity as number | undefined) ?? 1,
    staffId: b.staff_id,
    staffName: b.staff_snapshot?.displayName ?? null,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    partySize: b.party_size,
    status: b.status,
    channel: b.channel,
    staffSelection: b.staff_selection,
    customerRequest: b.customer_request,
    internalNote: showInternal ? b.internal_note : undefined,
    forced: b.forced,
    forceReason: showInternal ? b.force_reason : undefined,
    canceledAt: b.canceled_at,
    cancelReason: b.cancel_reason,
    cancelLate: b.cancel_late,
    arrivedAt: b.arrived_at,
    serviceStartedAt: b.service_started_at,
    completedAt: b.completed_at,
    noShowAt: b.no_show_at,
    consumptionKind: b.consumption_kind,
    consumptionEntryId: b.consumption_entry_id,
    consumptionReview: b.consumption_review,
    previousBookingId: b.previous_booking_id,
    version: b.version,
    createdAt: b.created_at,
  };
}

const CustomerInput = z.union([
  z.object({ customerId: zUuid }),
  z.object({ name: z.string().trim().min(1).max(100), nameKana: zOptText(100), email: zOptEmail, phone: zPhone }),
]);

const CreateSchema = z.object({
  locationId: zUuid,
  serviceId: zUuid,
  staffId: zUuid.nullable().default(null),
  startsAt: zIso,
  partySize: z.number().int().min(1).max(500).default(1),
  customer: CustomerInput,
  customerRequest: zOptText(2000),
  internalNote: zOptText(4000),
  answers: z.array(z.object({ questionId: zUuid, value: z.unknown() })).max(50).default([]),
  channel: z.enum(['staff', 'reception']).default('staff'),
  force: z.boolean().default(false),
  forceReason: zOptText(500),
  idempotencyKey: zIdempotencyKey,
  previousBookingId: zUuid.nullable().optional(),
  waitlistEntryId: zUuid.nullable().optional(),
});

async function loadAccessible(q: Q, ctx: AuthContext, id: string, all: Permission, own: Permission): Promise<BookingRow> {
  const b = await q.maybeOne<BookingRow>('SELECT * FROM bookings WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
  if (!b) throw notFound('予約');
  assertBookingAccess(ctx, b, all, own);
  return b;
}

export async function registerBookingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  // ---- 空き枠(管理側) ----
  app.get('/api/v1/availability', async (req) => {
    const ctx = requireAuth(req, 'booking.create.all', 'booking.create.own', 'booking.update.all', 'booking.update.own');
    const qy = parse(
      z.object({
        locationId: zUuid,
        serviceId: zUuid,
        date: zDate,
        staffId: zUuid.optional(),
        partySize: z.coerce.number().int().min(1).max(500).default(1),
        excludeBookingId: zUuid.optional(),
      }),
      req.query,
    );
    if (!canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    const ownOnly = !can(ctx, 'booking.create.all') && !can(ctx, 'booking.update.all');
    const staffChoice = ownOnly ? ctx.staffId : (qy.staffId ?? 'auto');
    if (ownOnly && !staffChoice) throw forbidden('スタッフとして紐付けられていないため予約を作成できません');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const loc = await q.maybeOne<{ timezone: string }>('SELECT timezone FROM locations WHERE organization_id = $1 AND id = $2', [ctx.orgId, qy.locationId]);
      if (!loc) throw notFound('拠点');
      const day = localDayRange(qy.date, loc.timezone);
      const input = await loadEngineInput(q, {
        orgId: ctx.orgId,
        locationId: qy.locationId,
        serviceId: qy.serviceId,
        from: day.start,
        to: day.end,
        now: clock.now(),
        mode: 'staff',
        partySize: qy.partySize,
      });
      if (!input) throw notFound('サービス');
      if (qy.excludeBookingId) {
        // 変更時: 自分の占有を除いて計算(実際の確定時は旧占有を解放してから再判定)
        const own = await q.maybeOne<{ occupancy_id: string | null; party_size: number }>(
          'SELECT occupancy_id, party_size FROM bookings WHERE organization_id = $1 AND id = $2',
          [ctx.orgId, qy.excludeBookingId],
        );
        if (own?.occupancy_id) {
          input.occupancies = input.occupancies
            .map((o) => (o.id === own.occupancy_id ? { ...o, seatsTaken: o.seatsTaken - own.party_size } : o))
            .filter((o) => o.seatsTaken > 0);
        }
      }
      const slots = listSlots(input, qy.date, input.service.requiresStaff ? (staffChoice ?? 'auto') : 'auto');
      const names = new Map(input.staff.map((s) => [s.id, s.displayName]));
      return {
        date: qy.date,
        timezone: loc.timezone,
        slots: slots.map((s) => ({
          startsAt: s.start,
          endsAt: s.end,
          seatsAvailable: s.seatsAvailable,
          staff: s.options.map((o) => ({ staffId: o.staffId, name: o.staffId ? names.get(o.staffId) : null, seatsAvailable: o.seatsAvailable, join: Boolean(o.joinOccupancyId) })),
        })),
      };
    });
  });

  // 指定時刻の可否と理由(強制予約の確認用)
  app.post('/api/v1/availability/check', async (req) => {
    const ctx = requireAuth(req, 'booking.create.all', 'booking.create.own', 'booking.update.all', 'booking.update.own');
    const body = parse(
      z.object({ locationId: zUuid, serviceId: zUuid, staffId: zUuid.nullable().default(null), startsAt: zIso, partySize: z.number().int().min(1).max(500).default(1) }),
      req.body,
    );
    if (!canAccessLocation(ctx, body.locationId)) throw notFound('拠点');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const start = new Date(body.startsAt);
      const input = await loadEngineInput(q, {
        orgId: ctx.orgId,
        locationId: body.locationId,
        serviceId: body.serviceId,
        from: start,
        to: start,
        now: clock.now(),
        mode: 'staff',
        force: can(ctx, 'booking.force'),
        partySize: body.partySize,
      });
      if (!input) throw notFound('サービス');
      const r = evaluateStart(input, start, input.service.requiresStaff ? (body.staffId ?? 'auto') : null);
      return {
        ok: r.ok,
        requiresForce: r.ok && r.violations.length > 0,
        staffId: r.option?.staffId ?? null,
        violations: r.violations.map((x) => ({ code: x.code, hard: x.hard, message: x.message })),
      };
    });
  });

  // ---- 予約 ----
  app.get('/api/v1/bookings', async (req) => {
    const ctx = requireAuth(req, 'booking.read.all', 'booking.read.own');
    const qy = parse(
      z.object({
        from: zIso.optional(),
        to: zIso.optional(),
        locationId: zUuid.optional(),
        staffId: zUuid.optional(),
        customerId: zUuid.optional(),
        status: z.enum(BOOKING_STATUSES).optional(),
        code: z.string().max(20).optional(),
        consumptionReview: z.enum(['pending']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        order: z.enum(['asc', 'desc']).default('asc'),
      }),
      req.query,
    );
    if (qy.locationId && !canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    const ownOnly = !can(ctx, 'booking.read.all');
    if (ownOnly && !ctx.staffId) return { items: [] };
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<BookingListRow>(
        `SELECT b.*, c.name AS customer_name, c.name_kana AS customer_kana, c.status AS customer_status
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1
            AND ($2::timestamptz IS NULL OR b.starts_at >= $2) AND ($3::timestamptz IS NULL OR b.starts_at < $3)
            AND ($4::uuid IS NULL OR b.location_id = $4)
            AND ($5::uuid IS NULL OR b.staff_id = $5)
            AND ($6::uuid IS NULL OR b.customer_id = $6)
            AND ($7::text IS NULL OR b.status = $7)
            AND ($8::uuid[] IS NULL OR b.location_id = ANY($8::uuid[]))
            AND ($9::text IS NULL OR b.code = upper($9))
            AND ($10::text IS NULL OR b.consumption_review = $10)
          ORDER BY b.starts_at ${qy.order === 'desc' ? 'DESC' : 'ASC'}, b.id ${qy.order === 'desc' ? 'DESC' : 'ASC'}
          LIMIT $11`,
        [
          ctx.orgId,
          qy.from ?? null,
          qy.to ?? null,
          qy.locationId ?? null,
          ownOnly ? ctx.staffId : (qy.staffId ?? null),
          qy.customerId ?? null,
          qy.status ?? null,
          locationScope(ctx),
          qy.code ?? null,
          qy.consumptionReview ?? null,
          qy.limit,
        ],
      );
      return { items: rows.map((r) => bookingDto(r, ctx)) };
    });
  });

  app.get('/api/v1/bookings/:id', async (req) => {
    const ctx = requireAuth(req, 'booking.read.all', 'booking.read.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const b = await loadAccessible(q, ctx, id, 'booking.read.all', 'booking.read.own');
      const c = await q.one<{ name: string; name_kana: string | null; email: string | null; phone: string | null; status: string }>(
        'SELECT name, name_kana, email, phone, status FROM customers WHERE organization_id = $1 AND id = $2',
        [ctx.orgId, b.customer_id],
      );
      const answers = await q.many<{ question_snapshot: Record<string, unknown>; answer: unknown }>(
        'SELECT question_snapshot, answer FROM booking_answers WHERE organization_id = $1 AND booking_id = $2 ORDER BY sort_order',
        [ctx.orgId, id],
      );
      const events = await q.many<{ event_type: string; from_status: string | null; to_status: string | null; data: unknown; actor_type: string; actor_label: string | null; created_at: Date }>(
        `SELECT event_type, from_status, to_status, data, actor_type, actor_label, created_at FROM booking_events
          WHERE organization_id = $1 AND booking_id = $2 ORDER BY created_at, id`,
        [ctx.orgId, id],
      );
      const resources = b.occupancy_id
        ? await q.many<{ name: string }>(
            `SELECT r.name FROM occupancy_resources orr JOIN resources r ON r.id = orr.resource_id
              WHERE orr.organization_id = $1 AND orr.occupancy_id = $2`,
            [ctx.orgId, b.occupancy_id],
          )
        : [];
      const record = await q.maybeOne<{ id: string }>(
        `SELECT id FROM service_records WHERE organization_id = $1 AND booking_id = $2 AND status = 'active'`,
        [ctx.orgId, id],
      );
      return {
        ...bookingDto({ ...b, customer_name: c.name, customer_kana: c.name_kana, customer_status: c.status } as BookingListRow, ctx),
        customer: { id: b.customer_id, name: c.name, nameKana: c.name_kana, email: c.email, phone: c.phone, status: c.status },
        contactSnapshot: b.contact_snapshot,
        answers: answers.map((x) => ({ question: x.question_snapshot, answer: x.answer })),
        events: events.map((e) => ({ type: e.event_type, from: e.from_status, to: e.to_status, data: e.data, actorType: e.actor_type, actorLabel: e.actor_label, at: e.created_at })),
        resources: resources.map((r) => r.name),
        serviceRecordId: record?.id ?? null,
      };
    });
  });

  app.post('/api/v1/bookings', async (req) => {
    const ctx = requireAuth(req, 'booking.create.all', 'booking.create.own');
    const body = parse(CreateSchema, req.body);
    if (!canAccessLocation(ctx, body.locationId)) throw notFound('拠点');
    if (!can(ctx, 'booking.create.all')) {
      // Staff: 自分が担当する予約のみ
      if (!ctx.staffId) throw forbidden('スタッフとして紐付けられていないため予約を作成できません');
      if (body.staffId && body.staffId !== ctx.staffId) throw forbidden('自分以外のスタッフの予約は作成できません');
      body.staffId = ctx.staffId;
    }
    if ('customerId' in body.customer === false && !can(ctx, 'customer.create')) throw forbidden();
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const r = await createBooking(q, deps, ctx.orgId, bookingActor(ctx, req.id), {
          ...body,
          startsAt: new Date(body.startsAt),
          customer: body.customer,
        });
        return { ...bookingDto(r.booking, ctx), created: r.created };
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.patch('/api/v1/bookings/:id', async (req) => {
    const ctx = requireAuth(req, 'booking.update.all', 'booking.update.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ internalNote: zOptText(4000).optional(), customerRequest: zOptText(2000).optional(), expectedVersion: z.number().int() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const b = await loadBookingForUpdate(q, ctx.orgId, id);
      assertBookingAccess(ctx, b, 'booking.update.all', 'booking.update.own');
      if (b.version !== body.expectedVersion) throw new AppError('VERSION_CONFLICT', '他の操作で内容が更新されています。再読み込みしてください。');
      if (body.internalNote !== undefined && !can(ctx, 'booking.internal_note')) throw forbidden();
      const updated = await q.one<BookingRow>(
        `UPDATE bookings SET internal_note = CASE WHEN $3 THEN $4 ELSE internal_note END,
                customer_request = CASE WHEN $5 THEN $6 ELSE customer_request END, version = version + 1
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.orgId, id, body.internalNote !== undefined, body.internalNote ?? null, body.customerRequest !== undefined, body.customerRequest ?? null],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'booking.notes_updated',
        targetType: 'booking',
        targetId: id,
        locationId: b.location_id,
        after: { internalNote: body.internalNote, customerRequest: body.customerRequest },
        requestId: req.id,
      });
      return bookingDto(updated, ctx);
    });
  });

  app.post('/api/v1/bookings/:id/reschedule', async (req) => {
    const ctx = requireAuth(req, 'booking.update.all', 'booking.update.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({
        startsAt: zIso.optional(),
        staffId: zUuid.nullable().optional(),
        locationId: zUuid.optional(),
        partySize: z.number().int().min(1).max(500).optional(),
        expectedVersion: z.number().int(),
        force: z.boolean().default(false),
        forceReason: zOptText(500),
      }),
      req.body,
    );
    if (body.locationId && !canAccessLocation(ctx, body.locationId)) throw notFound('拠点');
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.update.all', 'booking.update.own');
        if (!can(ctx, 'booking.update.all') && body.staffId && body.staffId !== ctx.staffId) throw forbidden('担当者を他のスタッフに変更する権限がありません');
        const updated = await rescheduleBooking(q, deps, ctx.orgId, bookingActor(ctx, req.id), id, {
          startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
          staffId: body.staffId,
          locationId: body.locationId,
          partySize: body.partySize,
          expectedVersion: body.expectedVersion,
          force: body.force,
          forceReason: body.forceReason,
        });
        return bookingDto(updated, ctx);
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.post('/api/v1/bookings/:id/cancel', async (req) => {
    const ctx = requireAuth(req, 'booking.cancel.all', 'booking.cancel.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ by: z.enum(['customer', 'business']), reason: zOptText(500), expectedVersion: z.number().int().optional() }),
      req.body,
    );
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.cancel.all', 'booking.cancel.own');
        const updated = await cancelBooking(q, deps, ctx.orgId, bookingActor(ctx, req.id), id, body);
        return bookingDto(updated, ctx);
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.post('/api/v1/bookings/:id/status', async (req) => {
    const ctx = requireAuth(req, 'booking.status.all', 'booking.status.own');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ to: z.enum(['confirmed', 'arrived', 'in_service', 'no_show']), expectedVersion: z.number().int().optional() }),
      req.body,
    );
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.status.all', 'booking.status.own');
        const updated = await changeStatus(q, deps, ctx.orgId, bookingActor(ctx, req.id), id, body.to, body.expectedVersion);
        return bookingDto(updated, ctx);
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.post('/api/v1/bookings/:id/restore', async (req) => {
    const ctx = requireAuth(req, 'booking.restore');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ force: z.boolean().default(false), forceReason: zOptText(500) }), req.body ?? {});
    return withTenant(
      pool,
      { orgId: ctx.orgId, userId: ctx.userId },
      async (q) => {
        const b = await loadBookingForUpdate(q, ctx.orgId, id);
        assertBookingAccess(ctx, b, 'booking.update.all', 'booking.update.own');
        const updated = await restoreBooking(q, deps, ctx.orgId, bookingActor(ctx, req.id), id, body);
        return bookingDto(updated, ctx);
      },
      { lockTimeoutMs: 10000 },
    );
  });
}
