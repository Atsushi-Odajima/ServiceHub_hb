import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBookingPage } from '../../../shared/constants.js';
import { addDays, daysBetween, localDateOf, localDayRange, todayIn } from '../../../shared/time.js';
import { CUSTOMER_ACTOR } from '../../audit.js';
import { hmac, safeEqual, sha256 } from '../../auth/crypto.js';
import { listSlots } from '../../engine/availability.js';
import { loadEngineInput } from '../../engine/loader.js';
import { withSystem, withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zDate, zEmail, zIdempotencyKey, zIso, zOptText, zPhone, zUuid } from '../../http/validate.js';
import { enforceRateLimit } from '../../ratelimit.js';
import { type BookingActor, type BookingRow, cancelBooking, createBooking, rescheduleBooking } from '../bookings/service.js';
import { buildIcs } from './ics.js';

const PUBLIC_ACTOR: BookingActor = { actor: CUSTOMER_ACTOR, membershipId: null, mode: 'public', canForce: false };

interface PublicOrg {
  id: string;
  slug: string;
  name: string;
  is_sample: boolean;
  public_profile: { description?: string | null; contact?: string | null };
}

interface PublicLocation {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  booking_page: unknown;
  allow_customer_cancel: boolean;
  allow_customer_reschedule: boolean;
  allow_public_waitlist: boolean;
  cancel_deadline_hours: number;
  max_advance_days: number;
  min_notice_min: number;
}

/** 公開ページの組織解決(システム文脈: slug → 組織ID)。以降はテナント文脈で処理 */
async function resolveOrg(deps: Deps, slug: string): Promise<PublicOrg> {
  const org = await withSystem(deps.pool, (q) =>
    q.maybeOne<PublicOrg>(`SELECT id, slug, name, is_sample, public_profile FROM organizations WHERE slug = $1 AND status = 'active'`, [slug]),
  );
  if (!org) throw notFound('ページ');
  return org;
}

async function resolveLocation(q: Q, orgId: string, slug: string): Promise<PublicLocation> {
  const loc = await q.maybeOne<PublicLocation>(
    `SELECT id, slug, name, address, phone, timezone, booking_page, allow_customer_cancel, allow_customer_reschedule, allow_public_waitlist,
            cancel_deadline_hours, max_advance_days, min_notice_min
       FROM locations WHERE organization_id = $1 AND slug = $2 AND status = 'active' AND is_public`,
    [orgId, slug],
  );
  if (!loc) throw notFound('拠点');
  return loc;
}

