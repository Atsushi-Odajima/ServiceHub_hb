import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../audit.js';
import { canAccessLocation, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zOptEmail, zOptText, zPhone, zUuid } from '../../http/validate.js';
import { resolveCustomer } from '../customers/identity.js';
import { assertCustomerVisible } from '../customers/visibility.js';
import { cancelWaitlistEntry, createWaitlistEntry, notifyWaitlistMatch, refreshWaitlistMatches, type WaitlistEntryRow } from './service.js';

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時刻は HH:MM で指定してください');

export const WaitlistBody = z.object({
  locationId: zUuid,
  serviceId: zUuid,
  staffId: zUuid.nullable().default(null),
  dateFrom: zDate,
  dateTo: zDate,
  timeFrom: zTime.nullable().default(null),
  timeTo: zTime.nullable().default(null),
  partySize: z.number().int().min(1).max(50).default(1),
  note: zOptText(500),
});

interface ListRow extends WaitlistEntryRow {
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service_name: string;
  staff_name: string | null;
  location_name: string;
  timezone: string;
}

export function entryDto(e: ListRow, matches: { id: string; starts_at: Date; staff_id: string | null; status: string; notified_at: Date | null }[]) {
  return {
    id: e.id,
    customerId: e.customer_id,
    customerName: e.customer_name,
    customerPhone: e.customer_phone,
    hasEmail: Boolean(e.customer_email),
    locationId: e.location_id,
    locationName: e.location_name,
    timezone: e.timezone,
    serviceId: e.service_id,
    serviceName: e.service_name,
    staffId: e.staff_id,
    staffName: e.staff_name,
    dateFrom: e.date_from,
    dateTo: e.date_to,
    timeFrom: e.time_from?.slice(0, 5) ?? null,
    timeTo: e.time_to?.slice(0, 5) ?? null,
    partySize: e.party_size,
    status: e.status,
    source: e.source,
    note: e.note,
    notifiedAt: e.notified_at,
    bookedBookingId: e.booked_booking_id,
    matchedAt: e.matched_at,
    cancelReason: e.cancel_reason,
    expiresAt: e.expires_at,
    createdAt: e.created_at,
    matches: matches.map((m) => ({ id: m.id, startsAt: m.starts_at, staffId: m.staff_id, status: m.status, notifiedAt: m.notified_at })),
  };
}

