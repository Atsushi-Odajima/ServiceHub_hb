import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDayRange } from '../../../shared/time.js';
import { canAccessLocation, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { notFound } from '../../errors.js';
import { parse, zDate, zUuid } from '../../http/validate.js';

/**
 * 監査ログの閲覧(追記専用。変更・削除はDBが拒否)。
 * Manager は担当拠点に紐づく記録のみ(組織全体の設定変更など拠点のない記録は Owner のみ)。
 */
export async function registerAuditRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/audit', async (req) => {
    const ctx = requireAuth(req, 'audit.read');
    const qy = parse(
      z.object({
        from: zDate.optional(),
        to: zDate.optional(),
        action: z.string().max(80).optional(),
        targetType: z.string().max(40).optional(),
        targetId: zUuid.optional(),
        locationId: zUuid.optional(),
        actorMembershipId: zUuid.optional(),
        before: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    if (qy.locationId && !canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    const scope = locationScope(ctx);
    const tz = ctx.orgTimezone;
    // ページング: before = "<ISO日時>|<id>"(新しい順)
    let beforeAt: Date | null = null;
    let beforeId: string | null = null;
    if (qy.before) {
      const [t, id] = qy.before.split('|');
      beforeAt = new Date(t);
      beforeId = id ?? null;
    }
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{
        id: string;
        actor_type: string;
        actor_label: string | null;
        actor_membership_id: string | null;
        action: string;
        target_type: string;
        target_id: string | null;
        location_id: string | null;
        location_name: string | null;
        before: unknown;
        after: unknown;
        metadata: unknown;
        request_id: string | null;
        created_at: Date;
      }>(
        `SELECT a.*, l.name AS location_name FROM audit_logs a LEFT JOIN locations l ON l.id = a.location_id
          WHERE a.organization_id = $1
            AND ($2::timestamptz IS NULL OR a.created_at >= $2) AND ($3::timestamptz IS NULL OR a.created_at < $3)
            AND ($4::text IS NULL OR a.action = $4 OR a.action LIKE $4 || '.%')
            AND ($5::text IS NULL OR a.target_type = $5) AND ($6::uuid IS NULL OR a.target_id = $6)
            AND ($7::uuid IS NULL OR a.location_id = $7)
            AND ($8::uuid[] IS NULL OR a.location_id = ANY($8::uuid[]))
            AND ($9::uuid IS NULL OR a.actor_membership_id = $9)
            AND ($10::timestamptz IS NULL OR (a.created_at, a.id) < ($10, $11::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $12`,
        [
          ctx.orgId,
          qy.from ? localDayRange(qy.from, tz).start : null,
          qy.to ? localDayRange(qy.to, tz).end : null,
          qy.action ?? null,
          qy.targetType ?? null,
          qy.targetId ?? null,
          qy.locationId ?? null,
          scope,
          qy.actorMembershipId ?? null,
          beforeAt,
          beforeId ?? '00000000-0000-0000-0000-000000000000',
          qy.limit,
        ],
      );
      const last = rows[rows.length - 1];
      return {
        items: rows.map((r) => ({
          id: r.id,
          at: r.created_at,
          actorType: r.actor_type,
          actor: r.actor_type === 'system' ? 'システム' : r.actor_type === 'customer' ? 'お客様(Web)' : r.actor_label,
          actorMembershipId: r.actor_membership_id,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          locationId: r.location_id,
          locationName: r.location_name,
          before: r.before,
          after: r.after,
          metadata: r.metadata,
          requestId: r.request_id,
        })),
        next: rows.length === qy.limit && last ? `${last.created_at.toISOString()}|${last.id}` : null,
      };
    });
  });
}
