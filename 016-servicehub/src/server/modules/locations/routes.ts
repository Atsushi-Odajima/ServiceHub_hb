import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BookingPageSchema, parseBookingPage } from '../../../shared/constants.js';
import { isValidZone, localDayRange, timeToMinutes } from '../../../shared/time.js';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { assertLocation, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zIso, zOptEmail, zOptText, zPhone, zSlug, zTime, zUuid } from '../../http/validate.js';

export interface LocationRow {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  status: string;
  is_public: boolean;
  booking_page: unknown;
  slot_interval_min: number;
  min_notice_min: number;
  max_advance_days: number;
  max_concurrent_sessions: number | null;
  cancel_deadline_hours: number;
  allow_customer_cancel: boolean;
  allow_customer_reschedule: boolean;
  allow_public_waitlist: boolean;
  sort_order: number;
}

export function locationDto(l: LocationRow) {
  return {
    id: l.id,
    slug: l.slug,
    name: l.name,
    address: l.address,
    phone: l.phone,
    email: l.email,
    timezone: l.timezone,
    status: l.status,
    isPublic: l.is_public,
    bookingPage: parseBookingPage(l.booking_page),
    slotIntervalMin: l.slot_interval_min,
    minNoticeMin: l.min_notice_min,
    maxAdvanceDays: l.max_advance_days,
    maxConcurrentSessions: l.max_concurrent_sessions,
    cancelDeadlineHours: l.cancel_deadline_hours,
    allowCustomerCancel: l.allow_customer_cancel,
    allowCustomerReschedule: l.allow_customer_reschedule,
    allowPublicWaitlist: l.allow_public_waitlist,
    sortOrder: l.sort_order,
  };
}

const LocationBase = z.object({
  slug: zSlug,
  name: z.string().trim().min(1).max(100),
  address: zOptText(300),
  phone: zPhone,
  email: zOptEmail,
  timezone: z.string().refine(isValidZone, 'タイムゾーンが正しくありません').default('Asia/Tokyo'),
  isPublic: z.boolean().default(true),
  bookingPage: BookingPageSchema.partial().optional(),
  slotIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]).default(30),
  minNoticeMin: z.number().int().min(0).max(43200).default(60),
  maxAdvanceDays: z.number().int().min(1).max(366).default(60),
  maxConcurrentSessions: z.number().int().min(1).max(1000).nullable().default(null),
  cancelDeadlineHours: z.number().int().min(0).max(720).default(24),
  allowCustomerCancel: z.boolean().default(true),
  allowCustomerReschedule: z.boolean().default(true),
  allowPublicWaitlist: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

const HoursSchema = z.object({
  hours: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), openTime: zTime, closeTime: zTime }))
    .max(50),
});

export function validateRanges(ranges: { weekday: number; openTime: string; closeTime: string }[]): void {
  const byDay = new Map<number, [number, number][]>();
  for (const r of ranges) {
    const s = timeToMinutes(r.openTime);
    const e = timeToMinutes(r.closeTime);
    if (e <= s) throw new AppError('VALIDATION_ERROR', '終了時刻は開始時刻より後にしてください');
    const list = byDay.get(r.weekday) ?? [];
    for (const [ps, pe] of list) {
      if (s < pe && e > ps) throw new AppError('VALIDATION_ERROR', '同じ曜日の時間帯が重なっています');
    }
    list.push([s, e]);
    byDay.set(r.weekday, list);
  }
}

async function loadLocation(q: Q, orgId: string, id: string): Promise<LocationRow> {
  const l = await q.maybeOne<LocationRow>('SELECT * FROM locations WHERE organization_id = $1 AND id = $2', [orgId, id]);
  if (!l) throw notFound('拠点');
  return l;
}

