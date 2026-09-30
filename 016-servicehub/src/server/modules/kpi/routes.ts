import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { daysBetween } from '../../../shared/time.js';
import { canAccessLocation, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zUuid } from '../../http/validate.js';
import { customerVisibility } from '../customers/visibility.js';
import { computeKpi } from './service.js';

export async function registerKpiRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/kpi', async (req) => {
    const ctx = requireAuth(req, 'kpi.read');
    const qy = parse(z.object({ from: zDate, to: zDate, locationId: zUuid.optional() }), req.query);
    if (qy.to < qy.from) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください', { fields: { to: '開始日以降にしてください' } });
    if (daysBetween(qy.from, qy.to) > 365) throw new AppError('VALIDATION_ERROR', '期間は366日以内にしてください', { fields: { to: '366日以内にしてください' } });
    if (qy.locationId && !canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    const scope = locationScope(ctx);
    const locationIds = qy.locationId ? [qy.locationId] : scope;
    const now = clock.now();
    return withTenant(pool, { orgId: ctx.orgId }, async (q) =>
      computeKpi(q, ctx.orgId, {
        from: qy.from,
        to: qy.to,
        locationIds,
        customerVis: (params) => customerVisibility(q, ctx, 'c', params, now),
        orgTimezone: ctx.orgTimezone,
        now,
      }),
    );
  });
}
