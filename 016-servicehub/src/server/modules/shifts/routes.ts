import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SHIFT_TYPES, type ShiftType } from '../../../shared/constants.js';
import { addDays, daysBetween, isoWeekday, localDayRange, localToUtc, localToUtcLenient } from '../../../shared/time.js';
import { actorOf, writeAudit } from '../../audit.js';
import { type AuthContext, can, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zIso, zOptText, zTime, zUuid } from '../../http/validate.js';

interface ShiftRow {
  id: string;
  staff_id: string;
  location_id: string | null;
  shift_type: ShiftType;
  starts_at: Date;
  ends_at: Date;
  source: string;
  note: string | null;
}

const dto = (r: ShiftRow) => ({
  id: r.id,
  staffId: r.staff_id,
  locationId: r.location_id,
  type: r.shift_type,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  source: r.source,
  note: r.note,
});

const ShiftInput = z.object({
  staffId: zUuid,
  locationId: zUuid.nullable().optional(),
  type: z.enum(SHIFT_TYPES),
  startsAt: zIso,
  endsAt: zIso,
  note: zOptText(200),
  acknowledgeConflicts: z.boolean().optional().default(false),
});

interface Conflict {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
  locationId: string;
  reason: string;
}

/** スタッフの拠点所属を確認(勤務シフトの拠点は所属拠点のみ) */
async function staffLocations(q: Q, orgId: string, staffId: string): Promise<{ status: string; locationIds: string[] }> {
  const s = await q.maybeOne<{ status: string; location_ids: string[] }>(
    `SELECT s.status, coalesce((SELECT array_agg(location_id) FROM staff_locations WHERE staff_id = s.id), '{}') AS location_ids
       FROM staff s WHERE s.organization_id = $1 AND s.id = $2`,
    [orgId, staffId],
  );
  if (!s) throw notFound('スタッフ');
  return { status: s.status, locationIds: s.location_ids };
}

/** 管理者のシフト編集権限(担当拠点に所属するスタッフのみ) */
function assertCanManageStaff(ctx: AuthContext, staffLocs: string[], shiftLocation: string | null | undefined) {
  if (!can(ctx, 'shift.manage')) throw forbidden();
  const scope = locationScope(ctx);
  if (!scope) return;
  if (shiftLocation && !scope.includes(shiftLocation)) throw notFound('拠点');
  if (!staffLocs.some((l) => scope.includes(l))) throw notFound('スタッフ');
}

/**
 * シフト変更後の予約との競合を調べる。
 * - 勤務(work)が縮む/消える: 勤務外になる予約
 * - 休憩/休暇/予約不可 等: 重なる予約
 */
async function findConflicts(q: Q, orgId: string, staffId: string, from: Date, to: Date, excludeShiftId: string | null, pending: { type: ShiftType; locationId: string | null; start: Date; end: Date } | null): Promise<Conflict[]> {
  const bookings = await q.many<{ id: string; starts_at: Date; ends_at: Date; location_id: string; block_starts_at: Date; block_ends_at: Date }>(
    `SELECT b.id, b.starts_at, b.ends_at, b.location_id, o.block_starts_at, o.block_ends_at
       FROM bookings b JOIN occupancies o ON o.id = b.occupancy_id
      WHERE b.organization_id = $1 AND b.staff_id = $2 AND b.status IN ('confirmed','arrived','in_service')
        AND o.block_starts_at < $4 AND o.block_ends_at > $3`,
    [orgId, staffId, from, to],
  );
  if (bookings.length === 0) return [];
  const shifts = await q.many<ShiftRow>(
    `SELECT * FROM staff_shifts WHERE organization_id = $1 AND staff_id = $2
        AND starts_at >= $3::timestamptz - interval '2 days' AND starts_at < $4::timestamptz + interval '1 day' AND ends_at > $3::timestamptz - interval '1 day'
        AND ($5::uuid IS NULL OR id <> $5::uuid)`,
    [orgId, staffId, from, to, excludeShiftId],
  );
  const all = shifts.map((s) => ({ type: s.shift_type, locationId: s.location_id, start: s.starts_at, end: s.ends_at }));
  if (pending) all.push(pending);
  const conflicts: Conflict[] = [];
  for (const b of bookings) {
    const B = { start: b.block_starts_at, end: b.block_ends_at };
    const work = all
      .filter((s) => s.type === 'work' && s.locationId === b.location_id)
      .sort((x, y) => x.start.getTime() - y.start.getTime());
    // 連続する勤務を結合して包含判定
    let covered = false;
    let curStart: Date | null = null;
    let curEnd: Date | null = null;
    for (const w of work) {
      if (curEnd && w.start <= curEnd) {
        if (w.end > curEnd) curEnd = w.end;
      } else {
        if (curStart && curEnd && curStart <= B.start && curEnd >= B.end) covered = true;
        curStart = w.start;
        curEnd = w.end;
      }
    }
    if (curStart && curEnd && curStart <= B.start && curEnd >= B.end) covered = true;
    const blocked = all.some((s) => s.type !== 'work' && s.start < B.end && s.end > B.start);
    if (!covered || blocked) {
      conflicts.push({
        bookingId: b.id,
        startsAt: b.starts_at,
        endsAt: b.ends_at,
        locationId: b.location_id,
        reason: blocked ? '休憩・休暇・予約不可の時間と重なります' : '勤務時間外になります',
      });
    }
  }
  return conflicts;
}

