import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, isValidDate, localDayRange, localTimeOf, todayIn } from '../../../shared/time.js';
import { canAccessLocation, requireAuth } from '../../auth/context.js';
import { businessIntervals, candidateStarts, listSlots } from '../../engine/availability.js';
import { loadEngineInput } from '../../engine/loader.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zUuid } from '../../http/validate.js';

/** 空き枠お知らせ画像の対象日数(元ツールと同じ7日間) */
export const ANNOUNCEMENT_DAYS = 7;

/**
 * ServiceHub 空き枠お知らせ画像(#005 サロン空き枠お知らせ画像メーカーの統合)。
 * 予約エンジンの空き枠をそのまま使い、7日分の「候補時刻 + 空きの有無」を返す。
 * 画像に載せる枠の選択・手動の上書き・描画はブラウザ側で行う(サーバーは読み取りのみ・何も書き込まない)。
 */
export async function registerAnnouncementRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/availability/announcement', async (req) => {
    // 予約を入れられる人(拠点全体の空きを見られる人)のみ。担当分しか見られない Staff は対象外
    const ctx = requireAuth(req, 'booking.create.all');
    const qy = parse(
      z.object({
        locationId: zUuid,
        serviceId: zUuid,
        from: zDate,
        staffId: zUuid.optional(),
        // public: 公開予約ページと同じ条件(受付期間・直前締切・公開設定) / staff: スタッフが予約を入れられる条件
        basis: z.enum(['public', 'staff']).default('public'),
      }),
      req.query,
    );
    if (!isValidDate(qy.from)) throw new AppError('VALIDATION_ERROR', '開始日が正しい日付ではありません', { fields: { from: '正しい日付を入力してください' } });
    if (!canAccessLocation(ctx, qy.locationId)) throw notFound('拠点');
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const loc = await q.maybeOne<{ name: string; timezone: string; is_public: boolean; status: string }>(
        'SELECT name, timezone, is_public, status FROM locations WHERE organization_id = $1 AND id = $2',
        [ctx.orgId, qy.locationId],
      );
      if (!loc) throw notFound('拠点');
      const svc = await q.maybeOne<{ name: string; is_public: boolean; duration_min: number }>(
        'SELECT name, is_public, duration_min FROM services WHERE organization_id = $1 AND id = $2',
        [ctx.orgId, qy.serviceId],
      );
      if (!svc) throw notFound('サービス');
      const to = addDays(qy.from, ANNOUNCEMENT_DAYS - 1);
      const now = clock.now();
      const input = await loadEngineInput(q, {
        orgId: ctx.orgId,
        locationId: qy.locationId,
        serviceId: qy.serviceId,
        from: localDayRange(qy.from, loc.timezone).start,
        to: localDayRange(to, loc.timezone).end,
        now,
        mode: qy.basis,
      });
      if (!input) throw notFound('サービス');
      if (qy.staffId && !input.staff.some((s) => s.id === qy.staffId)) throw notFound('スタッフ');
      const staffChoice = input.service.requiresStaff ? (qy.staffId ?? 'auto') : 'auto';
      const days = [];
      for (let i = 0; i < ANNOUNCEMENT_DAYS; i++) {
        const date = addDays(qy.from, i);
        const closed = businessIntervals(input.location, date).length === 0;
        const open = new Map(listSlots(input, date, staffChoice).map((s) => [s.start.getTime(), s]));
        const slots = candidateStarts(input, date)
          // 過ぎた時刻は告知しても予約できないため候補に出さない
          .filter((t) => t.getTime() > now.getTime())
          .map((t) => {
            const s = open.get(t.getTime());
            return {
              time: localTimeOf(t, loc.timezone),
              startsAt: t.toISOString(),
              available: Boolean(s),
              seatsAvailable: s && input.service.capacity > 1 ? s.seatsAvailable : null,
            };
          });
        days.push({ date, closed, slots });
      }
      return {
        from: qy.from,
        to,
        today: todayIn(loc.timezone, now),
        timezone: loc.timezone,
        basis: qy.basis,
        location: { name: loc.name, isPublic: loc.is_public && loc.status === 'active' },
        service: { name: svc.name, isPublic: svc.is_public, durationMin: svc.duration_min },
        days,
      };
    });
  });
}
