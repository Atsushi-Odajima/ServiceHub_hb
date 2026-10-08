import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EXCLUDED_STATUSES } from '../../../shared/namebadge/core.js';
import { isValidDate, localDayRange, localTimeOf } from '../../../shared/time.js';
import { can, canAccessLocation, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import { parse, zDate, zIso, zUuid } from '../../http/validate.js';

/** 1回の取得で扱う予約の上限(1拠点1日分) */
export const NAME_BADGE_MAX_BOOKINGS = 1000;

interface Row {
  id: string;
  created_at: Date;
  starts_at: Date;
  ends_at: Date;
  status: string;
  party_size: number;
  service_id: string;
  service_snapshot: { name?: string; capacity?: number } | null;
  staff_snapshot: { displayName?: string } | null;
  customer_name: string;
  customer_kana: string | null;
  customer_tags: string[] | null;
}

/**
 * ServiceHub 名札・受付表(#010 名札・受付チェック表メーカーの統合)。
 * 拠点・日付の予約から「回」(同じサービス・同じ開始時刻)の一覧と、選んだ回(または1日全体)の予約を返す。
 * 参加者番号の割り当て・並び替え・レイアウトはブラウザ側の共通モジュール(src/shared/namebadge)で行う。
 * 読み取りのみ。キャンセル・無断欠席の予約は番号を欠番として残すため ID・作成日時・状態だけを返す(氏名は返さない)。
 */
export async function registerNameBadgeRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/name-badges', async (req) => {
    const ctx = requireAuth(req, 'booking.read.all', 'booking.read.own');
    const qy = parse(
      z.object({
        locationId: zUuid,
        date: zDate,
        // 回の指定(両方そろえる)。省略すると1日全体
        serviceId: zUuid.optional(),
        startsAt: zIso.optional(),
      }),
      req.query,
    );
    if (!isValidDate(qy.date)) throw new AppError('VALIDATION_ERROR', '日付が正しくありません', { fields: { date: '正しい日付を入力してください' } });
    if (Boolean(qy.serviceId) !== Boolean(qy.startsAt)) {
      throw new AppError('VALIDATION_ERROR', '回を指定する場合はサービスと開始時刻をそろえてください', { fields: { startsAt: 'サービスと開始時刻をそろえてください' } });
    }
    if (!canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    // 担当分だけ見られるスタッフは、自分が担当する予約だけ
    const ownStaff = can(ctx, 'booking.read.all') ? null : ctx.staffId;
    if (!can(ctx, 'booking.read.all') && !ctx.staffId) throw forbidden('スタッフとして紐付けられていません');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const loc = await q.maybeOne<{ name: string; timezone: string }>('SELECT name, timezone FROM locations WHERE organization_id = $1 AND id = $2', [ctx.orgId, qy.locationId]);
      if (!loc) throw notFound('拠点');
      const day = localDayRange(qy.date, loc.timezone);
      const rows = await q.many<Row>(
        `SELECT b.id, b.created_at, b.starts_at, b.ends_at, b.status, b.party_size, b.service_id, b.service_snapshot, b.staff_snapshot,
                c.name AS customer_name, c.name_kana AS customer_kana, c.tags AS customer_tags
           FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
          WHERE b.organization_id = $1 AND b.location_id = $2 AND b.starts_at >= $3 AND b.starts_at < $4
            AND ($5::uuid IS NULL OR b.staff_id = $5)
          ORDER BY b.starts_at, b.created_at, b.id
          LIMIT ${NAME_BADGE_MAX_BOOKINGS + 1}`,
        [ctx.orgId, qy.locationId, day.start, day.end, ownStaff],
      );
      if (rows.length > NAME_BADGE_MAX_BOOKINGS) {
        throw new AppError('VALIDATION_ERROR', `この日の予約が${NAME_BADGE_MAX_BOOKINGS}件を超えるため表示できません`);
      }

      // 回の一覧(同じサービス・同じ開始時刻)。人数はキャンセル・無断欠席を除く
      const sessions = new Map<string, { serviceId: string; serviceName: string; startsAt: string; startTime: string; endTime: string; capacity: number; staffNames: string[]; bookings: number; people: number }>();
      for (const r of rows) {
        const k = `${r.service_id}|${r.starts_at.toISOString()}`;
        let s = sessions.get(k);
        if (!s) {
          s = {
            serviceId: r.service_id,
            serviceName: r.service_snapshot?.name ?? '',
            startsAt: r.starts_at.toISOString(),
            startTime: localTimeOf(r.starts_at, loc.timezone),
            endTime: localTimeOf(r.ends_at, loc.timezone),
            capacity: r.service_snapshot?.capacity ?? 1,
            staffNames: [],
            bookings: 0,
            people: 0,
          };
          sessions.set(k, s);
        }
        if (EXCLUDED_STATUSES.has(r.status)) continue;
        s.bookings++;
        s.people += r.party_size;
        const st = r.staff_snapshot?.displayName;
        if (st && !s.staffNames.includes(st)) s.staffNames.push(st);
      }

      let selected = null;
      let targets = rows;
      if (qy.serviceId && qy.startsAt) {
        const startMs = new Date(qy.startsAt).getTime();
        selected = sessions.get(`${qy.serviceId}|${new Date(startMs).toISOString()}`) ?? null;
        if (!selected) throw notFound('回');
        targets = rows.filter((r) => r.service_id === qy.serviceId && r.starts_at.getTime() === startMs);
      }

      return {
        location: { id: qy.locationId, name: loc.name, timezone: loc.timezone },
        date: qy.date,
        scope: selected ? 'session' : 'day',
        sessions: [...sessions.values()],
        selected,
        bookings: targets.map((r) => {
          const active = !EXCLUDED_STATUSES.has(r.status);
          return {
            id: r.id,
            createdAt: r.created_at.toISOString(),
            startsAt: r.starts_at.toISOString(),
            startTime: localTimeOf(r.starts_at, loc.timezone),
            status: r.status,
            partySize: r.party_size,
            // 取り消された予約は番号の計算にだけ使うため、氏名などは返さない
            customerName: active ? r.customer_name : '',
            customerKana: active ? r.customer_kana : null,
            customerTags: active ? (r.customer_tags ?? []) : [],
            serviceName: active ? (r.service_snapshot?.name ?? '') : '',
            staffName: active ? (r.staff_snapshot?.displayName ?? null) : null,
          };
        }),
      };
    });
  });
}
