import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { maskEmail } from '../../../shared/normalize.js';
import { actorOf, writeAudit } from '../../audit.js';
import { locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { invalidState, notFound } from '../../errors.js';
import { parse, zIso, zUuid } from '../../http/validate.js';

export async function registerNotificationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/notifications', async (req) => {
    const ctx = requireAuth(req, 'notification.read');
    const qy = parse(
      z.object({
        status: z.enum(['pending', 'sending', 'sent', 'failed', 'skipped', 'canceled']).optional(),
        type: z.string().max(40).optional(),
        from: zIso.optional(),
        to: zIso.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{
        id: string;
        type: string;
        recipient: string | null;
        status: string;
        attempts: number;
        last_error: string | null;
        subject: string | null;
        skip_reason: string | null;
        sent_at: Date | null;
        created_at: Date;
        next_attempt_at: Date;
        booking_id: string | null;
        location_id: string | null;
      }>(
        `SELECT id, type, recipient, status, attempts, last_error, subject, skip_reason, sent_at, created_at, next_attempt_at, booking_id, location_id
           FROM notifications
          WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR type = $3)
            AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)
            AND ($6::uuid[] IS NULL OR location_id = ANY($6::uuid[]))
          ORDER BY created_at DESC, id DESC LIMIT $7`,
        [ctx.orgId, qy.status ?? null, qy.type ?? null, qy.from ?? null, qy.to ?? null, locationScope(ctx), qy.limit],
      );
      const counts = await q.many<{ status: string; n: number }>(
        `SELECT status, count(*) AS n FROM notifications WHERE organization_id = $1 AND created_at >= $2
            AND ($3::uuid[] IS NULL OR location_id = ANY($3::uuid[])) GROUP BY status`,
        [ctx.orgId, new Date(clock.now().getTime() - 30 * 86400_000), locationScope(ctx)],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          // 本文(管理URL等)は表示しない。宛先はマスク
          recipient: maskEmail(r.recipient),
          status: r.status,
          attempts: r.attempts,
          lastError: r.last_error,
          subject: r.subject,
          skipReason: r.skip_reason,
          sentAt: r.sent_at,
          createdAt: r.created_at,
          nextAttemptAt: r.next_attempt_at,
          bookingId: r.booking_id,
        })),
        last30Days: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        provider: deps.mailer.name,
        delivers: deps.mailer.delivers,
      };
    });
  });

  app.post('/api/v1/notifications/:id/retry', async (req) => {
    const ctx = requireAuth(req, 'notification.retry');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.maybeOne<{ status: string; location_id: string | null }>(
        'SELECT status, location_id FROM notifications WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [ctx.orgId, id],
      );
      if (!n) throw notFound('通知');
      const scope = locationScope(ctx);
      if (scope && (!n.location_id || !scope.includes(n.location_id))) throw notFound('通知');
      if (n.status !== 'failed') throw invalidState('失敗した通知のみ再送できます');
      // 同じ通知行を再キュー(新しい通知は作らないので重複送信の原因にならない)
      await q.exec(`UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = $3, last_error = NULL WHERE organization_id = $1 AND id = $2`, [
        ctx.orgId,
        id,
        clock.now(),
      ]);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'notification.retried', targetType: 'notification', targetId: id, locationId: n.location_id, requestId: req.id });
      return { ok: true };
    });
  });

}
