import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeName } from '../../../shared/normalize.js';
import { todayIn } from '../../../shared/time.js';
import { can, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { type BookingListRow, bookingDto } from '../bookings/routes.js';
import { customerDto, searchCustomerRows } from '../customers/routes.js';
import { customerVisibility } from '../customers/visibility.js';
import { type PassRow, passDto } from '../entitlements/routes.js';

/**
 * 横断検索(顧客・予約番号・スタッフ・サービス・回数券・拠点)。権限と拠点スコープの範囲内だけを返す。
 * 回数券: 見つかった顧客の有効な回数券と、名前(「8回券」など)が一致する有効な回数券(見てよい顧客のものだけ)
 */
export async function registerSearchRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/search', async (req) => {
    const ctx = requireAuth(req);
    const { q: text } = parse(z.object({ q: z.string().trim().min(1, '検索語を入力してください').max(100) }), req.query);
    const needle = normalizeName(text);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const out: Record<string, unknown[]> = {};
      if (can(ctx, 'customer.read')) {
        const params: unknown[] = [ctx.orgId];
        const vis = await customerVisibility(q, ctx, 'c', params, clock.now());
        const rows = await searchCustomerRows(q, ['c.organization_id = $1', vis, `c.status IN ('active','archived')`], params, text, 'c.last_visit_at DESC NULLS LAST, c.created_at DESC', 10);
        out.customers = rows.map((r) => {
          const d = customerDto(r);
          return { id: d.id, name: d.name, nameKana: d.nameKana, phone: d.phone, email: d.email, status: d.status, lastVisitAt: d.lastVisitAt };
        });
      }
      if (can(ctx, 'booking.read.all') || can(ctx, 'booking.read.own')) {
        const code = text.toUpperCase().replace(/[\s-]/g, '');
        if (/^[A-Z0-9]{4,12}$/.test(code)) {
          const ownOnly = !can(ctx, 'booking.read.all');
          const rows = await q.many<BookingListRow>(
            `SELECT b.*, c.name AS customer_name, c.name_kana AS customer_kana, c.status AS customer_status
               FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
              WHERE b.organization_id = $1 AND b.code = $2 AND ($3::uuid[] IS NULL OR b.location_id = ANY($3::uuid[]))
                AND ($4::uuid IS NULL OR b.staff_id = $4)
              LIMIT 5`,
            [ctx.orgId, code, locationScope(ctx), ownOnly ? (ctx.staffId ?? '00000000-0000-0000-0000-000000000000') : null],
          );
          out.bookings = rows.map((r) => bookingDto(r, ctx));
        } else out.bookings = [];
      }
      // スタッフ・サービスは件数が少ないため取得して照合(拠点スコープ内)
      const scope = locationScope(ctx);
      const staff = await q.many<{ id: string; display_name: string; status: string }>(
        `SELECT s.id, s.display_name, s.status FROM staff s
          WHERE s.organization_id = $1 AND s.status = 'active'
            AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM staff_locations x WHERE x.staff_id = s.id AND x.location_id = ANY($2::uuid[])))`,
        [ctx.orgId, scope],
      );
      out.staff = staff.filter((s) => normalizeName(s.display_name).includes(needle)).slice(0, 10).map((s) => ({ id: s.id, name: s.display_name }));
      const services = await q.many<{ id: string; name: string; status: string }>(
        `SELECT s.id, s.name, s.status FROM services s
          WHERE s.organization_id = $1 AND s.status = 'active'
            AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM service_locations x WHERE x.service_id = s.id AND x.location_id = ANY($2::uuid[])))`,
        [ctx.orgId, scope],
      );
      out.services = services.filter((s) => normalizeName(s.name).includes(needle)).slice(0, 10).map((s) => ({ id: s.id, name: s.name }));
      if (can(ctx, 'pass.read')) {
        const params: unknown[] = [ctx.orgId];
        const vis = await customerVisibility(q, ctx, 'c', params, clock.now());
        params.push(((out.customers ?? []) as { id: string }[]).map((c) => c.id));
        const ids = params.length;
        params.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
        const like = params.length;
        const rows = await q.many<PassRow>(
          `SELECT cp.*, c.name AS customer_name FROM customer_passes cp
             JOIN customers c ON c.id = cp.customer_id AND c.organization_id = cp.organization_id
            WHERE cp.organization_id = $1 AND ${vis} AND cp.status = 'active'
              AND (cp.customer_id = ANY($${ids}::uuid[]) OR (cp.product_snapshot->>'name') ILIKE $${like})
            ORDER BY cp.expires_on NULLS LAST, cp.granted_at DESC, cp.id DESC
            LIMIT 10`,
          params,
        );
        const today = todayIn(ctx.orgTimezone, clock.now());
        out.passes = rows.map((r) => {
          const d = passDto(r, today);
          return { id: d.id, customerId: d.customerId, customerName: d.customerName, name: d.name, remaining: d.remaining, expiresOn: d.expiresOn };
        });
      }
      const locations = await q.many<{ id: string; name: string; slug: string }>(
        `SELECT l.id, l.name, l.slug FROM locations l
          WHERE l.organization_id = $1 AND l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[]))
          ORDER BY l.sort_order, l.name, l.id`,
        [ctx.orgId, scope],
      );
      const lower = text.toLowerCase();
      out.locations = locations.filter((l) => normalizeName(l.name).includes(needle) || l.slug.includes(lower)).slice(0, 10);
      return out;
    });
  });
}
