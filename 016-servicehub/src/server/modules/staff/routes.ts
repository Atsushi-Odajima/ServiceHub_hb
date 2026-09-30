import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { can, locationScope, requireAuth } from '../../auth/context.js';
import { revokeMembershipSessions } from '../../auth/session.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zOptEmail, zOptText, zPhone, zUuid } from '../../http/validate.js';

const StaffBase = z.object({
  displayName: z.string().trim().min(1).max(60),
  internalName: zOptText(100),
  email: zOptEmail,
  phone: zPhone,
  publicProfile: zOptText(1000),
  acceptsBookings: z.boolean().default(true),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  locationIds: z.array(zUuid).max(100).default([]),
  serviceIds: z.array(zUuid).max(500).default([]),
});

interface StaffRow {
  id: string;
  display_name: string;
  internal_name: string | null;
  email: string | null;
  phone: string | null;
  public_profile: string | null;
  accepts_bookings: boolean;
  status: string;
  color: string | null;
  sort_order: number;
  location_ids: string[];
  service_ids: string[];
  membership_id: string | null;
  membership_role: string | null;
  membership_status: string | null;
}

async function assertIds(q: Q, orgId: string, table: 'locations' | 'services', ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await q.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids]);
  if (r.n !== new Set(ids).size) throw new AppError('VALIDATION_ERROR', table === 'locations' ? '存在しない拠点が含まれています' : '存在しないサービスが含まれています');
}

async function setRelations(q: Q, orgId: string, staffId: string, locationIds: string[], serviceIds: string[]) {
  await q.exec('DELETE FROM staff_locations WHERE organization_id = $1 AND staff_id = $2', [orgId, staffId]);
  for (const l of new Set(locationIds)) {
    await q.exec('INSERT INTO staff_locations (organization_id, staff_id, location_id) VALUES ($1,$2,$3)', [orgId, staffId, l]);
  }
  await q.exec('DELETE FROM service_staff WHERE organization_id = $1 AND staff_id = $2', [orgId, staffId]);
  for (const s of new Set(serviceIds)) {
    await q.exec('INSERT INTO service_staff (organization_id, service_id, staff_id) VALUES ($1,$2,$3)', [orgId, s, staffId]);
  }
}

const SELECT_STAFF = `
  SELECT s.id, s.display_name, s.internal_name, s.email, s.phone, s.public_profile, s.accepts_bookings, s.status, s.color, s.sort_order,
         coalesce((SELECT array_agg(sl.location_id) FROM staff_locations sl WHERE sl.staff_id = s.id), '{}') AS location_ids,
         coalesce((SELECT array_agg(ss.service_id) FROM service_staff ss WHERE ss.staff_id = s.id), '{}') AS service_ids,
         m.id AS membership_id, m.role AS membership_role, m.status AS membership_status
    FROM staff s
    LEFT JOIN memberships m ON m.organization_id = s.organization_id AND m.staff_id = s.id`;