export async function registerWaitlistRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/waitlist', async (req) => {
    const ctx = requireAuth(req, 'waitlist.read');
    const qy = parse(
      z.object({
        status: z.enum(['active', 'booked', 'expired', 'canceled', 'all']).default('active'),
        locationId: zUuid.optional(),
        customerId: zUuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    if (qy.locationId && !canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const statuses = qy.status === 'active' ? ['waiting', 'notified'] : qy.status === 'all' ? null : [qy.status];
      const rows = await q.many<ListRow>(
        `SELECT e.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, s.name AS service_name,
                st.display_name AS staff_name, l.name AS location_name, l.timezone
           FROM waitlist_entries e
           JOIN customers c ON c.id = e.customer_id JOIN services s ON s.id = e.service_id JOIN locations l ON l.id = e.location_id
           LEFT JOIN staff st ON st.id = e.staff_id
          WHERE e.organization_id = $1 AND ($2::text[] IS NULL OR e.status = ANY($2::text[]))
            AND ($3::uuid IS NULL OR e.location_id = $3) AND ($4::uuid[] IS NULL OR e.location_id = ANY($4::uuid[]))
            AND ($5::uuid IS NULL OR e.customer_id = $5)
          ORDER BY CASE WHEN e.status IN ('waiting','notified') THEN 0 ELSE 1 END, e.date_from, e.created_at, e.id
          LIMIT $6`,
        [ctx.orgId, statuses, qy.locationId ?? null, locationScope(ctx), qy.customerId ?? null, qy.limit],
      );
      const ids = rows.map((r) => r.id);
      const matches = ids.length
        ? await q.many<{ id: string; waitlist_entry_id: string; starts_at: Date; staff_id: string | null; status: string; notified_at: Date | null }>(
            `SELECT id, waitlist_entry_id, starts_at, staff_id, status, notified_at FROM waitlist_matches
              WHERE organization_id = $1 AND waitlist_entry_id = ANY($2::uuid[]) AND status IN ('open','notified','booked') AND starts_at > $3
              ORDER BY starts_at, id`,
            [ctx.orgId, ids, clock.now()],
          )
        : [];
      return { items: rows.map((r) => entryDto(r, matches.filter((m) => m.waitlist_entry_id === r.id))) };
    });
  });

  app.post('/api/v1/waitlist', async (req) => {
    const ctx = requireAuth(req, 'waitlist.manage');
    const body = parse(
      WaitlistBody.extend({
        customer: z.union([
          z.object({ customerId: zUuid }),
          z.object({ name: z.string().trim().min(1).max(100), nameKana: zOptText(100), email: zOptEmail, phone: zPhone }),
        ]),
      }),
      req.body,
    );
    if (!canAccessLocation(ctx, body.locationId)) throw notFound('拠点');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      if ('customerId' in body.customer) await assertCustomerVisible(q, ctx, body.customer.customerId, clock.now());
      const c = await resolveCustomer(q, ctx.orgId, body.customer, { source: 'staff', createdBy: ctx.membershipId });
      const r = await createWaitlistEntry(q, deps, ctx.orgId, actorOf(ctx), {
        ...body,
        customerId: c.customerId,
        source: 'staff',
        createdBy: ctx.membershipId,
        requestId: req.id,
      });
      return { id: r.id, created: r.created };
    });
  });

  const loadEntry = async (q: Parameters<Parameters<typeof withTenant>[2]>[0], orgId: string, id: string) => {
    const e = await q.maybeOne<{ id: string; location_id: string }>('SELECT id, location_id FROM waitlist_entries WHERE organization_id = $1 AND id = $2', [orgId, id]);
    if (!e) throw notFound('待機');
    return e;
  };

  app.post('/api/v1/waitlist/:id/refresh', async (req) => {
    const ctx = requireAuth(req, 'waitlist.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const e = await loadEntry(q, ctx.orgId, id);
      if (!canAccessLocation(ctx, e.location_id)) throw notFound('待機');
      return refreshWaitlistMatches(q, deps, ctx.orgId, { entryIds: [id] });
    });
  });

  app.post('/api/v1/waitlist/:id/cancel', async (req) => {
    const ctx = requireAuth(req, 'waitlist.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ reason: zOptText(500) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const e = await loadEntry(q, ctx.orgId, id);
      if (!canAccessLocation(ctx, e.location_id)) throw notFound('待機');
      await cancelWaitlistEntry(q, ctx.orgId, actorOf(ctx), id, body.reason, req.id);
      return { ok: true };
    });
  });

  const loadMatch = async (q: Parameters<Parameters<typeof withTenant>[2]>[0], orgId: string, id: string) => {
    const m = await q.maybeOne<{ id: string; location_id: string; status: string }>('SELECT id, location_id, status FROM waitlist_matches WHERE organization_id = $1 AND id = $2', [orgId, id]);
    if (!m) throw notFound('候補');
    return m;
  };

  app.post('/api/v1/waitlist/matches/:id/notify', async (req) => {
    const ctx = requireAuth(req, 'waitlist.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ method: z.enum(['email', 'manual']) }), req.body);
    const r = await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const m = await loadMatch(q, ctx.orgId, id);
      if (!canAccessLocation(ctx, m.location_id)) throw notFound('候補');
      return notifyWaitlistMatch(q, deps, ctx.orgId, actorOf(ctx), id, body.method, req.id);
    });
    // 埋まっていた場合も候補の状態(stale)は保存済み。画面へは競合として返す
    if (r.result === 'stale') throw new AppError('SLOT_UNAVAILABLE', 'この空きはすでに埋まりました(候補を更新しました)');
    return r;
  });

  app.post('/api/v1/waitlist/matches/:id/dismiss', async (req) => {
    const ctx = requireAuth(req, 'waitlist.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const m = await loadMatch(q, ctx.orgId, id);
      if (!canAccessLocation(ctx, m.location_id)) throw notFound('候補');
      await q.exec(`UPDATE waitlist_matches SET status = 'dismissed' WHERE organization_id = $1 AND id = $2 AND status IN ('open','notified')`, [ctx.orgId, id]);
      return { ok: true };
    });
  });

}
