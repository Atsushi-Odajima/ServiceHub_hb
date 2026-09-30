import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUESTION_TYPES } from '../../../shared/constants.js';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { locationScope, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zOptText, zTime, zUuid } from '../../http/validate.js';

const zInterval = z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]);

const RequirementSchema = z.object({
  label: z.string().trim().min(1).max(60),
  quantity: z.number().int().min(1).max(50).default(1),
  resourceIds: z.array(zUuid).min(1, '候補リソースを1つ以上選んでください').max(100),
});

const QuestionSchema = z
  .object({
    id: zUuid.optional(),
    type: z.enum(QUESTION_TYPES),
    label: z.string().trim().min(1).max(200),
    helpText: zOptText(500),
    options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(100) })).max(30).default([]),
    required: z.boolean().default(false),
  })
  .refine((q) => !['single_choice', 'multi_choice'].includes(q.type) || q.options.length >= 2, {
    message: '選択式の質問には選択肢を2つ以上設定してください',
    path: ['options'],
  });

const ServiceBase = z.object({
  name: z.string().trim().min(1).max(100),
  description: zOptText(2000),
  category: zOptText(60),
  durationMin: z.number().int().min(5).max(1440),
  bufferBeforeMin: z.number().int().min(0).max(240).default(0),
  bufferAfterMin: z.number().int().min(0).max(240).default(0),
  priceLabel: zOptText(60),
  capacity: z.number().int().min(1).max(500).default(1),
  maxPartySize: z.number().int().min(1).max(500).default(1),
  requiresStaff: z.boolean().default(true),
  isBookable: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  passEligible: z.boolean().default(true),
  planEligible: z.boolean().default(true),
  notice: zOptText(2000),
  scheduleMode: z.enum(['flexible', 'fixed']).default('flexible'),
  slotIntervalMin: zInterval.nullable().default(null),
  minNoticeMin: z.number().int().min(0).max(43200).nullable().default(null),
  maxAdvanceDays: z.number().int().min(1).max(366).nullable().default(null),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  locationIds: z.array(zUuid).max(100).default([]),
  staffIds: z.array(zUuid).max(500).default([]),
  requirements: z.array(RequirementSchema).max(10).default([]),
  fixedTimes: z.array(z.object({ locationId: zUuid, weekday: z.number().int().min(1).max(7), time: zTime })).max(500).default([]),
});

interface SvcRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  price_label: string | null;
  capacity: number;
  max_party_size: number;
  requires_staff: boolean;
  is_bookable: boolean;
  is_public: boolean;
  pass_eligible: boolean;
  plan_eligible: boolean;
  notice: string | null;
  schedule_mode: 'flexible' | 'fixed';
  slot_interval_min: number | null;
  min_notice_min: number | null;
  max_advance_days: number | null;
  color: string | null;
  sort_order: number;
  status: string;
  location_ids: string[];
  staff_ids: string[];
}

const SELECT_SERVICE = `
  SELECT s.*,
         coalesce((SELECT array_agg(sl.location_id) FROM service_locations sl WHERE sl.service_id = s.id), '{}') AS location_ids,
         coalesce((SELECT array_agg(ss.staff_id) FROM service_staff ss WHERE ss.service_id = s.id), '{}') AS staff_ids
    FROM services s`;

export function serviceDto(r: SvcRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    durationMin: r.duration_min,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    priceLabel: r.price_label,
    capacity: r.capacity,
    maxPartySize: r.max_party_size,
    requiresStaff: r.requires_staff,
    isBookable: r.is_bookable,
    isPublic: r.is_public,
    passEligible: r.pass_eligible,
    planEligible: r.plan_eligible,
    notice: r.notice,
    scheduleMode: r.schedule_mode,
    slotIntervalMin: r.slot_interval_min,
    minNoticeMin: r.min_notice_min,
    maxAdvanceDays: r.max_advance_days,
    color: r.color,
    sortOrder: r.sort_order,
    status: r.status,
    locationIds: r.location_ids,
    staffIds: r.staff_ids,
  };
}