export async function registerStaffRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  const dto = (r: StaffRow, withContact: boolean) => ({
    id: r.id,
    displayName: r.display_name,
    internalName: withContact ? r.internal_name : undefined,
    email: withContact ? r.email : undefined,
    phone: withContact ? r.phone : undefined,
    publicProfile: r.public_profile,
    acceptsBookings: r.accepts_bookings,
    status: r.status,
    color: r.color,
    sortOrder: r.sort_order,
    locationIds: r.location_ids,
    serviceIds: r.service_ids,
    login: r.membership_id ? { membershipId: r.membership_id, role: r.membership_role, status: r.membership_status } : null,
  });

  app.get('/api/v1/staff', async (req) => {
    const ctx = requireAuth(req);
    const qy = parse(z.object({ includeArchived: z.enum(['true', 'false']).optional(), locationId: zUuid.optional() }), req.query);
    const scope = locationScope(ctx);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<StaffRow>(
        `${SELECT_STAFF}
          WHERE s.organization_id = $1 AND ($2::boolean OR s.status = 'active')
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM staff_locations x WHERE x.staff_id = s.id AND x.location_id = $3))
            AND ($4::uuid[] IS NULL OR EXISTS (SELECT 1 FROM staff_locations y WHERE y.staff_id = s.id AND y.location_id = ANY($4::uuid[])))
          ORDER BY s.status, s.sort_order, s.display_name`,
        [ctx.orgId, qy.includeArchived === 'true', qy.locationId ?? null, scope],
      );
      return { items: rows.map((r) => dto(r, can(ctx, 'staff.contact.read'))) };
    });
  });

  app.get('/api/v1/staff/:id', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const r = await q.maybeOne<StaffRow>(`${SELECT_STAFF} WHERE s.organization_id = $1 AND s.id = $2`, [ctx.orgId, id]);
      if (!r) throw notFound('スタッフ');
      const scope = locationScope(ctx);
      if (scope && !r.location_ids.some((l) => scope.includes(l)) && ctx.staffId !== r.id) throw notFound('スタッフ');
      return dto(r, can(ctx, 'staff.contact.read') || ctx.staffId === r.id);
    });
  });

  app.post('/api/v1/staff', async (req) => {
    const ctx = requireAuth(req, 'staff.manage');
    const body = parse(StaffBase, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertIds(q, ctx.orgId, 'locations', body.locationIds);
      await assertIds(q, ctx.orgId, 'services', body.serviceIds);
      const s = await q.one<{ id: string }>(
        `INSERT INTO staff (organization_id, display_name, internal_name, email, phone, public_profile, accepts_bookings, color, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [ctx.orgId, body.displayName, body.internalName, body.email, body.phone, body.publicProfile, body.acceptsBookings, body.color ?? null, body.sortOrder],
      );
      await setRelations(q, ctx.orgId, s.id, body.locationIds, body.serviceIds);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'staff.created',
        targetType: 'staff',
        targetId: s.id,
        after: { displayName: body.displayName, locationIds: body.locationIds, serviceIds: body.serviceIds },
        requestId: req.id,
      });
      const r = await q.one<StaffRow>(`${SELECT_STAFF} WHERE s.organization_id = $1 AND s.id = $2`, [ctx.orgId, s.id]);
      return dto(r, true);
    });
  });

  app.patch('/api/v1/staff/:id', async (req) => {
    const ctx = requireAuth(req, 'staff.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(StaffBase.partial(), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<StaffRow>(`${SELECT_STAFF} WHERE s.organization_id = $1 AND s.id = $2`, [ctx.orgId, id]);
      if (!cur) throw notFound('スタッフ');
      if (body.locationIds) await assertIds(q, ctx.orgId, 'locations', body.locationIds);
      if (body.serviceIds) await assertIds(q, ctx.orgId, 'services', body.serviceIds);
      const next = {
        display_name: body.displayName ?? cur.display_name,
        internal_name: body.internalName !== undefined ? body.internalName : cur.internal_name,
        email: body.email !== undefined ? body.email : cur.email,
        phone: body.phone !== undefined ? body.phone : cur.phone,
        public_profile: body.publicProfile !== undefined ? body.publicProfile : cur.public_profile,
        accepts_bookings: body.acceptsBookings ?? cur.accepts_bookings,
        color: body.color !== undefined ? body.color : cur.color,
        sort_order: body.sortOrder ?? cur.sort_order,
      };
      await q.exec(
        `UPDATE staff SET display_name=$3, internal_name=$4, email=$5, phone=$6, public_profile=$7, accepts_bookings=$8, color=$9, sort_order=$10
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, next.display_name, next.internal_name, next.email, next.phone, next.public_profile, next.accepts_bookings, next.color, next.sort_order],
      );
      const locIds = body.locationIds ?? cur.location_ids;
      const svcIds = body.serviceIds ?? cur.service_ids;
      if (body.locationIds || body.serviceIds) await setRelations(q, ctx.orgId, id, locIds, svcIds);
      const diff = changes(
        { ...cur, location_ids: [...cur.location_ids].sort(), service_ids: [...cur.service_ids].sort() } as unknown as Record<string, unknown>,
        { ...next, location_ids: [...locIds].sort(), service_ids: [...svcIds].sort() },
      );
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), {
          action: 'staff.updated',
          targetType: 'staff',
          targetId: id,
          before: diff.before,
          after: diff.after,
          requestId: req.id,
        });
      }
      const r = await q.one<StaffRow>(`${SELECT_STAFF} WHERE s.organization_id = $1 AND s.id = $2`, [ctx.orgId, id]);
      return dto(r, true);
    });
  });

  /**
   * アーカイブ: 新規予約の割当不可。既存予約は自動でキャンセル/移動しない(件数を返す)。
   * ログインアカウントが紐付いている場合はメンバーシップも無効化し、全セッションを即時失効。
   */
  app.post('/api/v1/staff/:id/archive', async (req) => {
    const ctx = requireAuth(req, 'staff.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<StaffRow>(`${SELECT_STAFF} WHERE s.organization_id = $1 AND s.id = $2 FOR UPDATE OF s`, [ctx.orgId, id]);
      if (!cur) throw notFound('スタッフ');
      if (cur.membership_id && cur.membership_id === ctx.membershipId && body.archived) {
        throw new AppError('INVALID_STATE', '自分自身に紐付くスタッフはアーカイブできません');
      }
      await q.exec(
        `UPDATE staff SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE NULL END WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.archived ? 'archived' : 'active'],
      );
      let revoked = 0;
      if (body.archived && cur.membership_id) {
        if (cur.membership_role === 'owner') {
          const owners = await q.one<{ n: number }>(
            `SELECT count(*) AS n FROM memberships WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
            [ctx.orgId],
          );
          if (owners.n <= 1) throw new AppError('INVALID_STATE', 'オーナーが1人もいなくなるためアーカイブできません');
        }
        await q.exec(`UPDATE memberships SET status = 'disabled', disabled_at = now() WHERE organization_id = $1 AND id = $2`, [
          ctx.orgId,
          cur.membership_id,
        ]);
        revoked = await revokeMembershipSessions(q, cur.membership_id);
      }
      const future = await q.many<{ id: string; starts_at: Date; location_id: string }>(
        `SELECT id, starts_at, location_id FROM bookings
          WHERE organization_id = $1 AND staff_id = $2 AND status IN ('confirmed','arrived') AND starts_at > $3
          ORDER BY starts_at LIMIT 200`,
        [ctx.orgId, id, clock.now()],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: body.archived ? 'staff.archived' : 'staff.restored',
        targetType: 'staff',
        targetId: id,
        before: { status: cur.status },
        after: { status: body.archived ? 'archived' : 'active' },
        metadata: { futureBookings: future.length, membershipDisabled: Boolean(body.archived && cur.membership_id), sessionsRevoked: revoked },
        requestId: req.id,
      });
      return {
        ok: true,
        futureBookings: future.map((f) => ({ id: f.id, startsAt: f.starts_at, locationId: f.location_id })),
        warning:
          body.archived && future.length > 0
            ? `このスタッフには今後の予約が${future.length}件あります。担当変更または連絡を行ってください(自動では変更されません)。`
            : null,
        membershipDisabled: Boolean(body.archived && cur.membership_id),
      };
    });
  });
}
