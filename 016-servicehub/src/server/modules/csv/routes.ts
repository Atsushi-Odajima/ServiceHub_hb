import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { daysBetween, localDayRange } from '../../../shared/time.js';
import { buildIcsCalendar } from '../public/ics.js';
import { actorOf, writeAudit } from '../../audit.js';
import { can, canAccessLocation, locationScope, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zUuid } from '../../http/validate.js';
import { buildExport, EXPORT_KINDS, EXPORT_LABELS, EXPORT_PERMS, type ExportKind, PERIOD_KINDS } from './export.js';
import { contentDisposition, CSV_BOM, csvLine } from './format.js';
import { commitImport, IMPORT_KINDS, MAX_IMPORT_BYTES, previewImport } from './import.js';

export async function registerCsvRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  // ---------------- 予約の一括カレンダー出力(.ics)。キャンセル・無断欠席は含めない ----------------
  app.get('/api/v1/export/bookings.ics', async (req, reply) => {
    const ctx = requireAuth(req, 'csv.export.bookings');
    const f = parse(z.object({ from: zDate, to: zDate, locationId: zUuid.optional() }), req.query);
    if (f.to < f.from) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください');
    if (daysBetween(f.from, f.to) > 365) throw new AppError('VALIDATION_ERROR', '期間は366日以内にしてください');
    if (f.locationId && !canAccessLocation(ctx, f.locationId)) throw notFound('拠点');
    const now = clock.now();
    const scope = f.locationId ? [f.locationId] : locationScope(ctx);
    const tz = ctx.orgTimezone;
    const ics = await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'csv.exported', targetType: 'csv_export', locationId: f.locationId ?? null, metadata: { kind: 'bookings_ics', ...f }, requestId: req.id });
      const rows = await q.many<{ id: string; code: string; starts_at: Date; ends_at: Date; service_name: string; location_name: string; staff_name: string | null; customer_name: string; party_size: number }>(
        `SELECT b.id, b.code, b.starts_at, b.ends_at, b.service_snapshot->>'name' AS service_name, b.location_snapshot->>'name' AS location_name,
                b.staff_snapshot->>'displayName' AS staff_name, c.name AS customer_name, b.party_size
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND ($4::uuid[] IS NULL OR b.location_id = ANY($4::uuid[]))
            AND b.status IN ('confirmed', 'arrived', 'in_service', 'completed')
          ORDER BY b.starts_at, b.id
          LIMIT 20000`,
        [ctx.orgId, localDayRange(f.from, tz).start, localDayRange(f.to, tz).end, scope],
      );
      return buildIcsCalendar(
        rows.map((r) => ({
          uid: `${r.id}@servicehub`,
          start: r.starts_at,
          end: r.ends_at,
          summary: `${r.customer_name} 様 ${r.service_name}${r.party_size > 1 ? `(${r.party_size}名)` : ''}`,
          location: r.location_name,
          description: `予約番号: ${r.code}${r.staff_name ? `\n担当: ${r.staff_name}` : ''}`,
        })),
        now,
        'ServiceHub 予約',
      );
    });
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="servicehub_bookings_${f.from}_${f.to}.ics"`);
    return ics;
  });

  // ---------------- 出力(UTF-8 BOM・CRLF・数式インジェクション対策。カーソルで分割して送る) ----------------
  app.get('/api/v1/csv/export/:kind', async (req, reply) => {
    const ctx = requireAuth(req);
    const { kind } = parse(z.object({ kind: z.enum(EXPORT_KINDS) }), req.params);
    if (!can(ctx, EXPORT_PERMS[kind])) throw forbidden();
    const f = parse(z.object({ from: zDate.optional(), to: zDate.optional(), locationId: zUuid.optional(), status: z.enum(['active', 'all']).default('active') }), req.query);
    if (PERIOD_KINDS.has(kind)) {
      if (!f.from || !f.to) throw new AppError('VALIDATION_ERROR', '期間を指定してください', { fields: { from: '必須です' } });
      if (f.to < f.from) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください');
      if (daysBetween(f.from, f.to) > 365) throw new AppError('VALIDATION_ERROR', '期間は366日以内にしてください');
    }
    if (f.locationId && !canAccessLocation(ctx, f.locationId)) throw notFound('拠点');
    const now = clock.now();
    // 誰が何を出力したかは先に記録(個人情報の持ち出し追跡)
    await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) =>
      writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'csv.exported', targetType: 'csv_export', locationId: f.locationId ?? null, metadata: { kind, ...f }, requestId: req.id }),
    );
    const stamp = now.toISOString().slice(0, 10);
    const period = f.from && f.to ? `_${f.from}_${f.to}` : `_${stamp}`;
    reply.hijack();
    const raw = reply.raw;
    let rows = 0;
    try {
      await withTenant(
        pool,
        { orgId: ctx.orgId },
        async (q) => {
          const ex = await buildExport(q, ctx, kind as ExportKind, f, now, locationScope(ctx));
          raw.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': contentDisposition(`servicehub_${kind}${period}.csv`, `${EXPORT_LABELS[kind as ExportKind]}${period}.csv`),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          raw.write(CSV_BOM + csvLine(ex.header));
          await q.exec(`DECLARE csv_export NO SCROLL CURSOR FOR ${ex.sql}`, ex.params);
          for (;;) {
            const batch = await q.many('FETCH 1000 FROM csv_export');
            if (batch.length === 0) break;
            let chunk = '';
            for (const r of batch) chunk += csvLine(ex.row(r));
            rows += batch.length;
            if (!raw.write(chunk)) await once(raw, 'drain');
          }
          await q.exec('CLOSE csv_export');
        },
        { isolation: 'repeatable read', readOnly: true, statementTimeoutMs: 120_000 },
      );
      raw.end();
      req.log.info({ kind, rows }, 'csv exported');
    } catch (err) {
      req.log.error({ err: String((err as Error).message), kind }, 'csv export failed');
      if (!raw.headersSent) {
        raw.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        raw.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'CSVの作成に失敗しました' } }));
      } else raw.destroy(err as Error);
    }
  });

  // ---------------- 取込(プレビュー → 反映) ----------------
  app.post('/api/v1/csv/import/preview', { bodyLimit: MAX_IMPORT_BYTES * 2 }, async (req) => {
    const ctx = requireAuth(req, 'csv.import');
    const body = parse(z.object({ kind: z.enum(IMPORT_KINDS), fileName: z.string().max(200).nullable().default(null), content: z.string().min(1).max(MAX_IMPORT_BYTES * 2) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) =>
      previewImport(q, ctx.orgId, actorOf(ctx), { kind: body.kind, fileName: body.fileName, content: body.content, createdBy: ctx.membershipId }),
    );
  });

  app.post('/api/v1/csv/import/:id/commit', async (req) => {
    const ctx = requireAuth(req, 'csv.import');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ duplicates: z.enum(['skip', 'create']).default('skip') }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) => commitImport(q, ctx.orgId, actorOf(ctx), { id, duplicates: body.duplicates, createdBy: ctx.membershipId, requestId: req.id }), {
      statementTimeoutMs: 120_000,
    });
  });

  app.post('/api/v1/csv/import/:id/cancel', async (req) => {
    const ctx = requireAuth(req, 'csv.import');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.exec(`UPDATE csv_imports SET status = 'canceled' WHERE organization_id = $1 AND id = $2 AND status = 'previewed'`, [ctx.orgId, id]);
      if (n === 0) throw notFound('取込(プレビュー中)');
      return { ok: true };
    });
  });

  app.get('/api/v1/csv/imports', async (req) => {
    const ctx = requireAuth(req, 'csv.import');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const rows = await q.many<{ id: string; kind: string; file_name: string | null; status: string; row_count: number; error_count: number; result: unknown; created_at: Date; committed_at: Date | null; created_by: string | null }>(
        `SELECT i.id, i.kind, i.file_name, i.status, i.row_count, i.error_count, i.result, i.created_at, i.committed_at, u.display_name AS created_by
           FROM csv_imports i LEFT JOIN memberships m ON m.id = i.created_by_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE i.organization_id = $1 ORDER BY i.created_at DESC, i.id DESC LIMIT 50`,
        [ctx.orgId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          fileName: r.file_name,
          status: r.status,
          rowCount: r.row_count,
          errorCount: r.error_count,
          result: r.result,
          createdAt: r.created_at,
          committedAt: r.committed_at,
          createdBy: r.created_by,
        })),
      };
    });
  });
}
