import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { assertLocation, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zIso, zOptText, zTime, zUuid } from '../../http/validate.js';
import { validateRanges } from '../locations/routes.js';

const ResourceBase = z.object({
  locationId: zUuid,
  name: z.string().trim().min(1).max(60),
  category: z.string().trim().min(1).max(40).default('room'),
  capacity: z.number().int().min(1).max(100).default(1),
  note: zOptText(500),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

interface ResRow {
  id: string;
  location_id: string;
  name: string;
  category: string;
  capacity: number;
  status: string;
  note: string | null;
  sort_order: number;
}

const dto = (r: ResRow) => ({
  id: r.id,
  locationId: r.location_id,
  name: r.name,
  category: r.category,
  capacity: r.capacity,
  status: r.status,
  note: r.note,
  sortOrder: r.sort_order,
});

async function load(q: Q, orgId: string, id: string): Promise<ResRow> {
  const r = await q.maybeOne<ResRow>('SELECT * FROM resources WHERE organization_id = $1 AND id = $2', [orgId, id]);
  if (!r) throw notFound('リソース');
  return r;
}

export async function registerResourceRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/resources', async (req) => {
    const ctx = requireAuth(req);
    const qy = parse(z.object({ locationId: zUuid.optional(), includeArchived: z.enum(['true', 'false']).optional() }), req.query);
    if (qy.locationId) assertLocation(ctx, qy.locationId);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<ResRow>(
        `SELECT * FROM resources WHERE organization_id = $1 AND ($2::uuid IS NULL OR location_id = $2)
            AND ($3::uuid[] IS NULL OR location_id = ANY($3::uuid[])) AND ($4::boolean OR status <> 'archived')
          ORDER BY location_id, sort_order, name`,
        [ctx.orgId, qy.locationId ?? null, locationScope(ctx), qy.includeArchived === 'true'],
      );
      return { items: rows.map(dto) };
    });
  });

  app.get('/api/v1/resources/:id', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const r = await load(q, ctx.orgId, id);
      assertLocation(ctx, r.location_id, 'リソース');
      const hours = await q.many<{ weekday: number; start_time: string; end_time: string }>(
        'SELECT weekday, start_time, end_time FROM resource_hours WHERE organization_id = $1 AND resource_id = $2 ORDER BY weekday, start_time',
        [ctx.orgId, id],
      );
      const blocks = await q.many<{ id: string; starts_at: Date; ends_at: Date; kind: string; note: string | null }>(
        `SELECT id, starts_at, ends_at, kind, note FROM resource_blocks WHERE organization_id = $1 AND resource_id = $2 AND ends_at > $3 ORDER BY starts_at`,
        [ctx.orgId, id, clock.now()],
      );
      return {
        ...dto(r),
        hours: hours.map((h) => ({ weekday: h.weekday, openTime: h.start_time.slice(0, 5), closeTime: h.end_time.slice(0, 5) })),
        blocks: blocks.map((b) => ({ id: b.id, startsAt: b.starts_at, endsAt: b.ends_at, kind: b.kind, note: b.note })),
      };
    });
  });

  app.post('/api/v1/resources', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const body = parse(ResourceBase, req.body);
    assertLocation(ctx, body.locationId);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const loc = await q.maybeOne('SELECT 1 FROM locations WHERE organization_id = $1 AND id = $2', [ctx.orgId, body.locationId]);
      if (!loc) throw notFound('拠点');
      const r = await q.one<ResRow>(
        `INSERT INTO resources (organization_id, location_id, name, category, capacity, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.orgId, body.locationId, body.name, body.category, body.capacity, body.note, body.sortOrder],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'resource.created',
        targetType: 'resource',
        targetId: r.id,
        locationId: r.location_id,
        after: { name: r.name, capacity: r.capacity },
        requestId: req.id,
      });
      return dto(r);
    });
  });

  app.patch('/api/v1/resources/:id', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(ResourceBase.omit({ locationId: true }).partial().extend({ status: z.enum(['active', 'stopped']).optional() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await load(q, ctx.orgId, id);
      assertLocation(ctx, cur.location_id, 'リソース');
      if (cur.status === 'archived') throw new AppError('INVALID_STATE', 'アーカイブ済みのリソースは編集できません');
      const next = {
        name: body.name ?? cur.name,
        category: body.category ?? cur.category,
        capacity: body.capacity ?? cur.capacity,
        note: body.note !== undefined ? body.note : cur.note,
        sort_order: body.sortOrder ?? cur.sort_order,
        status: body.status ?? cur.status,
      };
      const r = await q.one<ResRow>(
        `UPDATE resources SET name=$3, category=$4, capacity=$5, note=$6, sort_order=$7, status=$8 WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.orgId, id, next.name, next.category, next.capacity, next.note, next.sort_order, next.status],
      );
      const diff = changes(cur as unknown as Record<string, unknown>, next);
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), {
          action: 'resource.updated',
          targetType: 'resource',
          targetId: id,
          locationId: cur.location_id,
          before: diff.before,
          after: diff.after,
          requestId: req.id,
        });
      }
      return dto(r);
    });
  });

  app.post('/api/v1/resources/:id/archive', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await load(q, ctx.orgId, id);
      assertLocation(ctx, cur.location_id, 'リソース');
      await q.exec(`UPDATE resources SET status = 'archived', archived_at = now() WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id]);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'resource.archived', targetType: 'resource', targetId: id, locationId: cur.location_id, requestId: req.id });
      return { ok: true };
    });
  });

  app.put('/api/v1/resources/:id/hours', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ hours: z.array(z.object({ weekday: z.number().int().min(1).max(7), openTime: zTime, closeTime: zTime })).max(50) }), req.body);
    validateRanges(body.hours);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await load(q, ctx.orgId, id);
      assertLocation(ctx, cur.location_id, 'リソース');
      await q.exec('DELETE FROM resource_hours WHERE organization_id = $1 AND resource_id = $2', [ctx.orgId, id]);
      for (const h of body.hours) {
        await q.exec('INSERT INTO resource_hours (organization_id, resource_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)', [
          ctx.orgId,
          id,
          h.weekday,
          h.openTime,
          h.closeTime,
        ]);
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'resource.hours_updated',
        targetType: 'resource',
        targetId: id,
        locationId: cur.location_id,
        after: { hours: body.hours },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  app.post('/api/v1/resources/:id/blocks', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ startsAt: zIso, endsAt: zIso, kind: z.enum(['maintenance', 'stopped', 'other']).default('maintenance'), note: zOptText(200) }), req.body);
    if (new Date(body.endsAt) <= new Date(body.startsAt)) throw new AppError('VALIDATION_ERROR', '終了は開始より後にしてください');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await load(q, ctx.orgId, id);
      assertLocation(ctx, cur.location_id, 'リソース');
      const row = await q.one<{ id: string }>(
        `INSERT INTO resource_blocks (organization_id, resource_id, starts_at, ends_at, kind, note, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.orgId, id, body.startsAt, body.endsAt, body.kind, body.note, ctx.membershipId],
      );
      const affected = await q.one<{ n: number }>(
        `SELECT count(DISTINCT b.id) AS n FROM occupancy_resources r
           JOIN occupancies o ON o.id = r.occupancy_id AND o.status = 'active'
           JOIN bookings b ON b.occupancy_id = o.id AND b.status IN ('confirmed','arrived','in_service')
          WHERE r.organization_id = $1 AND r.resource_id = $2 AND r.active AND r.block_starts_at < $4 AND r.block_ends_at > $3`,
        [ctx.orgId, id, body.startsAt, body.endsAt],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'resource.block_added',
        targetType: 'resource',
        targetId: id,
        locationId: cur.location_id,
        after: { startsAt: body.startsAt, endsAt: body.endsAt, kind: body.kind },
        metadata: { affectedBookings: affected.n },
        requestId: req.id,
      });
      return { id: row.id, warning: affected.n > 0 ? `この期間にこのリソースを使う予約が${affected.n}件あります(自動では変更されません)。` : null };
    });
  });

  app.delete('/api/v1/resources/:id/blocks/:blockId', async (req) => {
    const ctx = requireAuth(req, 'resource.manage');
    const { id, blockId } = parse(z.object({ id: zUuid, blockId: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await load(q, ctx.orgId, id);
      assertLocation(ctx, cur.location_id, 'リソース');
      const n = await q.exec('DELETE FROM resource_blocks WHERE organization_id = $1 AND resource_id = $2 AND id = $3', [ctx.orgId, id, blockId]);
      if (n === 0) throw notFound('停止期間');
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'resource.block_removed', targetType: 'resource', targetId: id, locationId: cur.location_id, requestId: req.id });
      return { ok: true };
    });
  });
}