export async function registerLocationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/locations', async (req) => {
    const ctx = requireAuth(req);
    const { includeArchived } = parse(z.object({ includeArchived: z.enum(['true', 'false']).optional() }), req.query);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<LocationRow>(
        `SELECT * FROM locations
          WHERE organization_id = $1 AND ($2::boolean OR status = 'active')
            AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
          ORDER BY sort_order, name, id`,
        [ctx.orgId, includeArchived === 'true', ctx.allLocations ? null : ctx.locationIds],
      );
      return { items: rows.map(locationDto) };
    });
  });

  app.get('/api/v1/locations/:id', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    assertLocation(ctx, id);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const l = await loadLocation(q, ctx.orgId, id);
      const hours = await q.many<{ weekday: number; open_time: string; close_time: string }>(
        'SELECT weekday, open_time, close_time FROM location_hours WHERE organization_id = $1 AND location_id = $2 ORDER BY weekday, open_time',
        [ctx.orgId, id],
      );
      return {
        ...locationDto(l),
        hours: hours.map((h) => ({ weekday: h.weekday, openTime: h.open_time.slice(0, 5), closeTime: h.close_time.slice(0, 5) })),
      };
    });
  });

  app.post('/api/v1/locations', async (req) => {
    const ctx = requireAuth(req, 'location.manage');
    const body = parse(LocationBase.extend({ hours: HoursSchema.shape.hours.optional() }), req.body);
    if (body.hours) validateRanges(body.hours);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const dup = await q.maybeOne('SELECT 1 FROM locations WHERE organization_id = $1 AND slug = $2', [ctx.orgId, body.slug]);
      if (dup) throw new AppError('CONFLICT', 'このURL名(スラッグ)はすでに使われています', { fields: { slug: '重複しています' } });
      const l = await q.one<LocationRow>(
        `INSERT INTO locations (organization_id, slug, name, address, phone, email, timezone, is_public, booking_page,
                                slot_interval_min, min_notice_min, max_advance_days, max_concurrent_sessions,
                                cancel_deadline_hours, allow_customer_cancel, allow_customer_reschedule, allow_public_waitlist, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [
          ctx.orgId,
          body.slug,
          body.name,
          body.address,
          body.phone,
          body.email,
          body.timezone,
          body.isPublic,
          JSON.stringify(BookingPageSchema.parse(body.bookingPage ?? {})),
          body.slotIntervalMin,
          body.minNoticeMin,
          body.maxAdvanceDays,
          body.maxConcurrentSessions,
          body.cancelDeadlineHours,
          body.allowCustomerCancel,
          body.allowCustomerReschedule,
          body.allowPublicWaitlist,
          body.sortOrder,
        ],
      );
      for (const h of body.hours ?? []) {
        await q.exec(
          'INSERT INTO location_hours (organization_id, location_id, weekday, open_time, close_time) VALUES ($1,$2,$3,$4,$5)',
          [ctx.orgId, l.id, h.weekday, h.openTime, h.closeTime],
        );
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'location.created',
        targetType: 'location',
        targetId: l.id,
        locationId: l.id,
        after: { slug: l.slug, name: l.name, timezone: l.timezone },
        requestId: req.id,
      });
      return locationDto(l);
    });
  });

  app.patch('/api/v1/locations/:id', async (req) => {
    const ctx = requireAuth(req, 'location.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(LocationBase.partial(), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<LocationRow>('SELECT * FROM locations WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.orgId, id]);
      if (!cur) throw notFound('拠点');
      if (body.slug && body.slug !== cur.slug) {
        const dup = await q.maybeOne('SELECT 1 FROM locations WHERE organization_id = $1 AND slug = $2 AND id <> $3', [ctx.orgId, body.slug, id]);
        if (dup) throw new AppError('CONFLICT', 'このURL名(スラッグ)はすでに使われています', { fields: { slug: '重複しています' } });
      }
      const bookingPage = body.bookingPage ? BookingPageSchema.parse({ ...parseBookingPage(cur.booking_page), ...body.bookingPage }) : parseBookingPage(cur.booking_page);
      const next = {
        slug: body.slug ?? cur.slug,
        name: body.name ?? cur.name,
        address: body.address !== undefined ? body.address : cur.address,
        phone: body.phone !== undefined ? body.phone : cur.phone,
        email: body.email !== undefined ? body.email : cur.email,
        timezone: body.timezone ?? cur.timezone,
        is_public: body.isPublic ?? cur.is_public,
        booking_page: bookingPage,
        slot_interval_min: body.slotIntervalMin ?? cur.slot_interval_min,
        min_notice_min: body.minNoticeMin ?? cur.min_notice_min,
        max_advance_days: body.maxAdvanceDays ?? cur.max_advance_days,
        max_concurrent_sessions: body.maxConcurrentSessions !== undefined ? body.maxConcurrentSessions : cur.max_concurrent_sessions,
        cancel_deadline_hours: body.cancelDeadlineHours ?? cur.cancel_deadline_hours,
        allow_customer_cancel: body.allowCustomerCancel ?? cur.allow_customer_cancel,
        allow_customer_reschedule: body.allowCustomerReschedule ?? cur.allow_customer_reschedule,
        allow_public_waitlist: body.allowPublicWaitlist ?? cur.allow_public_waitlist,
        sort_order: body.sortOrder ?? cur.sort_order,
      };
      const updated = await q.one<LocationRow>(
        `UPDATE locations SET slug=$3, name=$4, address=$5, phone=$6, email=$7, timezone=$8, is_public=$9, booking_page=$10,
                slot_interval_min=$11, min_notice_min=$12, max_advance_days=$13, max_concurrent_sessions=$14,
                cancel_deadline_hours=$15, allow_customer_cancel=$16, allow_customer_reschedule=$17, allow_public_waitlist=$18, sort_order=$19
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [
          ctx.orgId,
          id,
          next.slug,
          next.name,
          next.address,
          next.phone,
          next.email,
          next.timezone,
          next.is_public,
          JSON.stringify(next.booking_page),
          next.slot_interval_min,
          next.min_notice_min,
          next.max_advance_days,
          next.max_concurrent_sessions,
          next.cancel_deadline_hours,
          next.allow_customer_cancel,
          next.allow_customer_reschedule,
          next.allow_public_waitlist,
          next.sort_order,
        ],
      );
      const diff = changes({ ...cur, booking_page: parseBookingPage(cur.booking_page) } as unknown as Record<string, unknown>, next);
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), {
          action: 'location.updated',
          targetType: 'location',
          targetId: id,
          locationId: id,
          before: diff.before,
          after: diff.after,
          requestId: req.id,
        });
      }
      return locationDto(updated);
    });
  });

  app.post('/api/v1/locations/:id/archive', async (req) => {
    const ctx = requireAuth(req, 'location.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await loadLocation(q, ctx.orgId, id);
      if (body.archived) {
        const future = await q.one<{ n: number }>(
          `SELECT count(*) AS n FROM bookings WHERE organization_id = $1 AND location_id = $2
             AND status IN ('confirmed','arrived','in_service') AND starts_at > $3`,
          [ctx.orgId, id, deps.clock.now()],
        );
        if (future.n > 0) {
          throw new AppError('INVALID_STATE', `この拠点には今後の予約が${future.n}件あります。先に予約を移動またはキャンセルしてください。`);
        }
      }
      await q.exec(
        `UPDATE locations SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE NULL END,
                is_public = CASE WHEN $3 = 'archived' THEN false ELSE is_public END
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.archived ? 'archived' : 'active'],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: body.archived ? 'location.archived' : 'location.restored',
        targetType: 'location',
        targetId: id,
        locationId: id,
        before: { status: cur.status },
        after: { status: body.archived ? 'archived' : 'active' },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  app.put('/api/v1/locations/:id/hours', async (req) => {
    const ctx = requireAuth(req, 'location.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(HoursSchema, req.body);
    validateRanges(body.hours);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await loadLocation(q, ctx.orgId, id);
      const before = await q.many('SELECT weekday, open_time, close_time FROM location_hours WHERE organization_id = $1 AND location_id = $2 ORDER BY 1,2', [ctx.orgId, id]);
      await q.exec('DELETE FROM location_hours WHERE organization_id = $1 AND location_id = $2', [ctx.orgId, id]);
      for (const h of body.hours) {
        await q.exec(
          'INSERT INTO location_hours (organization_id, location_id, weekday, open_time, close_time) VALUES ($1,$2,$3,$4,$5)',
          [ctx.orgId, id, h.weekday, h.openTime, h.closeTime],
        );
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'location.hours_updated',
        targetType: 'location',
        targetId: id,
        locationId: id,
        before: { hours: before },
        after: { hours: body.hours },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  // ---- 臨時休業/特別営業 ----
  app.get('/api/v1/locations/:id/exceptions', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { from, to } = parse(z.object({ from: zDate, to: zDate }), req.query);
    assertLocation(ctx, id);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{ id: string; date: string; kind: string; open_time: string | null; close_time: string | null; note: string | null }>(
        `SELECT id, date, kind, open_time, close_time, note FROM location_exceptions
          WHERE organization_id = $1 AND location_id = $2 AND date BETWEEN $3 AND $4 ORDER BY date, open_time NULLS FIRST`,
        [ctx.orgId, id, from, to],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          date: r.date,
          kind: r.kind,
          openTime: r.open_time?.slice(0, 5) ?? null,
          closeTime: r.close_time?.slice(0, 5) ?? null,
          note: r.note,
        })),
      };
    });
  });

  app.post('/api/v1/locations/:id/exceptions', async (req) => {
    const ctx = requireAuth(req, 'location.schedule.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    assertLocation(ctx, id);
    const body = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('closed'), date: zDate, note: zOptText(200) }),
        z.object({ kind: z.literal('special_hours'), date: zDate, openTime: zTime, closeTime: zTime, note: zOptText(200) }),
      ]),
      req.body,
    );
    if (body.kind === 'special_hours' && timeToMinutes(body.closeTime) <= timeToMinutes(body.openTime)) {
      throw new AppError('VALIDATION_ERROR', '終了時刻は開始時刻より後にしてください');
    }
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const loc = await loadLocation(q, ctx.orgId, id);
      if (body.kind === 'closed') {
        // 臨時休業はその日の他の例外(特別営業)を置き換える
        await q.exec('DELETE FROM location_exceptions WHERE organization_id = $1 AND location_id = $2 AND date = $3', [ctx.orgId, id, body.date]);
      } else {
        await q.exec(
          `DELETE FROM location_exceptions WHERE organization_id = $1 AND location_id = $2 AND date = $3 AND kind = 'closed'`,
          [ctx.orgId, id, body.date],
        );
      }
      const row = await q.one<{ id: string }>(
        `INSERT INTO location_exceptions (organization_id, location_id, date, kind, open_time, close_time, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.orgId, id, body.date, body.kind, body.kind === 'special_hours' ? body.openTime : null, body.kind === 'special_hours' ? body.closeTime : null, body.note],
      );
      const affected = await countBookingsOnDate(q, ctx.orgId, id, body.date, loc.timezone);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'location.exception_added',
        targetType: 'location',
        targetId: id,
        locationId: id,
        after: { date: body.date, kind: body.kind },
        requestId: req.id,
      });
      // 既存予約は自動でキャンセル/移動しない。件数を警告として返す
      return { id: row.id, warning: affected > 0 ? `この日には有効な予約が${affected}件あります。必要に応じて個別に連絡・変更してください。` : null };
    });
  });

  app.delete('/api/v1/locations/:id/exceptions/:exId', async (req) => {
    const ctx = requireAuth(req, 'location.schedule.manage');
    const { id, exId } = parse(z.object({ id: zUuid, exId: zUuid }), req.params);
    assertLocation(ctx, id);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.exec('DELETE FROM location_exceptions WHERE organization_id = $1 AND location_id = $2 AND id = $3', [ctx.orgId, id, exId]);
      if (n === 0) throw notFound('例外日');
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'location.exception_removed', targetType: 'location', targetId: id, locationId: id, requestId: req.id });
      return { ok: true };
    });
  });

  // ---- 予約受付停止ブロック ----
  app.get('/api/v1/locations/:id/blocks', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { from, to } = parse(z.object({ from: zIso, to: zIso }), req.query);
    assertLocation(ctx, id);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{ id: string; starts_at: Date; ends_at: Date; note: string | null }>(
        `SELECT id, starts_at, ends_at, note FROM location_blocks
          WHERE organization_id = $1 AND location_id = $2 AND starts_at < $4 AND ends_at > $3 ORDER BY starts_at, id`,
        [ctx.orgId, id, from, to],
      );
      return { items: rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, note: r.note })) };
    });
  });

  app.post('/api/v1/locations/:id/blocks', async (req) => {
    const ctx = requireAuth(req, 'location.schedule.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    assertLocation(ctx, id);
    const body = parse(z.object({ startsAt: zIso, endsAt: zIso, note: zOptText(200) }), req.body);
    if (new Date(body.endsAt) <= new Date(body.startsAt)) throw new AppError('VALIDATION_ERROR', '終了は開始より後にしてください');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await loadLocation(q, ctx.orgId, id);
      const row = await q.one<{ id: string }>(
        `INSERT INTO location_blocks (organization_id, location_id, starts_at, ends_at, note, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.orgId, id, body.startsAt, body.endsAt, body.note, ctx.membershipId],
      );
      const affected = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM bookings WHERE organization_id = $1 AND location_id = $2
           AND status IN ('confirmed','arrived','in_service') AND starts_at < $4 AND ends_at > $3`,
        [ctx.orgId, id, body.startsAt, body.endsAt],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'location.block_added',
        targetType: 'location',
        targetId: id,
        locationId: id,
        after: { startsAt: body.startsAt, endsAt: body.endsAt },
        requestId: req.id,
      });
      return { id: row.id, warning: affected.n > 0 ? `この時間帯には有効な予約が${affected.n}件あります(自動ではキャンセルされません)。` : null };
    });
  });

  app.delete('/api/v1/locations/:id/blocks/:blockId', async (req) => {
    const ctx = requireAuth(req, 'location.schedule.manage');
    const { id, blockId } = parse(z.object({ id: zUuid, blockId: zUuid }), req.params);
    assertLocation(ctx, id);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.exec('DELETE FROM location_blocks WHERE organization_id = $1 AND location_id = $2 AND id = $3', [ctx.orgId, id, blockId]);
      if (n === 0) throw notFound('ブロック');
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'location.block_removed', targetType: 'location', targetId: id, locationId: id, requestId: req.id });
      return { ok: true };
    });
  });
}

async function countBookingsOnDate(q: Q, orgId: string, locationId: string, date: string, zone: string): Promise<number> {
  const { start, end } = localDayRange(date, zone);
  const r = await q.one<{ n: number }>(
    `SELECT count(*) AS n FROM bookings
      WHERE organization_id = $1 AND location_id = $2 AND status IN ('confirmed','arrived','in_service')
        AND starts_at >= $3 AND starts_at < $4`,
    [orgId, locationId, start, end],
  );
  return r.n;
}