async function assertIn(q: Q, orgId: string, table: 'locations' | 'staff' | 'resources', ids: string[], label: string) {
  if (ids.length === 0) return;
  const r = await q.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, [...new Set(ids)]]);
  if (r.n !== new Set(ids).size) throw new AppError('VALIDATION_ERROR', `存在しない${label}が含まれています`);
}

async function writeRelations(q: Q, orgId: string, serviceId: string, b: z.infer<typeof ServiceBase>) {
  await q.exec('DELETE FROM service_locations WHERE organization_id = $1 AND service_id = $2', [orgId, serviceId]);
  for (const l of new Set(b.locationIds)) {
    await q.exec('INSERT INTO service_locations (organization_id, service_id, location_id) VALUES ($1,$2,$3)', [orgId, serviceId, l]);
  }
  await q.exec('DELETE FROM service_staff WHERE organization_id = $1 AND service_id = $2', [orgId, serviceId]);
  for (const s of new Set(b.staffIds)) {
    await q.exec('INSERT INTO service_staff (organization_id, service_id, staff_id) VALUES ($1,$2,$3)', [orgId, serviceId, s]);
  }
  await q.exec('DELETE FROM service_resource_requirements WHERE organization_id = $1 AND service_id = $2', [orgId, serviceId]);
  for (const [i, r] of b.requirements.entries()) {
    const row = await q.one<{ id: string }>(
      'INSERT INTO service_resource_requirements (organization_id, service_id, label, quantity, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [orgId, serviceId, r.label, r.quantity, i],
    );
    for (const res of new Set(r.resourceIds)) {
      await q.exec('INSERT INTO service_resource_options (organization_id, requirement_id, resource_id) VALUES ($1,$2,$3)', [orgId, row.id, res]);
    }
  }
  await q.exec('DELETE FROM service_fixed_times WHERE organization_id = $1 AND service_id = $2', [orgId, serviceId]);
  const seen = new Set<string>();
  for (const f of b.fixedTimes) {
    const key = `${f.locationId}|${f.weekday}|${f.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await q.exec(
      'INSERT INTO service_fixed_times (organization_id, service_id, location_id, weekday, start_time) VALUES ($1,$2,$3,$4,$5)',
      [orgId, serviceId, f.locationId, f.weekday, f.time],
    );
  }
}

async function loadDetail(q: Q, orgId: string, id: string) {
  const r = await q.maybeOne<SvcRow>(`${SELECT_SERVICE} WHERE s.organization_id = $1 AND s.id = $2`, [orgId, id]);
  if (!r) throw notFound('サービス');
  const reqs = await q.many<{ id: string; label: string; quantity: number; resource_ids: string[] }>(
    `SELECT r.id, r.label, r.quantity,
            coalesce((SELECT array_agg(o.resource_id) FROM service_resource_options o WHERE o.requirement_id = r.id), '{}') AS resource_ids
       FROM service_resource_requirements r WHERE r.organization_id = $1 AND r.service_id = $2 ORDER BY r.sort_order`,
    [orgId, id],
  );
  const fixed = await q.many<{ location_id: string; weekday: number; start_time: string }>(
    'SELECT location_id, weekday, start_time FROM service_fixed_times WHERE organization_id = $1 AND service_id = $2 ORDER BY weekday, start_time',
    [orgId, id],
  );
  const questions = await q.many<{ id: string; type: string; label: string; help_text: string | null; options: unknown; required: boolean; sort_order: number }>(
    `SELECT id, type, label, help_text, options, required, sort_order FROM service_questions
      WHERE organization_id = $1 AND service_id = $2 AND status = 'active' ORDER BY sort_order, created_at`,
    [orgId, id],
  );
  return {
    ...serviceDto(r),
    requirements: reqs.map((x) => ({ id: x.id, label: x.label, quantity: x.quantity, resourceIds: x.resource_ids })),
    fixedTimes: fixed.map((f) => ({ locationId: f.location_id, weekday: f.weekday, time: f.start_time.slice(0, 5) })),
    questions: questions.map((x) => ({ id: x.id, type: x.type, label: x.label, helpText: x.help_text, options: x.options, required: x.required })),
  };
}

export async function registerServiceRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/services', async (req) => {
    const ctx = requireAuth(req);
    const qy = parse(z.object({ includeArchived: z.enum(['true', 'false']).optional(), locationId: zUuid.optional() }), req.query);
    const scope = locationScope(ctx);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<SvcRow>(
        `${SELECT_SERVICE}
          WHERE s.organization_id = $1 AND ($2::boolean OR s.status = 'active')
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM service_locations x WHERE x.service_id = s.id AND x.location_id = $3))
          ORDER BY s.status, s.sort_order, s.name`,
        [ctx.orgId, qy.includeArchived === 'true', qy.locationId ?? null],
      );
      // 拠点限定ロールには担当拠点で提供されるサービスのみ(拠点未設定のものは表示)
      const items = rows
        .filter((r) => !scope || r.location_ids.length === 0 || r.location_ids.some((l) => scope.includes(l)))
        .map(serviceDto);
      return { items };
    });
  });

  app.get('/api/v1/services/:id', async (req) => {
    const ctx = requireAuth(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, (q) => loadDetail(q, ctx.orgId, id));
  });

  app.post('/api/v1/services', async (req) => {
    const ctx = requireAuth(req, 'service.manage');
    const body = parse(ServiceBase, req.body);
    if (body.maxPartySize > body.capacity) throw new AppError('VALIDATION_ERROR', '1予約の最大人数は定員以下にしてください', { fields: { maxPartySize: '定員以下にしてください' } });
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertIn(q, ctx.orgId, 'locations', body.locationIds, '拠点');
      await assertIn(q, ctx.orgId, 'staff', body.staffIds, 'スタッフ');
      await assertIn(q, ctx.orgId, 'resources', body.requirements.flatMap((r) => r.resourceIds), 'リソース');
      await assertIn(q, ctx.orgId, 'locations', body.fixedTimes.map((f) => f.locationId), '拠点');
      const s = await q.one<{ id: string }>(
        `INSERT INTO services (organization_id, name, description, category, duration_min, buffer_before_min, buffer_after_min, price_label,
                               capacity, max_party_size, requires_staff, is_bookable, is_public, pass_eligible, plan_eligible, notice,
                               schedule_mode, slot_interval_min, min_notice_min, max_advance_days, color, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [
          ctx.orgId,
          body.name,
          body.description,
          body.category,
          body.durationMin,
          body.bufferBeforeMin,
          body.bufferAfterMin,
          body.priceLabel,
          body.capacity,
          body.maxPartySize,
          body.requiresStaff,
          body.isBookable,
          body.isPublic,
          body.passEligible,
          body.planEligible,
          body.notice,
          body.scheduleMode,
          body.slotIntervalMin,
          body.minNoticeMin,
          body.maxAdvanceDays,
          body.color ?? null,
          body.sortOrder,
        ],
      );
      await writeRelations(q, ctx.orgId, s.id, body);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'service.created',
        targetType: 'service',
        targetId: s.id,
        after: { name: body.name, durationMin: body.durationMin, capacity: body.capacity },
        requestId: req.id,
      });
      return loadDetail(q, ctx.orgId, s.id);
    });
  });

  app.patch('/api/v1/services/:id', async (req) => {
    const ctx = requireAuth(req, 'service.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(ServiceBase.partial(), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await loadDetail(q, ctx.orgId, id);
      const merged = ServiceBase.parse({
        ...cur,
        ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
      });
      if (merged.maxPartySize > merged.capacity) throw new AppError('VALIDATION_ERROR', '1予約の最大人数は定員以下にしてください');
      await assertIn(q, ctx.orgId, 'locations', merged.locationIds, '拠点');
      await assertIn(q, ctx.orgId, 'staff', merged.staffIds, 'スタッフ');
      await assertIn(q, ctx.orgId, 'resources', merged.requirements.flatMap((r) => r.resourceIds), 'リソース');
      await q.exec(
        `UPDATE services SET name=$3, description=$4, category=$5, duration_min=$6, buffer_before_min=$7, buffer_after_min=$8, price_label=$9,
                capacity=$10, max_party_size=$11, requires_staff=$12, is_bookable=$13, is_public=$14, pass_eligible=$15, plan_eligible=$16,
                notice=$17, schedule_mode=$18, slot_interval_min=$19, min_notice_min=$20, max_advance_days=$21, color=$22, sort_order=$23
          WHERE organization_id = $1 AND id = $2`,
        [
          ctx.orgId,
          id,
          merged.name,
          merged.description,
          merged.category,
          merged.durationMin,
          merged.bufferBeforeMin,
          merged.bufferAfterMin,
          merged.priceLabel,
          merged.capacity,
          merged.maxPartySize,
          merged.requiresStaff,
          merged.isBookable,
          merged.isPublic,
          merged.passEligible,
          merged.planEligible,
          merged.notice,
          merged.scheduleMode,
          merged.slotIntervalMin,
          merged.minNoticeMin,
          merged.maxAdvanceDays,
          merged.color ?? null,
          merged.sortOrder,
        ],
      );
      await writeRelations(q, ctx.orgId, id, merged);
      const { questions: _q, ...curComparable } = cur;
      const diff = changes(curComparable as unknown as Record<string, unknown>, merged as unknown as Record<string, unknown>);
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), {
          action: 'service.updated',
          targetType: 'service',
          targetId: id,
          before: diff.before,
          after: diff.after,
          requestId: req.id,
        });
      }
      // 過去の予約/実施はスナップショットを持つため、ここでの変更は履歴に影響しない
      return loadDetail(q, ctx.orgId, id);
    });
  });

  app.post('/api/v1/services/:id/archive', async (req) => {
    const ctx = requireAuth(req, 'service.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.exec(
        `UPDATE services SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE NULL END WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.archived ? 'archived' : 'active'],
      );
      if (n === 0) throw notFound('サービス');
      const future = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM bookings WHERE organization_id = $1 AND service_id = $2 AND status IN ('confirmed','arrived') AND starts_at > $3`,
        [ctx.orgId, id, deps.clock.now()],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: body.archived ? 'service.archived' : 'service.restored',
        targetType: 'service',
        targetId: id,
        metadata: { futureBookings: future.n },
        requestId: req.id,
      });
      return { ok: true, warning: body.archived && future.n > 0 ? `今後の予約が${future.n}件あります(既存予約はそのまま残ります)。` : null };
    });
  });

  // 事前質問(医療問診用途にはしない)。既存の予約の回答は質問スナップショットを持つため、変更しても過去は変わらない
  app.put('/api/v1/services/:id/questions', async (req) => {
    const ctx = requireAuth(req, 'service.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ questions: z.array(QuestionSchema).max(30) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await loadDetail(q, ctx.orgId, id);
      const keepIds = body.questions.map((x) => x.id).filter((x): x is string => Boolean(x));
      await q.exec(
        `UPDATE service_questions SET status = 'archived' WHERE organization_id = $1 AND service_id = $2 AND status = 'active'
            AND NOT (id = ANY($3::uuid[]))`,
        [ctx.orgId, id, keepIds],
      );
      for (const [i, x] of body.questions.entries()) {
        const n = x.id
          ? await q.exec(
              `UPDATE service_questions SET type=$4, label=$5, help_text=$6, options=$7, required=$8, sort_order=$9, status='active'
                WHERE organization_id = $1 AND service_id = $2 AND id = $3`,
              [ctx.orgId, id, x.id, x.type, x.label, x.helpText, JSON.stringify(x.options), x.required, i],
            )
          : 0;
        if (n === 0) {
          await q.exec(
            `INSERT INTO service_questions (organization_id, service_id, type, label, help_text, options, required, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ctx.orgId, id, x.type, x.label, x.helpText, JSON.stringify(x.options), x.required, i],
          );
        }
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'service.questions_updated',
        targetType: 'service',
        targetId: id,
        metadata: { count: body.questions.length },
        requestId: req.id,
      });
      return loadDetail(q, ctx.orgId, id);
    });
  });
}