function conflictError(conflicts: Conflict[]): AppError {
  return new AppError(
    'CONFLICT',
    `このシフト変更は既存の予約${conflicts.length}件と競合します。予約は自動で削除・移動されません。内容を確認のうえ、よければ「競合を承知で保存」してください。`,
    { conflicts, requiresAcknowledgement: true },
  );
}

export async function registerShiftRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/shifts', async (req) => {
    const ctx = requireAuth(req, 'shift.read.all', 'shift.read.own', 'shift.manage');
    const qy = parse(z.object({ from: zIso, to: zIso, locationId: zUuid.optional(), staffId: zUuid.optional() }), req.query);
    const ownOnly = !can(ctx, 'shift.read.all') && !can(ctx, 'shift.manage');
    if (ownOnly && (!ctx.staffId || (qy.staffId && qy.staffId !== ctx.staffId))) throw forbidden();
    const scope = locationScope(ctx);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<ShiftRow>(
        `SELECT sh.* FROM staff_shifts sh
          WHERE sh.organization_id = $1 AND sh.starts_at >= $2::timestamptz - interval '2 days' AND sh.starts_at < $3 AND sh.ends_at > $2
            AND ($4::uuid IS NULL OR sh.location_id = $4 OR (sh.location_id IS NULL AND EXISTS (SELECT 1 FROM staff_locations x WHERE x.staff_id = sh.staff_id AND x.location_id = $4)))
            AND ($5::uuid IS NULL OR sh.staff_id = $5)
            AND ($6::uuid[] IS NULL OR sh.location_id = ANY($6::uuid[])
                 OR (sh.location_id IS NULL AND EXISTS (SELECT 1 FROM staff_locations y WHERE y.staff_id = sh.staff_id AND y.location_id = ANY($6::uuid[]))))
          ORDER BY sh.starts_at`,
        [ctx.orgId, qy.from, qy.to, qy.locationId ?? null, ownOnly ? ctx.staffId : (qy.staffId ?? null), ownOnly ? null : scope],
      );
      return { items: rows.map(dto) };
    });
  });

  app.post('/api/v1/shifts', async (req) => {
    const ctx = requireAuth(req, 'shift.manage');
    const body = parse(ShiftInput, req.body);
    const start = new Date(body.startsAt);
    const end = new Date(body.endsAt);
    if (end <= start) throw new AppError('VALIDATION_ERROR', '終了は開始より後にしてください');
    if (end.getTime() - start.getTime() > 24 * 3600_000) throw new AppError('VALIDATION_ERROR', '1件のシフトは24時間以内にしてください');
    if (body.type === 'work' && !body.locationId) throw new AppError('VALIDATION_ERROR', '勤務シフトには拠点が必要です');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const st = await staffLocations(q, ctx.orgId, body.staffId);
      assertCanManageStaff(ctx, st.locationIds, body.locationId);
      if (st.status !== 'active') throw new AppError('INVALID_STATE', 'アーカイブ済みのスタッフにはシフトを追加できません');
      if (body.type === 'work' && !st.locationIds.includes(body.locationId!)) {
        throw new AppError('VALIDATION_ERROR', 'このスタッフはその拠点に所属していません');
      }
      const pending = { type: body.type, locationId: body.locationId ?? null, start, end };
      const conflicts = body.type === 'work' ? [] : await findConflicts(q, ctx.orgId, body.staffId, start, end, null, pending);
      if (conflicts.length > 0 && !body.acknowledgeConflicts) throw conflictError(conflicts);
      const r = await q.one<ShiftRow>(
        `INSERT INTO staff_shifts (organization_id, staff_id, location_id, shift_type, starts_at, ends_at, source, note, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8) RETURNING *`,
        [ctx.orgId, body.staffId, body.locationId ?? null, body.type, start, end, body.note, ctx.membershipId],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'shift.created',
        targetType: 'shift',
        targetId: r.id,
        locationId: r.location_id,
        after: { staffId: r.staff_id, type: r.shift_type, startsAt: r.starts_at, endsAt: r.ends_at },
        metadata: conflicts.length ? { acknowledgedConflicts: conflicts.length } : undefined,
        requestId: req.id,
      });
      return { ...dto(r), conflicts };
    });
  });

  app.patch('/api/v1/shifts/:id', async (req) => {
    const ctx = requireAuth(req, 'shift.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(ShiftInput.omit({ staffId: true }).partial().extend({ acknowledgeConflicts: z.boolean().optional().default(false) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<ShiftRow>('SELECT * FROM staff_shifts WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.orgId, id]);
      if (!cur) throw notFound('シフト');
      const st = await staffLocations(q, ctx.orgId, cur.staff_id);
      assertCanManageStaff(ctx, st.locationIds, cur.location_id);
      const next = {
        type: body.type ?? cur.shift_type,
        locationId: body.locationId !== undefined ? body.locationId : cur.location_id,
        start: body.startsAt ? new Date(body.startsAt) : cur.starts_at,
        end: body.endsAt ? new Date(body.endsAt) : cur.ends_at,
        note: body.note !== undefined ? body.note : cur.note,
      };
      if (next.end <= next.start) throw new AppError('VALIDATION_ERROR', '終了は開始より後にしてください');
      if (next.type === 'work' && !next.locationId) throw new AppError('VALIDATION_ERROR', '勤務シフトには拠点が必要です');
      if (next.locationId) assertCanManageStaff(ctx, st.locationIds, next.locationId);
      const from = new Date(Math.min(cur.starts_at.getTime(), next.start.getTime()));
      const to = new Date(Math.max(cur.ends_at.getTime(), next.end.getTime()));
      const conflicts = await findConflicts(q, ctx.orgId, cur.staff_id, from, to, id, { type: next.type, locationId: next.locationId ?? null, start: next.start, end: next.end });
      if (conflicts.length > 0 && !body.acknowledgeConflicts) throw conflictError(conflicts);
      const r = await q.one<ShiftRow>(
        `UPDATE staff_shifts SET shift_type=$3, location_id=$4, starts_at=$5, ends_at=$6, note=$7, source='manual'
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.orgId, id, next.type, next.locationId ?? null, next.start, next.end, next.note],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'shift.updated',
        targetType: 'shift',
        targetId: id,
        locationId: r.location_id,
        before: { type: cur.shift_type, locationId: cur.location_id, startsAt: cur.starts_at, endsAt: cur.ends_at },
        after: { type: r.shift_type, locationId: r.location_id, startsAt: r.starts_at, endsAt: r.ends_at },
        metadata: conflicts.length ? { acknowledgedConflicts: conflicts.length } : undefined,
        requestId: req.id,
      });
      return { ...dto(r), conflicts };
    });
  });

  app.delete('/api/v1/shifts/:id', async (req) => {
    const ctx = requireAuth(req, 'shift.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { acknowledgeConflicts } = parse(z.object({ acknowledgeConflicts: z.enum(['true', 'false']).optional() }), req.query);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<ShiftRow>('SELECT * FROM staff_shifts WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.orgId, id]);
      if (!cur) throw notFound('シフト');
      const st = await staffLocations(q, ctx.orgId, cur.staff_id);
      assertCanManageStaff(ctx, st.locationIds, cur.location_id);
      const conflicts = cur.shift_type === 'work' ? await findConflicts(q, ctx.orgId, cur.staff_id, cur.starts_at, cur.ends_at, id, null) : [];
      if (conflicts.length > 0 && acknowledgeConflicts !== 'true') throw conflictError(conflicts);
      await q.exec('DELETE FROM staff_shifts WHERE organization_id = $1 AND id = $2', [ctx.orgId, id]);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'shift.deleted',
        targetType: 'shift',
        targetId: id,
        locationId: cur.location_id,
        before: { staffId: cur.staff_id, type: cur.shift_type, startsAt: cur.starts_at, endsAt: cur.ends_at },
        metadata: conflicts.length ? { acknowledgedConflicts: conflicts.length } : undefined,
        requestId: req.id,
      });
      return { ok: true, conflicts };
    });
  });

  // ---- 週テンプレート ----
  app.get('/api/v1/shift-templates', async (req) => {
    const ctx = requireAuth(req, 'shift.manage', 'shift.read.all', 'shift.read.own');
    const { staffId } = parse(z.object({ staffId: zUuid }), req.query);
    if (!can(ctx, 'shift.manage') && !can(ctx, 'shift.read.all') && staffId !== ctx.staffId) throw forbidden();
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{ id: string; location_id: string; weekday: number; shift_type: string; start_time: string; end_time: string; valid_from: string | null; valid_to: string | null }>(
        `SELECT id, location_id, weekday, shift_type, start_time, end_time, valid_from, valid_to FROM shift_templates
          WHERE organization_id = $1 AND staff_id = $2 ORDER BY weekday, start_time`,
        [ctx.orgId, staffId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          locationId: r.location_id,
          weekday: r.weekday,
          type: r.shift_type,
          startTime: r.start_time.slice(0, 5),
          endTime: r.end_time.slice(0, 5),
          validFrom: r.valid_from,
          validTo: r.valid_to,
        })),
      };
    });
  });

  app.put('/api/v1/shift-templates/:staffId', async (req) => {
    const ctx = requireAuth(req, 'shift.manage');
    const { staffId } = parse(z.object({ staffId: zUuid }), req.params);
    const body = parse(
      z.object({
        items: z
          .array(
            z.object({
              locationId: zUuid,
              weekday: z.number().int().min(1).max(7),
              type: z.enum(['work', 'break']),
              startTime: zTime,
              endTime: zTime,
            }),
          )
          .max(100),
      }),
      req.body,
    );
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const st = await staffLocations(q, ctx.orgId, staffId);
      assertCanManageStaff(ctx, st.locationIds, null);
      for (const it of body.items) {
        if (!st.locationIds.includes(it.locationId)) throw new AppError('VALIDATION_ERROR', 'スタッフが所属していない拠点が含まれています');
        if (it.endTime <= it.startTime) throw new AppError('VALIDATION_ERROR', '終了は開始より後にしてください');
      }
      // 同じ曜日で勤務同士が重なるテンプレートは不可(拠点をまたいでも)
      for (let wd = 1; wd <= 7; wd++) {
        const w = body.items.filter((i) => i.weekday === wd && i.type === 'work').sort((a, b) => a.startTime.localeCompare(b.startTime));
        for (let i = 1; i < w.length; i++) {
          if (w[i].startTime < w[i - 1].endTime) throw new AppError('VALIDATION_ERROR', '同じ曜日の勤務時間が重なっています(別拠点を含む)');
        }
      }
      await q.exec('DELETE FROM shift_templates WHERE organization_id = $1 AND staff_id = $2', [ctx.orgId, staffId]);
      for (const it of body.items) {
        await q.exec(
          `INSERT INTO shift_templates (organization_id, staff_id, location_id, weekday, shift_type, start_time, end_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.orgId, staffId, it.locationId, it.weekday, it.type, it.startTime, it.endTime],
        );
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'shift.template_updated',
        targetType: 'staff',
        targetId: staffId,
        after: { items: body.items.length },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  /**
   * テンプレートからシフトを生成。既にその日のシフトがあるスタッフの日はスキップ(個別編集を上書きしない)。
   * 拠点の臨時休業日/定休日は既定でスキップ。
   */
  app.post('/api/v1/shifts/generate', async (req) => {
    const ctx = requireAuth(req, 'shift.manage');
    const body = parse(
      z.object({ staffIds: z.array(zUuid).min(1).max(200), from: zDate, to: zDate, skipClosedDays: z.boolean().default(true) }),
      req.body,
    );
    const days = daysBetween(body.from, body.to);
    if (days < 0 || days > 92) throw new AppError('VALIDATION_ERROR', '期間は92日以内で指定してください');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      let created = 0;
      let skippedExisting = 0;
      let skippedClosed = 0;
      for (const staffId of body.staffIds) {
        const st = await staffLocations(q, ctx.orgId, staffId);
        assertCanManageStaff(ctx, st.locationIds, null);
        if (st.status !== 'active') continue;
        const templates = await q.many<{ location_id: string; weekday: number; shift_type: 'work' | 'break'; start_time: string; end_time: string; timezone: string }>(
          `SELECT t.location_id, t.weekday, t.shift_type, t.start_time, t.end_time, l.timezone
             FROM shift_templates t JOIN locations l ON l.id = t.location_id AND l.status = 'active'
            WHERE t.organization_id = $1 AND t.staff_id = $2`,
          [ctx.orgId, staffId],
        );
        const scope = locationScope(ctx);
        for (let i = 0; i <= days; i++) {
          const date = addDays(body.from, i);
          const wd = isoWeekday(date);
          const todays = templates.filter((t) => t.weekday === wd && (!scope || scope.includes(t.location_id)));
          if (todays.length === 0) continue;
          const tz = todays[0].timezone;
          const range = localDayRange(date, tz);
          const existing = await q.maybeOne(
            `SELECT 1 FROM staff_shifts WHERE organization_id = $1 AND staff_id = $2 AND starts_at >= $3 AND starts_at < $4 LIMIT 1`,
            [ctx.orgId, staffId, range.start, range.end],
          );
          if (existing) {
            skippedExisting++;
            continue;
          }
          let closedLocs = new Set<string>();
          if (body.skipClosedDays) {
            const locIds = [...new Set(todays.map((t) => t.location_id))];
            const closed = await q.many<{ location_id: string }>(
              `SELECT l.id AS location_id FROM locations l
                WHERE l.organization_id = $1 AND l.id = ANY($2::uuid[])
                  AND (EXISTS (SELECT 1 FROM location_exceptions e WHERE e.location_id = l.id AND e.date = $3 AND e.kind = 'closed')
                       OR (NOT EXISTS (SELECT 1 FROM location_exceptions e2 WHERE e2.location_id = l.id AND e2.date = $3)
                           AND NOT EXISTS (SELECT 1 FROM location_hours h WHERE h.location_id = l.id AND h.weekday = $4)))`,
              [ctx.orgId, locIds, date, wd],
            );
            closedLocs = new Set(closed.map((c) => c.location_id));
          }
          for (const t of todays) {
            if (closedLocs.has(t.location_id)) {
              skippedClosed++;
              continue;
            }
            const s = localToUtc(date, t.start_time, t.timezone) ?? localToUtcLenient(date, t.start_time, t.timezone);
            const e = localToUtcLenient(date, t.end_time, t.timezone);
            await q.exec(
              `INSERT INTO staff_shifts (organization_id, staff_id, location_id, shift_type, starts_at, ends_at, source, created_by_membership_id)
               VALUES ($1,$2,$3,$4,$5,$6,'template',$7)`,
              [ctx.orgId, staffId, t.location_id, t.shift_type, s, e, ctx.membershipId],
            );
            created++;
          }
        }
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'shift.generated',
        targetType: 'staff',
        metadata: { staffIds: body.staffIds, from: body.from, to: body.to, created, skippedExisting, skippedClosed },
        requestId: req.id,
      });
      return { created, skippedExisting, skippedClosed };
    });
  });
}
