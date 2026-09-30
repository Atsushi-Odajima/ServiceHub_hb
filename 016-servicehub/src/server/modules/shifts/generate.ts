import { addDays, isoWeekday, localDayRange, localToUtc, localToUtcLenient } from '../../../shared/time.js';
import type { Q } from '../../db/tx.js';

/**
 * 週テンプレートからシフトを生成する(ルートとサンプル投入で共用)。
 * - その日に既にシフトがあるスタッフの日はスキップ(個別編集を上書きしない)
 * - skipClosedDays: 拠点の臨時休業日・定休日はスキップ
 * - scope: 拠点限定ロールの場合の対象拠点
 */
export async function generateShiftsFromTemplates(
  q: Q,
  orgId: string,
  staffIds: string[],
  from: string,
  days: number,
  opts: { skipClosedDays: boolean; scope: string[] | null; createdBy: string | null },
): Promise<{ created: number; skippedExisting: number; skippedClosed: number }> {
  let created = 0;
  let skippedExisting = 0;
  let skippedClosed = 0;
  for (const staffId of staffIds) {
    const st = await q.maybeOne<{ status: string }>('SELECT status FROM staff WHERE organization_id = $1 AND id = $2', [orgId, staffId]);
    if (!st || st.status !== 'active') continue;
    const templates = await q.many<{ location_id: string; weekday: number; shift_type: 'work' | 'break'; start_time: string; end_time: string; timezone: string }>(
      `SELECT t.location_id, t.weekday, t.shift_type, t.start_time, t.end_time, l.timezone
         FROM shift_templates t JOIN locations l ON l.id = t.location_id AND l.status = 'active'
        WHERE t.organization_id = $1 AND t.staff_id = $2`,
      [orgId, staffId],
    );
    for (let i = 0; i <= days; i++) {
      const date = addDays(from, i);
      const wd = isoWeekday(date);
      const todays = templates.filter((t) => t.weekday === wd && (!opts.scope || opts.scope.includes(t.location_id)));
      if (todays.length === 0) continue;
      const range = localDayRange(date, todays[0].timezone);
      const existing = await q.maybeOne(
        `SELECT 1 FROM staff_shifts WHERE organization_id = $1 AND staff_id = $2 AND starts_at >= $3 AND starts_at < $4 LIMIT 1`,
        [orgId, staffId, range.start, range.end],
      );
      if (existing) {
        skippedExisting++;
        continue;
      }
      let closedLocs = new Set<string>();
      if (opts.skipClosedDays) {
        const locIds = [...new Set(todays.map((t) => t.location_id))];
        const closed = await q.many<{ location_id: string }>(
          `SELECT l.id AS location_id FROM locations l
            WHERE l.organization_id = $1 AND l.id = ANY($2::uuid[])
              AND (EXISTS (SELECT 1 FROM location_exceptions e WHERE e.location_id = l.id AND e.date = $3 AND e.kind = 'closed')
                   OR (NOT EXISTS (SELECT 1 FROM location_exceptions e2 WHERE e2.location_id = l.id AND e2.date = $3)
                       AND NOT EXISTS (SELECT 1 FROM location_hours h WHERE h.location_id = l.id AND h.weekday = $4)))`,
          [orgId, locIds, date, wd],
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
          [orgId, staffId, t.location_id, t.shift_type, s, e, opts.createdBy],
        );
        created++;
      }
    }
  }
  return { created, skippedExisting, skippedClosed };
}
