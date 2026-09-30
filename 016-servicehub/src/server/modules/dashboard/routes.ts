import type { FastifyInstance } from 'fastify';
import { addDays, localDayRange, todayIn } from '../../../shared/time.js';
import { can, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { customerVisibility } from '../customers/visibility.js';

/**
 * ロール別ダッシュボードの集計(権限のある項目だけ返す)。
 * 経営KPI(売上的な指標・稼働率など)は Phase 8 の /api/v1/kpi。ここは当日の運営状況。
 */
export async function registerDashboardRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/dashboard', async (req) => {
    const ctx = requireAuth(req);
    const now = clock.now();
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const out: Record<string, unknown> = { role: ctx.role, generatedAt: now };
      const scope = locationScope(ctx);
      if (can(ctx, 'booking.read.all')) {
        const locs = await q.many<{ id: string; name: string; timezone: string }>(
          `SELECT id, name, timezone FROM locations WHERE organization_id = $1 AND status = 'active' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
            ORDER BY sort_order, name`,
          [ctx.orgId, scope],
        );
        const locations = [];
        for (const l of locs) {
          const date = todayIn(l.timezone, now);
          const day = localDayRange(date, l.timezone);
          const counts = await q.many<{ status: string; n: number }>(
            `SELECT status, count(*)::int AS n FROM bookings
              WHERE organization_id = $1 AND location_id = $2 AND starts_at >= $3 AND starts_at < $4 GROUP BY status`,
            [ctx.orgId, l.id, day.start, day.end],
          );
          const shift = await q.one<{ today: number; now: number }>(
            `SELECT count(DISTINCT staff_id)::int AS today,
                    count(DISTINCT staff_id) FILTER (WHERE starts_at <= $5 AND ends_at > $5)::int AS now
               FROM staff_shifts WHERE organization_id = $1 AND location_id = $2 AND shift_type = 'work' AND starts_at < $4 AND ends_at > $3`,
            [ctx.orgId, l.id, day.start, day.end, now],
          );
          const wl = can(ctx, 'waitlist.read')
            ? await q.one<{ active: number; open_matches: number }>(
                `SELECT (SELECT count(*)::int FROM waitlist_entries e WHERE e.organization_id = $1 AND e.location_id = $2 AND e.status IN ('waiting','notified')) AS active,
                        (SELECT count(*)::int FROM waitlist_matches m WHERE m.organization_id = $1 AND m.location_id = $2 AND m.status = 'open' AND m.starts_at > $3) AS open_matches`,
                [ctx.orgId, l.id, now],
              )
            : null;
          locations.push({
            id: l.id,
            name: l.name,
            date,
            counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
            staffOnShiftToday: shift.today,
            staffOnShiftNow: shift.now,
            waitlistActive: wl?.active ?? null,
            waitlistOpenMatches: wl?.open_matches ?? null,
          });
        }
        out.locations = locations;
      }
      if (can(ctx, 'pass.adjust') || can(ctx, 'plan.adjust')) {
        const r = await q.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1 AND consumption_review = 'pending' AND ($2::uuid[] IS NULL OR location_id = ANY($2::uuid[]))`,
          [ctx.orgId, scope],
        );
        out.pendingReviews = r.n;
      }
      if (can(ctx, 'pass.read') && can(ctx, 'booking.read.all')) {
        const params: unknown[] = [ctx.orgId];
        const vis = await customerVisibility(q, ctx, 'c', params, now);
        const today = todayIn(ctx.orgTimezone, now);
        params.push(today, addDays(today, 14));
        const r = await q.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM customer_passes cp JOIN customers c ON c.id = cp.customer_id
            WHERE cp.organization_id = $1 AND ${vis} AND cp.status = 'active' AND cp.remaining > 0
              AND cp.expires_on BETWEEN $${params.length - 1}::date AND $${params.length}::date`,
          params,
        );
        out.expiringPasses = r.n;
      }
      if (can(ctx, 'notification.read')) {
        const r = await q.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM notifications
            WHERE organization_id = $1 AND status = 'failed' AND created_at > $2 AND ($3::uuid[] IS NULL OR location_id IS NULL OR location_id = ANY($3::uuid[]))`,
          [ctx.orgId, new Date(now.getTime() - 7 * 86400_000), scope],
        );
        out.failedNotifications = r.n;
      }
      if (ctx.staffId && !can(ctx, 'booking.read.all')) {
        const today = todayIn(ctx.orgTimezone, now);
        const day = localDayRange(today, ctx.orgTimezone);
        const mine = await q.one<{ today: number; upcoming7: number }>(
          `SELECT count(*) FILTER (WHERE starts_at >= $3 AND starts_at < $4 AND status NOT IN ('canceled_customer','canceled_business'))::int AS today,
                  count(*) FILTER (WHERE starts_at >= $4 AND starts_at < $5 AND status = 'confirmed')::int AS upcoming7
             FROM bookings WHERE organization_id = $1 AND staff_id = $2`,
          [ctx.orgId, ctx.staffId, day.start, day.end, localDayRange(addDays(today, 7), ctx.orgTimezone).end],
        );
        // 記録が未入力(内部メモ・お客様向けメモとも空)の自分の完了予約(直近14日)
        const missing = await q.many<{ booking_id: string; customer_name: string; service_name: string; performed_at: Date }>(
          `SELECT r.booking_id, c.name AS customer_name, r.service_snapshot->>'name' AS service_name, r.performed_at
             FROM service_records r JOIN customers c ON c.id = r.customer_id
            WHERE r.organization_id = $1 AND r.staff_id = $2 AND r.status = 'active' AND r.performed_at > $3
              AND r.internal_memo IS NULL AND r.customer_memo IS NULL
            ORDER BY r.performed_at DESC LIMIT 10`,
          [ctx.orgId, ctx.staffId, new Date(now.getTime() - 14 * 86400_000)],
        );
        out.mine = { today: mine.today, upcoming7: mine.upcoming7, recordsMissing: missing.map((m) => ({ bookingId: m.booking_id, customerName: m.customer_name, serviceName: m.service_name, performedAt: m.performed_at })) };
      }
      return out;
    });
  });
}