function ip(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

/** 空き検索時に発行するフォームトークン(発行時刻の HMAC)。即時送信する bot を抑止 */
function issueFormToken(secret: string, orgId: string, now: Date): string {
  const t = String(now.getTime());
  return `${t}.${hmac(secret, `form:${orgId}:${t}`)}`;
}

function verifyFormToken(secret: string, orgId: string, token: string, now: Date): boolean {
  const [t, sig] = token.split('.');
  if (!t || !sig || !/^\d+$/.test(t)) return false;
  if (!safeEqual(sig, hmac(secret, `form:${orgId}:${t}`))) return false;
  const age = now.getTime() - Number(t);
  return age >= 3000 && age <= 2 * 3600_000;
}

async function verifyTurnstile(deps: Deps, token: string | undefined, remoteIp: string): Promise<boolean> {
  if (!deps.config.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: deps.config.TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp }),
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

function publicBooking(b: BookingRow, loc: { name: string; address?: string | null; phone?: string | null }) {
  return {
    code: b.code,
    status: b.status,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    partySize: b.party_size,
    serviceName: b.service_snapshot?.name,
    locationName: loc.name,
    locationAddress: loc.address ?? null,
    locationPhone: loc.phone ?? null,
    staffName: b.staff_snapshot?.displayName ?? null,
    timezone: b.location_snapshot?.timezone ?? 'Asia/Tokyo',
  };
}

const BookingBody = z.object({
  serviceId: zUuid,
  staffId: zUuid.nullable().default(null),
  startsAt: zIso,
  partySize: z.number().int().min(1).max(50).default(1),
  customer: z.object({
    name: z.string().trim().min(1, 'お名前を入力してください').max(100),
    nameKana: zOptText(100),
    email: zEmail,
    phone: zPhone.refine((v) => v !== null, '電話番号を入力してください'),
  }),
  customerRequest: zOptText(1000),
  answers: z.array(z.object({ questionId: zUuid, value: z.unknown() })).max(50).default([]),
  idempotencyKey: zIdempotencyKey,
  formToken: z.string().max(200),
  website: z.string().max(0, '不正な送信です').optional(), // ハニーポット(人には見えない項目)
  turnstileToken: z.string().max(4000).optional(),
  agree: z.literal(true, { message: '内容を確認のうえ同意してください' }),
});

export async function registerPublicRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock, config } = deps;
  const readLimit = async (req: FastifyRequest) => enforceRateLimit(pool, `public-read:${ip(req)}`, config.PUBLIC_RATE_LIMIT_PER_MIN * 4, 60, clock.now());

  app.get('/api/v1/public/config', async () => ({ turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null }));

  app.get('/api/v1/public/orgs/:slug', async (req) => {
    await readLimit(req);
    const { slug } = parse(z.object({ slug: z.string().max(60) }), req.params);
    const org = await resolveOrg(deps, slug);
    return withTenant(pool, { orgId: org.id }, async (q) => {
      const locs = await q.many<{ slug: string; name: string; address: string | null; phone: string | null }>(
        `SELECT slug, name, address, phone FROM locations WHERE organization_id = $1 AND status = 'active' AND is_public ORDER BY sort_order, name`,
        [org.id],
      );
      return {
        slug: org.slug,
        name: org.name,
        isSample: org.is_sample,
        description: org.public_profile?.description ?? null,
        contact: org.public_profile?.contact ?? null,
        locations: locs,
      };
    });
  });

  app.get('/api/v1/public/orgs/:slug/locations/:loc', async (req) => {
    await readLimit(req);
    const p = parse(z.object({ slug: z.string().max(60), loc: z.string().max(60) }), req.params);
    const org = await resolveOrg(deps, p.slug);
    return withTenant(pool, { orgId: org.id }, async (q) => {
      const loc = await resolveLocation(q, org.id, p.loc);
      const page = parseBookingPage(loc.booking_page);
      const services = await q.many<{
        id: string;
        name: string;
        description: string | null;
        category: string | null;
        duration_min: number;
        price_label: string | null;
        capacity: number;
        max_party_size: number;
        requires_staff: boolean;
        notice: string | null;
      }>(
        `SELECT s.id, s.name, s.description, s.category, s.duration_min, s.price_label, s.capacity, s.max_party_size, s.requires_staff, s.notice
           FROM services s JOIN service_locations sl ON sl.service_id = s.id AND sl.location_id = $2
          WHERE s.organization_id = $1 AND s.status = 'active' AND s.is_bookable AND s.is_public
          ORDER BY s.sort_order, s.name`,
        [org.id, loc.id],
      );
      const staff = page.allowStaffSelection
        ? await q.many<{ id: string; display_name: string; public_profile: string | null; service_ids: string[] }>(
            `SELECT st.id, st.display_name, st.public_profile,
                    coalesce((SELECT array_agg(ss.service_id) FROM service_staff ss WHERE ss.staff_id = st.id), '{}') AS service_ids
               FROM staff st JOIN staff_locations sl ON sl.staff_id = st.id AND sl.location_id = $2
              WHERE st.organization_id = $1 AND st.status = 'active' AND st.accepts_bookings
              ORDER BY st.sort_order, st.display_name`,
            [org.id, loc.id],
          )
        : [];
      return {
        organization: { slug: org.slug, name: org.name, isSample: org.is_sample },
        // 確認メールが実際に届く設定か(サンプル組織・メール未設定では送信されない)
        emailDelivery: deps.mailer.delivers && !org.is_sample,
        location: {
          slug: loc.slug,
          name: loc.name,
          address: loc.address,
          phone: loc.phone,
          timezone: loc.timezone,
          maxAdvanceDays: loc.max_advance_days,
          allowWaitlist: loc.allow_public_waitlist,
          cancelDeadlineHours: loc.cancel_deadline_hours,
          page,
        },
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          durationMin: s.duration_min,
          priceLabel: page.showPrices ? s.price_label : null,
          capacity: s.capacity,
          maxPartySize: s.max_party_size,
          requiresStaff: s.requires_staff,
          notice: s.notice,
        })),
        staff: staff.map((s) => ({ id: s.id, name: s.display_name, profile: s.public_profile, serviceIds: s.service_ids })),
      };
    });
  });

  app.get('/api/v1/public/orgs/:slug/locations/:loc/services/:serviceId/questions', async (req) => {
    await readLimit(req);
    const p = parse(z.object({ slug: z.string().max(60), loc: z.string().max(60), serviceId: zUuid }), req.params);
    const org = await resolveOrg(deps, p.slug);
    return withTenant(pool, { orgId: org.id }, async (q) => {
      await resolveLocation(q, org.id, p.loc);
      const rows = await q.many<{ id: string; type: string; label: string; help_text: string | null; options: unknown; required: boolean }>(
        `SELECT qn.id, qn.type, qn.label, qn.help_text, qn.options, qn.required FROM service_questions qn
           JOIN services s ON s.id = qn.service_id AND s.status = 'active' AND s.is_public
          WHERE qn.organization_id = $1 AND qn.service_id = $2 AND qn.status = 'active' ORDER BY qn.sort_order, qn.created_at`,
        [org.id, p.serviceId],
      );
      return { items: rows.map((r) => ({ id: r.id, type: r.type, label: r.label, helpText: r.help_text, options: r.options, required: r.required })) };
    });
  });

  app.get('/api/v1/public/orgs/:slug/locations/:loc/availability', async (req) => {
    await readLimit(req);
    const p = parse(z.object({ slug: z.string().max(60), loc: z.string().max(60) }), req.params);
    const qy = parse(
      z.object({ serviceId: zUuid, date: zDate, staffId: zUuid.optional(), partySize: z.coerce.number().int().min(1).max(50).default(1) }),
      req.query,
    );
    const org = await resolveOrg(deps, p.slug);
    return withTenant(pool, { orgId: org.id }, async (q) => {
      const loc = await resolveLocation(q, org.id, p.loc);
      const day = localDayRange(qy.date, loc.timezone);
      const input = await loadEngineInput(q, {
        orgId: org.id,
        locationId: loc.id,
        serviceId: qy.serviceId,
        from: day.start,
        to: day.end,
        now: clock.now(),
        mode: 'public',
        partySize: qy.partySize,
      });
      if (!input) throw notFound('サービス');
      const slots = listSlots(input, qy.date, input.service.requiresStaff ? (qy.staffId ?? 'auto') : 'auto');
      return {
        date: qy.date,
        timezone: loc.timezone,
        formToken: issueFormToken(config.SESSION_SECRET, org.id, clock.now()),
        // 公開側にはスタッフの内部IDと空き席数のみ(他の予約者の情報は出さない)
        slots: slots.map((s) => ({ startsAt: s.start, endsAt: s.end, seatsAvailable: input.service.capacity > 1 ? s.seatsAvailable : null })),
      };
    });
  });

  app.get('/api/v1/public/orgs/:slug/locations/:loc/availability/summary', async (req) => {
    await readLimit(req);
    const p = parse(z.object({ slug: z.string().max(60), loc: z.string().max(60) }), req.params);
    const qy = parse(
      z.object({ serviceId: zUuid, from: zDate, to: zDate, staffId: zUuid.optional(), partySize: z.coerce.number().int().min(1).max(50).default(1) }),
      req.query,
    );
    const span = daysBetween(qy.from, qy.to);
    if (span < 0 || span > 31) throw new AppError('VALIDATION_ERROR', '期間は31日以内で指定してください');
    const org = await resolveOrg(deps, p.slug);
    return withTenant(pool, { orgId: org.id }, async (q) => {
      const loc = await resolveLocation(q, org.id, p.loc);
      const input = await loadEngineInput(q, {
        orgId: org.id,
        locationId: loc.id,
        serviceId: qy.serviceId,
        from: localDayRange(qy.from, loc.timezone).start,
        to: localDayRange(qy.to, loc.timezone).end,
        now: clock.now(),
        mode: 'public',
        partySize: qy.partySize,
      });
      if (!input) throw notFound('サービス');
      const days: { date: string; available: number }[] = [];
      for (let i = 0; i <= span; i++) {
        const date = addDays(qy.from, i);
        days.push({ date, available: listSlots(input, date, input.service.requiresStaff ? (qy.staffId ?? 'auto') : 'auto').length });
      }
      return { days, today: todayIn(loc.timezone, clock.now()) };
    });
  });

  app.post('/api/v1/public/orgs/:slug/locations/:loc/bookings', async (req) => {
    const p = parse(z.object({ slug: z.string().max(60), loc: z.string().max(60) }), req.params);
    const now = clock.now();
    await enforceRateLimit(pool, `public-book:${ip(req)}`, Math.max(10, Math.ceil(config.PUBLIC_RATE_LIMIT_PER_MIN / 3)), 600, now);
    const body = parse(BookingBody, req.body);
    const org = await resolveOrg(deps, p.slug);
    if (body.website) throw new AppError('VALIDATION_ERROR', '送信内容を確認してください');
    if (!verifyFormToken(config.SESSION_SECRET, org.id, body.formToken, now)) {
      throw new AppError('VALIDATION_ERROR', '画面の有効期限が切れたか、送信が早すぎます。空き状況を表示し直してから予約してください。');
    }
    if (!(await verifyTurnstile(deps, body.turnstileToken, ip(req)))) throw new AppError('VALIDATION_ERROR', '確認に失敗しました。もう一度お試しください。');
    return withTenant(
      pool,
      { orgId: org.id },
      async (q) => {
        const loc = await resolveLocation(q, org.id, p.loc);
        const r = await createBooking(q, deps, org.id, { ...PUBLIC_ACTOR, requestId: req.id }, {
          locationId: loc.id,
          serviceId: body.serviceId,
          staffId: body.staffId,
          startsAt: new Date(body.startsAt),
          partySize: body.partySize,
          customer: body.customer,
          customerRequest: body.customerRequest,
          answers: body.answers,
          channel: 'public',
          idempotencyKey: `pub-${body.idempotencyKey}`,
        });
        return {
          ...publicBooking(r.booking, loc),
          created: r.created,
          manageUrl: `${config.APP_BASE_URL}/b/${r.manageToken}`,
          manageToken: r.manageToken,
        };
      },
      { lockTimeoutMs: 10000 },
    );
  });

  // ---- 予約管理リンク(トークン) ----
  async function resolveToken(req: FastifyRequest, token: string): Promise<{ orgId: string; bookingId: string }> {
    await enforceRateLimit(pool, `manage:${ip(req)}`, 30, 60, clock.now());
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound('予約');
    const row = await withSystem(pool, (q) =>
      q.maybeOne<{ id: string; organization_id: string; manage_token_expires_at: Date | null }>(
        'SELECT id, organization_id, manage_token_expires_at FROM bookings WHERE manage_token_hash = $1',
        [sha256(token)],
      ),
    );
    if (!row || !row.manage_token_expires_at || row.manage_token_expires_at <= clock.now()) {
      throw notFound('予約(リンクの有効期限が切れている可能性があります)');
    }
    return { orgId: row.organization_id, bookingId: row.id };
  }

  async function manageView(q: Q, orgId: string, bookingId: string) {
    const b = await q.one<BookingRow & { l_name: string; l_address: string | null; l_phone: string | null; cancel_deadline_hours: number; allow_customer_cancel: boolean; allow_customer_reschedule: boolean; org_slug: string; l_slug: string }>(
      `SELECT b.*, l.name AS l_name, l.address AS l_address, l.phone AS l_phone, l.cancel_deadline_hours, l.allow_customer_cancel,
              l.allow_customer_reschedule, o.slug AS org_slug, l.slug AS l_slug
         FROM bookings b JOIN locations l ON l.id = b.location_id JOIN organizations o ON o.id = b.organization_id
        WHERE b.organization_id = $1 AND b.id = $2`,
      [orgId, bookingId],
    );
    const deadline = new Date(b.starts_at.getTime() - b.cancel_deadline_hours * 3600_000);
    const beforeDeadline = clock.now() < deadline;
    const active = b.status === 'confirmed';
    return {
      booking: b,
      view: {
        ...publicBooking(b, { name: b.l_name, address: b.l_address, phone: b.l_phone }),
        organizationSlug: b.org_slug,
        locationSlug: b.l_slug,
        serviceId: b.service_id,
        staffSpecified: b.staff_selection === 'specified',
        cancelDeadline: deadline,
        canCancel: active && b.allow_customer_cancel && beforeDeadline,
        canReschedule: active && b.allow_customer_reschedule && beforeDeadline,
        deadlinePassed: active && !beforeDeadline,
      },
    };
  }

  app.get('/api/v1/public/manage/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const t = await resolveToken(req, token);
    return withTenant(pool, { orgId: t.orgId }, async (q) => (await manageView(q, t.orgId, t.bookingId)).view);
  });

  app.get('/api/v1/public/manage/:token/ics', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const t = await resolveToken(req, token);
    const ics = await withTenant(pool, { orgId: t.orgId }, async (q) => {
      const { booking, view } = await manageView(q, t.orgId, t.bookingId);
      return buildIcs({
        uid: `${booking.id}@servicehub`,
        start: booking.starts_at,
        end: booking.ends_at,
        summary: `${view.serviceName}(${view.locationName})`,
        location: [view.locationName, view.locationAddress].filter(Boolean).join(' '),
        description: `予約番号: ${booking.code}`,
        now: clock.now(),
        canceled: booking.status.startsWith('canceled'),
      });
    });
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="booking.ics"');
    return ics;
  });

  app.post('/api/v1/public/manage/:token/cancel', async (req) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const body = parse(z.object({ reason: zOptText(500) }), req.body ?? {});
    const t = await resolveToken(req, token);
    return withTenant(
      pool,
      { orgId: t.orgId },
      async (q) => {
        const { view } = await manageView(q, t.orgId, t.bookingId);
        if (!view.canCancel) {
          throw new AppError('INVALID_STATE', view.deadlinePassed ? 'キャンセル受付の締切を過ぎています。お手数ですが店舗へ直接ご連絡ください。' : 'この予約はWebからキャンセルできません。');
        }
        await cancelBooking(q, deps, t.orgId, { ...PUBLIC_ACTOR, requestId: req.id }, t.bookingId, { by: 'customer', reason: body.reason });
        return (await manageView(q, t.orgId, t.bookingId)).view;
      },
      { lockTimeoutMs: 10000 },
    );
  });

  app.get('/api/v1/public/manage/:token/availability', async (req) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const { date } = parse(z.object({ date: zDate }), req.query);
    const t = await resolveToken(req, token);
    return withTenant(pool, { orgId: t.orgId }, async (q) => {
      const { booking, view } = await manageView(q, t.orgId, t.bookingId);
      if (!view.canReschedule) throw new AppError('INVALID_STATE', 'この予約はWebから変更できません。');
      const tz = view.timezone;
      const day = localDayRange(date, tz);
      const input = await loadEngineInput(q, {
        orgId: t.orgId,
        locationId: booking.location_id,
        serviceId: booking.service_id,
        from: day.start,
        to: day.end,
        now: clock.now(),
        mode: 'public',
        partySize: booking.party_size,
      });
      if (!input) throw notFound('サービス');
      // 自分の席は空いているものとして計算
      input.occupancies = input.occupancies
        .map((o) => (o.id === booking.occupancy_id ? { ...o, seatsTaken: o.seatsTaken - booking.party_size } : o))
        .filter((o) => o.seatsTaken > 0);
      const staffChoice = input.service.requiresStaff ? (view.staffSpecified && booking.staff_id ? booking.staff_id : 'auto') : 'auto';
      const slots = listSlots(input, date, staffChoice);
      return { date, timezone: tz, slots: slots.map((s) => ({ startsAt: s.start, endsAt: s.end })), today: todayIn(tz, clock.now()), current: localDateOf(booking.starts_at, tz) };
    });
  });

  app.post('/api/v1/public/manage/:token/reschedule', async (req) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.params);
    const body = parse(z.object({ startsAt: zIso }), req.body);
    const t = await resolveToken(req, token);
    return withTenant(
      pool,
      { orgId: t.orgId },
      async (q) => {
        const { booking, view } = await manageView(q, t.orgId, t.bookingId);
        if (!view.canReschedule) throw new AppError('INVALID_STATE', view.deadlinePassed ? '変更受付の締切を過ぎています。店舗へご連絡ください。' : 'この予約はWebから変更できません。');
        await rescheduleBooking(q, deps, t.orgId, { ...PUBLIC_ACTOR, requestId: req.id }, t.bookingId, {
          startsAt: new Date(body.startsAt),
          staffId: view.staffSpecified ? booking.staff_id : null,
          expectedVersion: booking.version,
        });
        return (await manageView(q, t.orgId, t.bookingId)).view;
      },
      { lockTimeoutMs: 10000 },
    );
  });
}
