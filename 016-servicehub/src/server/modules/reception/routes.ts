import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDayRange, todayIn } from '../../../shared/time.js';
import { canAccessLocation, can, requireAuth } from '../../auth/context.js';
import { loadSession, SESSION_COOKIE } from '../../auth/session.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zUuid } from '../../http/validate.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import { type BookingListRow, bookingDto } from '../bookings/routes.js';

export async function registerReceptionRoutes(app: FastifyInstance, deps: Deps & { realtime?: RealtimeHub | null }): Promise<void> {
  const { pool, clock } = deps;

  /** 受付ボード(受付モード): 拠点の当日予約を大きく表示するための最小限の情報 */
  app.get('/api/v1/reception/board', async (req) => {
    const ctx = requireAuth(req, 'reception.operate');
    const qy = parse(z.object({ locationId: zUuid, date: zDate.optional() }), req.query);
    if (!canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const loc = await q.maybeOne<{ timezone: string; name: string }>('SELECT timezone, name FROM locations WHERE organization_id = $1 AND id = $2', [ctx.orgId, qy.locationId]);
      if (!loc) throw notFound('拠点');
      const date = qy.date ?? todayIn(loc.timezone, clock.now());
      const day = localDayRange(date, loc.timezone);
      const rows = await q.many<BookingListRow>(
        `SELECT b.*, c.name AS customer_name, c.name_kana AS customer_kana, c.status AS customer_status
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.location_id = $2 AND b.starts_at >= $3 AND b.starts_at < $4
          ORDER BY b.starts_at, b.created_at`,
        [ctx.orgId, qy.locationId, day.start, day.end],
      );
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return {
        location: { id: qy.locationId, name: loc.name, timezone: loc.timezone },
        date,
        generatedAt: clock.now(),
        counts,
        // 受付には内部メモ・経営情報を出さない(bookingDto が権限で内部メモを除外)
        items: rows.map((r) => ({ ...bookingDto(r, ctx), internalNote: undefined, forceReason: undefined })),
      };
    });
  });

  /** 今日の予定(スマホのホーム)。Staff は自分の予約(全拠点)、その他は指定拠点 */
  app.get('/api/v1/today', async (req) => {
    const ctx = requireAuth(req, 'booking.read.all', 'booking.read.own');
    const qy = parse(z.object({ locationId: zUuid.optional() }), req.query);
    const ownOnly = !can(ctx, 'booking.read.all');
    if (!ownOnly && !qy.locationId) throw new AppError('VALIDATION_ERROR', '拠点を指定してください');
    if (qy.locationId && !canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    if (ownOnly && !ctx.staffId) throw forbidden('スタッフとして紐付けられていません');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const tz = qy.locationId
        ? ((await q.maybeOne<{ timezone: string }>('SELECT timezone FROM locations WHERE organization_id = $1 AND id = $2', [ctx.orgId, qy.locationId]))?.timezone ?? ctx.orgTimezone)
        : ctx.orgTimezone;
      const date = todayIn(tz, clock.now());
      const day = localDayRange(date, tz);
      const rows = await q.many<BookingListRow>(
        `SELECT b.*, c.name AS customer_name, c.name_kana AS customer_kana, c.status AS customer_status
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3
            AND ($4::uuid IS NULL OR b.staff_id = $4) AND ($5::uuid IS NULL OR b.location_id = $5)
            AND ($6::uuid[] IS NULL OR b.location_id = ANY($6::uuid[]))
          ORDER BY b.starts_at`,
        [ctx.orgId, day.start, day.end, ownOnly ? ctx.staffId : null, qy.locationId ?? null, ctx.allLocations ? null : ctx.locationIds],
      );
      const next = await q.maybeOne<BookingListRow>(
        `SELECT b.*, c.name AS customer_name, c.name_kana AS customer_kana, c.status AS customer_status
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.starts_at >= $2 AND b.status IN ('confirmed','arrived')
            AND ($3::uuid IS NULL OR b.staff_id = $3) AND ($4::uuid IS NULL OR b.location_id = $4)
            AND ($5::uuid[] IS NULL OR b.location_id = ANY($5::uuid[]))
          ORDER BY b.starts_at LIMIT 1`,
        [ctx.orgId, clock.now(), ownOnly ? ctx.staffId : null, qy.locationId ?? null, ctx.allLocations ? null : ctx.locationIds],
      );
      return { date, timezone: tz, generatedAt: clock.now(), items: rows.map((r) => bookingDto(r, ctx)), next: next ? bookingDto(next, ctx) : null };
    });
  });

  /** Server-Sent Events: 他端末での変更を通知(IDのみ)。セッションは定期的に再検証し、失効したら切断 */
  app.get('/api/v1/events', async (req, reply) => {
    const ctx = requireAuth(req);
    const hub = deps.realtime;
    if (!hub) throw new AppError('SERVICE_UNAVAILABLE', 'リアルタイム通知は利用できません');
    const token = req.cookies[SESSION_COOKIE] ?? '';
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 10000\n: connected\n\n');
    const unsub = hub.subscribe((ev) => {
      if (ev.o !== ctx.orgId) return;
      if (ev.l && !canAccessLocation(ctx, ev.l)) return;
      raw.write(`event: change\ndata: ${JSON.stringify({ entity: ev.e, id: ev.i, locationId: ev.l })}\n\n`);
    });
    const hb = setInterval(() => {
      void loadSession(pool, token, clock.now()).then((s) => {
        if (!s || s.membership_id !== ctx.membershipId) {
          raw.end();
          return;
        }
        raw.write(': ping\n\n');
      });
    }, 25_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });
}
