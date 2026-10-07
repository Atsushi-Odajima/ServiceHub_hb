/**
 * 予約の業務処理(作成・変更・キャンセル・状態遷移・復元)。
 * すべて呼び出し側のトランザクション内で実行し、履歴/監査/通知(outbox)/リアルタイム通知を同時に書く。
 */
import { parseOrgSettings, STATUS_TRANSITIONS, type BookingStatus, type QuestionType } from '../../../shared/constants.js';
import { localDateOf } from '../../../shared/time.js';
import { type Actor, writeAudit } from '../../audit.js';
import { bookingCode, hmac, sha256 } from '../../auth/crypto.js';
import { advisoryLockAll, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, invalidState, notFound, versionConflict } from '../../errors.js';
import { closeWaitlistForBooking, onAvailabilityChanged } from '../waitlist/service.js';
import { enqueueNotification } from '../../notifications/enqueue.js';
import { resolveCustomer, type NewCustomerInput } from '../customers/identity.js';
import { hasEligibleEntitlement } from '../entitlements/eligibility.js';
import { allocate, releaseSeats } from './allocate.js';

export interface BookingRow {
  id: string;
  organization_id: string;
  code: string;
  location_id: string;
  customer_id: string;
  service_id: string;
  staff_id: string | null;
  occupancy_id: string | null;
  starts_at: Date;
  ends_at: Date;
  party_size: number;
  status: BookingStatus;
  channel: string;
  staff_selection: string;
  service_snapshot: Record<string, any>;
  location_snapshot: Record<string, any>;
  staff_snapshot: Record<string, any> | null;
  contact_snapshot: Record<string, any>;
  customer_request: string | null;
  internal_note: string | null;
  idempotency_key: string | null;
  manage_token_expires_at: Date | null;
  manage_token_hash: string | null;
  manage_token_nonce: number;
  source_detail: SourceDetail | null;
  previous_booking_id: string | null;
  waitlist_entry_id: string | null;
  forced: boolean;
  force_reason: string | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  cancel_late: boolean | null;
  arrived_at: Date | null;
  service_started_at: Date | null;
  completed_at: Date | null;
  no_show_at: Date | null;
  consumption_kind: 'pass' | 'plan' | null;
  consumption_entry_id: string | null;
  consumption_review: 'pending' | 'consumed' | 'waived' | null;
  version: number;
  created_by_membership_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const SOURCE_DETAILS = ['phone', 'walk_in', 'dm', 'email', 'other'] as const;
export type SourceDetail = (typeof SOURCE_DETAILS)[number];

export interface BookingActor {
  actor: Actor;
  membershipId: string | null;
  mode: 'public' | 'staff';
  canForce: boolean;
  requestId?: string;
}

export interface AnswerInput {
  questionId: string;
  value: unknown;
}

export interface CreateBookingInput {
  locationId: string;
  serviceId: string;
  staffId: string | null; // null = おまかせ(スタッフ必須サービス) / スタッフ不要サービス
  startsAt: Date;
  partySize: number;
  customer: { customerId: string } | NewCustomerInput;
  customerRequest?: string | null;
  internalNote?: string | null;
  answers?: AnswerInput[];
  channel: 'public' | 'staff' | 'reception' | 'waitlist';
  force?: boolean;
  forceReason?: string | null;
  idempotencyKey: string;
  previousBookingId?: string | null;
  waitlistEntryId?: string | null;
  /** スタッフ登録時の受付経路(電話・来店・DM など) */
  sourceDetail?: SourceDetail | null;
}

/**
 * 管理トークンは冪等キーから決定的に生成(DBには SHA-256 のみ)。同じキーの再送で同じトークンを返せる。
 * nonce は再発行の回数。再発行すると nonce が上がり、以前のリンクは使えなくなる。
 */
export function manageTokenFor(secret: string, orgId: string, idempotencyKey: string, nonce = 0): string {
  return hmac(secret, nonce > 0 ? `manage:${orgId}:${idempotencyKey}:${nonce}` : `manage:${orgId}:${idempotencyKey}`);
}

const MANAGE_TOKEN_TTL_MS = 30 * 24 * 3600_000;

/** 店舗(運営者)宛ての通知を登録する。宛先: ownerNotifications.email → replyToEmail の順 */
export async function enqueueOwnerNotification(
  q: Q,
  orgId: string,
  type: 'owner_booking_created' | 'owner_booking_changed' | 'owner_booking_canceled' | 'owner_waitlist_opening',
  b: { id: string; location_id: string; customer_id: string },
  idempotencyKey: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  const st = parseOrgSettings(org.settings);
  const on =
    type === 'owner_booking_created'
      ? st.ownerNotifications.bookingCreated
      : type === 'owner_booking_changed'
        ? st.ownerNotifications.bookingChanged
        : type === 'owner_booking_canceled'
          ? st.ownerNotifications.bookingCanceled
          : st.ownerNotifications.waitlistOpening;
  const to = st.ownerNotifications.email ?? st.replyToEmail;
  if (!on || !to) return;
  await enqueueNotification(q, {
    orgId,
    type,
    recipient: to,
    customerId: b.customer_id,
    bookingId: b.id,
    locationId: b.location_id,
    idempotencyKey,
    payload: { bookingId: b.id, ...payload },
  });
}

/**
 * 予約管理リンクの再発行(以前のリンクは無効)/無効化。
 * 再発行したトークンは返り値でのみ渡す(DBにはハッシュのみ)。
 */
export async function reissueManageLink(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor,
  bookingId: string,
  input: { action: 'reissue' | 'revoke'; sendEmail: boolean },
): Promise<{ booking: BookingRow; manageToken: string | null; emailQueued: boolean }> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (!b.idempotency_key) throw invalidState('この予約には予約管理リンクがありません');
  const nonce = b.manage_token_nonce + 1;
  const token = manageTokenFor(deps.config.SESSION_SECRET, orgId, b.idempotency_key, nonce);
  const revoke = input.action === 'revoke';
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET manage_token_nonce = $3, manage_token_hash = $4, manage_token_expires_at = $5
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, bookingId, nonce, revoke ? null : sha256(token), revoke ? null : new Date(Math.max(b.ends_at.getTime(), deps.clock.now().getTime()) + MANAGE_TOKEN_TTL_MS)],
  );
  await addEvent(q, updated, a, revoke ? 'manage_link_revoked' : 'manage_link_reissued', null, null, { sendEmail: !revoke && input.sendEmail });
  await writeAudit(q, orgId, a.actor, {
    action: revoke ? 'booking.manage_link_revoked' : 'booking.manage_link_reissued',
    targetType: 'booking',
    targetId: bookingId,
    locationId: b.location_id,
    requestId: a.requestId,
  });
  let emailQueued = false;
  const email = (b.contact_snapshot?.email as string | undefined) ?? null;
  if (!revoke && input.sendEmail) {
    if (!email) throw new AppError('VALIDATION_ERROR', 'この予約にはメールアドレスがないため送信できません');
    emailQueued = await enqueueNotification(q, {
      orgId,
      type: 'booking_manage_link',
      recipient: email,
      customerId: b.customer_id,
      bookingId,
      locationId: b.location_id,
      idempotencyKey: `booking_manage_link:${bookingId}:n${nonce}`,
      payload: { bookingId },
    });
  }
  return { booking: updated, manageToken: revoke ? null : token, emailQueued };
}

export async function notifyChange(q: Q, orgId: string, locationId: string | null, entity: string, id: string): Promise<void> {
  await q.many('SELECT pg_notify($1, $2)', ['sh_events', JSON.stringify({ o: orgId, l: locationId, e: entity, i: id })]);
}

/** その拠点・日付に有効な待機があるときだけ候補を再計算する(通常の予約処理を重くしない) */
async function refreshWaitlistIfAny(q: Q, deps: Deps, orgId: string, b: { id: string; location_id: string; starts_at: Date; location_snapshot?: { timezone?: string } | null }): Promise<boolean> {
  const tz = (b.location_snapshot?.timezone as string | undefined) ?? 'Asia/Tokyo';
  const date = localDateOf(b.starts_at, tz);
  const any = await q.maybeOne(
    `SELECT 1 FROM waitlist_entries WHERE organization_id = $1 AND location_id = $2 AND status IN ('waiting','notified')
        AND date_from <= $3::date AND date_to >= $3::date LIMIT 1`,
    [orgId, b.location_id, date],
  );
  if (any) await onAvailabilityChanged(q, deps, orgId, { locationId: b.location_id, startsAt: b.starts_at, timezone: tz, sourceBookingId: b.id });
  return Boolean(any);
}

export async function loadBookingForUpdate(q: Q, orgId: string, id: string): Promise<BookingRow> {
  const b = await q.maybeOne<BookingRow>('SELECT * FROM bookings WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, id]);
  if (!b) throw notFound('予約');
  return b;
}

async function addEvent(q: Q, b: { id: string; organization_id: string; customer_id: string }, a: BookingActor, type: string, from: string | null, to: string | null, data: Record<string, unknown> = {}) {
  await q.exec(
    `INSERT INTO booking_events (organization_id, booking_id, customer_id, event_type, from_status, to_status, data, actor_type, actor_membership_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.organization_id, b.id, b.customer_id, type, from, to, JSON.stringify(data), a.actor.type, a.membershipId, a.actor.label ?? null],
  );
}

interface QuestionRow {
  id: string;
  type: QuestionType;
  label: string;
  help_text: string | null;
  options: { id: string; label: string }[];
  required: boolean;
  sort_order: number;
}

/** 事前質問の回答を検証し、質問/選択肢のスナップショット付きで返す */
export function validateAnswers(questions: QuestionRow[], answers: AnswerInput[]): { question: QuestionRow; value: unknown }[] {
  const byId = new Map(answers.map((a) => [a.questionId, a.value]));
  const out: { question: QuestionRow; value: unknown }[] = [];
  const errors: Record<string, string> = {};
  for (const qn of questions) {
    const raw = byId.get(qn.id);
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (qn.required) errors[`answers.${qn.id}`] = `「${qn.label}」は必須です`;
      continue;
    }
    let value: unknown = raw;
    switch (qn.type) {
      case 'short_text':
      case 'long_text': {
        const max = qn.type === 'short_text' ? 200 : 2000;
        if (typeof raw !== 'string' || raw.length > max) errors[`answers.${qn.id}`] = `「${qn.label}」は${max}文字以内で入力してください`;
        value = typeof raw === 'string' ? raw.trim() : raw;
        break;
      }
      case 'single_choice':
        if (typeof raw !== 'string' || !qn.options.some((o) => o.id === raw)) errors[`answers.${qn.id}`] = `「${qn.label}」の選択肢が正しくありません`;
        break;
      case 'multi_choice':
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !qn.options.some((o) => o.id === x))) {
          errors[`answers.${qn.id}`] = `「${qn.label}」の選択肢が正しくありません`;
        }
        value = Array.isArray(raw) ? [...new Set(raw)] : raw;
        break;
      case 'yes_no':
        if (typeof raw !== 'boolean') errors[`answers.${qn.id}`] = `「${qn.label}」ははい/いいえで回答してください`;
        break;
      case 'confirm':
        if (raw !== true) {
          if (qn.required) errors[`answers.${qn.id}`] = `「${qn.label}」への同意が必要です`;
          continue;
        }
        break;
    }
    out.push({ question: qn, value });
  }
  if (Object.keys(errors).length > 0) throw new AppError('VALIDATION_ERROR', '事前質問の回答を確認してください', { fields: errors });
  return out;
}

export async function createBooking(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor,
  input: CreateBookingInput,
): Promise<{ booking: BookingRow; created: boolean; manageToken: string }> {
  const now = deps.clock.now();
  let manageToken = manageTokenFor(deps.config.SESSION_SECRET, orgId, input.idempotencyKey);

  // 冪等: 同じキーの確定は1件だけ(再送・二重タップ)
  await advisoryLockAll(q, [`idem:${orgId}:${input.idempotencyKey}`]);
  const existing = await q.maybeOne<BookingRow>('SELECT * FROM bookings WHERE organization_id = $1 AND idempotency_key = $2', [
    orgId,
    input.idempotencyKey,
  ]);
  if (existing) {
    if (existing.manage_token_nonce > 0) manageToken = manageTokenFor(deps.config.SESSION_SECRET, orgId, input.idempotencyKey, existing.manage_token_nonce);
    return { booking: existing, created: false, manageToken };
  }

  if (input.force && !a.canForce) throw new AppError('FORBIDDEN', '強制予約の権限がありません');
  if (input.force && !input.forceReason) throw new AppError('VALIDATION_ERROR', '強制予約には理由の入力が必要です', { fields: { forceReason: '理由を入力してください' } });

  const svc = await q.maybeOne<{
    id: string;
    name: string;
    duration_min: number;
    buffer_before_min: number;
    buffer_after_min: number;
    price_label: string | null;
    capacity: number;
    category: string | null;
    notice: string | null;
    requires_staff: boolean;
  }>(
    `SELECT id, name, duration_min, buffer_before_min, buffer_after_min, price_label, capacity, category, notice, requires_staff
       FROM services WHERE organization_id = $1 AND id = $2`,
    [orgId, input.serviceId],
  );
  if (!svc) throw notFound('サービス');
  const loc = await q.maybeOne<{ id: string; name: string; timezone: string; slug: string }>(
    'SELECT id, name, timezone, slug FROM locations WHERE organization_id = $1 AND id = $2',
    [orgId, input.locationId],
  );
  if (!loc) throw notFound('拠点');

  // 事前質問(公開予約・スタッフ予約とも同じ検証。スタッフは任意項目の未回答を許容)。全サービス共通の質問を先に並べる
  const questions = await q.many<QuestionRow>(
    `SELECT id, type, label, help_text, options, required, sort_order FROM service_questions
      WHERE organization_id = $1 AND (service_id = $2 OR service_id IS NULL) AND status = 'active'
      ORDER BY (service_id IS NULL) DESC, sort_order, created_at`,
    [orgId, input.serviceId],
  );
  const answers = validateAnswers(
    a.mode === 'staff' ? questions.map((x) => ({ ...x, required: false })) : questions,
    input.answers ?? [],
  );

  const allocation = await allocate(q, {
    orgId,
    locationId: input.locationId,
    serviceId: input.serviceId,
    staffChoice: svc.requires_staff ? (input.staffId ?? 'auto') : null,
    start: input.startsAt,
    partySize: input.partySize,
    mode: a.mode,
    force: Boolean(input.force),
    now,
  });

  const customer = await resolveCustomer(q, orgId, input.customer, { source: a.mode === 'public' ? 'public' : 'staff', createdBy: a.membershipId });
  const staff = allocation.staffId
    ? await q.one<{ display_name: string }>('SELECT display_name FROM staff WHERE organization_id = $1 AND id = $2', [orgId, allocation.staffId])
    : null;

  let code = bookingCode();
  for (let i = 0; i < 5; i++) {
    const dup = await q.maybeOne('SELECT 1 FROM bookings WHERE organization_id = $1 AND code = $2', [orgId, code]);
    if (!dup) break;
    code = bookingCode();
  }
  const contact =
    'customerId' in input.customer
      ? { name: customer.row.name, email: customer.row.email, phone: customer.row.phone }
      : { name: input.customer.name, email: input.customer.email ?? null, phone: input.customer.phone ?? null };
  const forced = Boolean(input.force) && allocation.violationsOverridden.length > 0;

  const booking = await q.one<BookingRow>(
    `INSERT INTO bookings (organization_id, code, location_id, customer_id, service_id, staff_id, occupancy_id, starts_at, ends_at, party_size,
                           status, channel, staff_selection, service_snapshot, location_snapshot, staff_snapshot, contact_snapshot,
                           customer_request, internal_note, idempotency_key, manage_token_hash, manage_token_expires_at,
                           previous_booking_id, waitlist_entry_id, forced, force_reason, created_by_membership_id, source_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING *`,
    [
      orgId,
      code,
      input.locationId,
      customer.customerId,
      input.serviceId,
      allocation.staffId,
      allocation.occupancyId,
      allocation.start,
      allocation.end,
      input.partySize,
      input.channel,
      !svc.requires_staff ? 'none' : input.staffId ? 'specified' : 'auto',
      JSON.stringify({
        name: svc.name,
        durationMin: svc.duration_min,
        bufferBeforeMin: svc.buffer_before_min,
        bufferAfterMin: svc.buffer_after_min,
        priceLabel: svc.price_label,
        capacity: svc.capacity,
        category: svc.category,
        notice: svc.notice,
      }),
      JSON.stringify({ name: loc.name, timezone: loc.timezone, slug: loc.slug }),
      staff ? JSON.stringify({ displayName: staff.display_name }) : null,
      JSON.stringify(contact),
      input.customerRequest ?? null,
      input.internalNote ?? null,
      input.idempotencyKey,
      sha256(manageToken),
      new Date(allocation.end.getTime() + MANAGE_TOKEN_TTL_MS),
      input.previousBookingId ?? null,
      input.waitlistEntryId ?? null,
      forced,
      forced ? input.forceReason : null,
      a.membershipId,
      a.mode === 'staff' ? (input.sourceDetail ?? null) : null,
    ],
  );

  for (const [i, ans] of answers.entries()) {
    await q.exec(
      `INSERT INTO booking_answers (organization_id, booking_id, question_id, question_snapshot, answer, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        orgId,
        booking.id,
        ans.question.id,
        JSON.stringify({ label: ans.question.label, type: ans.question.type, options: ans.question.options, helpText: ans.question.help_text }),
        JSON.stringify(ans.value),
        i,
      ],
    );
  }

  // 待機からの予約(指定)または同じ顧客の同条件の待機を「予約済み」にし、他の待機の候補を更新
  await closeWaitlistForBooking(q, orgId, a.actor, booking, input.waitlistEntryId ?? null);
  await refreshWaitlistIfAny(q, deps, orgId, booking);

  await addEvent(q, booking, a, 'created', null, 'confirmed', {
    startsAt: booking.starts_at,
    staffId: booking.staff_id,
    channel: input.channel,
    forced,
  });
  await writeAudit(q, orgId, a.actor, {
    action: forced ? 'booking.force_created' : 'booking.created',
    targetType: 'booking',
    targetId: booking.id,
    locationId: booking.location_id,
    after: {
      code: booking.code,
      serviceId: booking.service_id,
      staffId: booking.staff_id,
      startsAt: booking.starts_at,
      partySize: booking.party_size,
      channel: booking.channel,
      customerCreated: customer.created,
    },
    metadata: forced ? { overridden: allocation.violationsOverridden.map((x) => x.code), reason: input.forceReason } : undefined,
    requestId: a.requestId,
  });
  if (input.previousBookingId) {
    const prev = await q.maybeOne<{ id: string; organization_id: string; customer_id: string }>(
      'SELECT id, organization_id, customer_id FROM bookings WHERE organization_id = $1 AND id = $2',
      [orgId, input.previousBookingId],
    );
    if (prev) {
      await addEvent(q, prev, a, 'next_booking_created', null, null, { nextBookingId: booking.id, startsAt: booking.starts_at });
      await q.exec(
        `UPDATE service_records SET next_booking_id = $3 WHERE organization_id = $1 AND booking_id = $2 AND status = 'active' AND next_booking_id IS NULL`,
        [orgId, prev.id, booking.id],
      );
    }
  }
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  if (parseOrgSettings(org.settings).notifications.bookingConfirmed) {
    await enqueueNotification(q, {
      orgId,
      type: 'booking_confirmed',
      recipient: contact.email,
      customerId: booking.customer_id,
      bookingId: booking.id,
      locationId: booking.location_id,
      idempotencyKey: `booking_confirmed:${booking.id}`,
      payload: { bookingId: booking.id },
    });
  }
  if (a.mode === 'public') {
    await enqueueOwnerNotification(q, orgId, 'owner_booking_created', booking, `owner_booking_created:${booking.id}`);
  }
  await notifyChange(q, orgId, booking.location_id, 'booking', booking.id);
  return { booking, created: true, manageToken };
}

export interface RescheduleInput {
  startsAt?: Date;
  staffId?: string | null;
  locationId?: string;
  partySize?: number;
  expectedVersion: number;
  force?: boolean;
  forceReason?: string | null;
}

/** 日時/担当/拠点/人数の変更。新しい枠が確保できなければ例外 → ロールバックで元の予約を維持 */
export async function rescheduleBooking(q: Q, deps: Deps, orgId: string, a: BookingActor, bookingId: string, input: RescheduleInput): Promise<BookingRow> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (b.version !== input.expectedVersion) throw versionConflict();
  if (b.status !== 'confirmed') throw invalidState('来店前(予約中)の予約のみ変更できます');
  if (input.force && !a.canForce) throw new AppError('FORBIDDEN', '強制予約の権限がありません');
  if (input.force && !input.forceReason) throw new AppError('VALIDATION_ERROR', '強制予約には理由の入力が必要です');
  const svc = await q.one<{ requires_staff: boolean }>('SELECT requires_staff FROM services WHERE organization_id = $1 AND id = $2', [orgId, b.service_id]);
  const newStart = input.startsAt ?? b.starts_at;
  const newLocation = input.locationId ?? b.location_id;
  const newParty = input.partySize ?? b.party_size;
  const staffChoice = !svc.requires_staff ? null : input.staffId === undefined ? b.staff_id : input.staffId;
  const allocation = await allocate(q, {
    orgId,
    locationId: newLocation,
    serviceId: b.service_id,
    staffChoice: staffChoice ?? (svc.requires_staff ? 'auto' : null),
    start: newStart,
    partySize: newParty,
    mode: a.mode,
    force: Boolean(input.force),
    now: deps.clock.now(),
    release: b.occupancy_id ? { occupancyId: b.occupancy_id, partySize: b.party_size } : null,
  });
  const staff = allocation.staffId
    ? await q.one<{ display_name: string }>('SELECT display_name FROM staff WHERE organization_id = $1 AND id = $2', [orgId, allocation.staffId])
    : null;
  const loc = await q.one<{ name: string; timezone: string; slug: string }>('SELECT name, timezone, slug FROM locations WHERE organization_id = $1 AND id = $2', [
    orgId,
    newLocation,
  ]);
  const forced = Boolean(input.force) && allocation.violationsOverridden.length > 0;
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET starts_at = $3, ends_at = $4, staff_id = $5, occupancy_id = $6, location_id = $7, party_size = $8,
            staff_snapshot = $9, location_snapshot = $10, forced = forced OR $11, force_reason = CASE WHEN $11 THEN $12 ELSE force_reason END,
            manage_token_expires_at = CASE WHEN manage_token_hash IS NULL THEN manage_token_expires_at ELSE $13 END, version = version + 1
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [
      orgId,
      bookingId,
      allocation.start,
      allocation.end,
      allocation.staffId,
      allocation.occupancyId,
      newLocation,
      newParty,
      staff ? JSON.stringify({ displayName: staff.display_name }) : null,
      JSON.stringify({ name: loc.name, timezone: loc.timezone, slug: loc.slug }),
      forced,
      input.forceReason ?? null,
      new Date(allocation.end.getTime() + MANAGE_TOKEN_TTL_MS),
    ],
  );
  await addEvent(q, updated, a, 'rescheduled', b.status, updated.status, {
    from: { startsAt: b.starts_at, staffId: b.staff_id, locationId: b.location_id },
    to: { startsAt: updated.starts_at, staffId: updated.staff_id, locationId: updated.location_id },
  });
  await writeAudit(q, orgId, a.actor, {
    action: forced ? 'booking.force_rescheduled' : 'booking.rescheduled',
    targetType: 'booking',
    targetId: bookingId,
    locationId: updated.location_id,
    before: { startsAt: b.starts_at, staffId: b.staff_id, locationId: b.location_id, partySize: b.party_size },
    after: { startsAt: updated.starts_at, staffId: updated.staff_id, locationId: updated.location_id, partySize: updated.party_size },
    metadata: forced ? { overridden: allocation.violationsOverridden.map((x) => x.code), reason: input.forceReason } : undefined,
    requestId: a.requestId,
  });
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  if (parseOrgSettings(org.settings).notifications.bookingChanged && updated.starts_at.getTime() !== b.starts_at.getTime()) {
    await enqueueNotification(q, {
      orgId,
      type: 'booking_changed',
      recipient: (b.contact_snapshot?.email as string | undefined) ?? null,
      customerId: b.customer_id,
      bookingId,
      locationId: updated.location_id,
      idempotencyKey: `booking_changed:${bookingId}:v${updated.version}`,
      payload: { bookingId, previousStartsAt: b.starts_at },
    });
  }
  if (a.mode === 'public' && updated.starts_at.getTime() !== b.starts_at.getTime()) {
    await enqueueOwnerNotification(q, orgId, 'owner_booking_changed', updated, `owner_booking_changed:${bookingId}:v${updated.version}`, {
      previousStartsAt: b.starts_at,
    });
  }
  await refreshWaitlistIfAny(q, deps, orgId, b);
  await refreshWaitlistIfAny(q, deps, orgId, updated);
  await notifyChange(q, orgId, updated.location_id, 'booking', bookingId);
  if (b.location_id !== updated.location_id) await notifyChange(q, orgId, b.location_id, 'booking', bookingId);
  return updated;
}

/** 締切後/無断欠席の消化確認フラグ(自動では消化しない) */
async function reviewFlagIfNeeded(q: Q, orgId: string, b: BookingRow): Promise<'pending' | null> {
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  if (parseOrgSettings(org.settings).lateCancelPolicy !== 'confirm') return null;
  const tz = (b.location_snapshot?.timezone as string) ?? 'Asia/Tokyo';
  return (await hasEligibleEntitlement(q, orgId, b.customer_id, b.service_id, localDateOf(b.starts_at, tz))) ? 'pending' : null;
}

export async function cancelBooking(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor,
  bookingId: string,
  input: { by: 'customer' | 'business'; reason?: string | null; expectedVersion?: number },
): Promise<BookingRow> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (input.expectedVersion !== undefined && b.version !== input.expectedVersion) throw versionConflict();
  if (b.status !== 'confirmed' && b.status !== 'arrived') throw invalidState('この予約はキャンセルできる状態ではありません');
  const now = deps.clock.now();
  const loc = await q.one<{ cancel_deadline_hours: number }>('SELECT cancel_deadline_hours FROM locations WHERE organization_id = $1 AND id = $2', [
    orgId,
    b.location_id,
  ]);
  const late = now.getTime() > b.starts_at.getTime() - loc.cancel_deadline_hours * 3600_000;
  if (b.occupancy_id) await releaseSeats(q, orgId, b.occupancy_id, b.party_size);
  const to: BookingStatus = input.by === 'customer' ? 'canceled_customer' : 'canceled_business';
  const review = input.by === 'customer' && late ? await reviewFlagIfNeeded(q, orgId, b) : null;
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET status = $3, canceled_at = $4, cancel_reason = $5, cancel_late = $6, consumption_review = $7, version = version + 1
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, bookingId, to, now, input.reason ?? null, late, review],
  );
  await addEvent(q, updated, a, 'canceled', b.status, to, { by: input.by, late });
  await writeAudit(q, orgId, a.actor, {
    action: 'booking.canceled',
    targetType: 'booking',
    targetId: bookingId,
    locationId: b.location_id,
    before: { status: b.status },
    after: { status: to, late },
    metadata: { by: input.by, reason: input.reason ?? null, consumptionReview: review },
    requestId: a.requestId,
  });
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  if (parseOrgSettings(org.settings).notifications.bookingCanceled) {
    await enqueueNotification(q, {
      orgId,
      type: 'booking_canceled',
      recipient: (b.contact_snapshot?.email as string | undefined) ?? null,
      customerId: b.customer_id,
      bookingId,
      locationId: b.location_id,
      idempotencyKey: `booking_canceled:${bookingId}`,
      payload: { bookingId, by: input.by },
    });
  }
  if (input.by === 'customer' && a.mode === 'public') {
    await enqueueOwnerNotification(q, orgId, 'owner_booking_canceled', updated, `owner_booking_canceled:${bookingId}`, { late, reason: input.reason ?? null });
  }
  const hasWaitlist = await refreshWaitlistIfAny(q, deps, orgId, updated);
  // 空いた枠に合うキャンセル待ちがいれば店舗へ知らせる(お客様への連絡は店舗が待機画面から行う)
  const matches = hasWaitlist
    ? await q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM waitlist_matches WHERE organization_id = $1 AND source_booking_id = $2 AND status = 'open'`,
        [orgId, bookingId],
      )
    : { n: 0 };
  if (matches.n > 0) {
    await enqueueOwnerNotification(q, orgId, 'owner_waitlist_opening', updated, `owner_waitlist_opening:${bookingId}`, { matches: matches.n });
  }
  await notifyChange(q, orgId, b.location_id, 'booking', bookingId);
  return updated;
}

/** 来店/対応中/無断欠席/取消(来店前へ戻す)などの状態遷移。完了は records モジュール */
export async function changeStatus(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor,
  bookingId: string,
  to: Exclude<BookingStatus, 'completed' | 'canceled_customer' | 'canceled_business'>,
  expectedVersion?: number,
): Promise<BookingRow> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (expectedVersion !== undefined && b.version !== expectedVersion) throw versionConflict();
  if (b.status === to) return b;
  if (!STATUS_TRANSITIONS[b.status].includes(to)) {
    throw invalidState(`現在の状態(${b.status})からは変更できません`);
  }
  const now = deps.clock.now();
  const sets: string[] = ['status = $3', 'version = version + 1'];
  const params: unknown[] = [orgId, bookingId, to];
  if (to === 'arrived') {
    params.push(b.status === 'in_service' ? b.arrived_at : now);
    sets.push(`arrived_at = $${params.length}`);
    if (b.status === 'in_service') sets.push('service_started_at = NULL');
  } else if (to === 'in_service') {
    params.push(now);
    sets.push(`service_started_at = $${params.length}`, 'arrived_at = coalesce(arrived_at, service_started_at)');
  } else if (to === 'confirmed') {
    sets.push('arrived_at = NULL');
  } else if (to === 'no_show') {
    params.push(now);
    sets.push(`no_show_at = $${params.length}`);
    if (b.occupancy_id) await releaseSeats(q, orgId, b.occupancy_id, b.party_size);
    const review = await reviewFlagIfNeeded(q, orgId, b);
    params.push(review);
    sets.push(`consumption_review = $${params.length}`);
  }
  const updated = await q.one<BookingRow>(`UPDATE bookings SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`, params);
  const eventType = to === 'arrived' ? (b.status === 'in_service' ? 'status_reverted' : 'arrived') : to === 'confirmed' ? 'status_reverted' : to;
  await addEvent(q, updated, a, eventType, b.status, to);
  await writeAudit(q, orgId, a.actor, {
    action: `booking.status_${to}`,
    targetType: 'booking',
    targetId: bookingId,
    locationId: b.location_id,
    before: { status: b.status },
    after: { status: to },
    requestId: a.requestId,
  });
  if (to === 'no_show') await refreshWaitlistIfAny(q, deps, orgId, updated);
  await notifyChange(q, orgId, b.location_id, 'booking', bookingId);
  return updated;
}

/** キャンセル/無断欠席の取り消し(同じ時刻の枠を再確保できた場合のみ) */
export async function restoreBooking(q: Q, deps: Deps, orgId: string, a: BookingActor, bookingId: string, input: { force?: boolean; forceReason?: string | null }): Promise<BookingRow> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (!['canceled_customer', 'canceled_business', 'no_show'].includes(b.status)) throw invalidState('キャンセル/無断欠席の予約のみ復元できます');
  if (b.consumption_entry_id) throw invalidState('回数券/プランの消化があるため復元できません。先に消化を取り消してください');
  const svc = await q.one<{ requires_staff: boolean }>('SELECT requires_staff FROM services WHERE organization_id = $1 AND id = $2', [orgId, b.service_id]);
  const allocation = await allocate(q, {
    orgId,
    locationId: b.location_id,
    serviceId: b.service_id,
    staffChoice: svc.requires_staff ? (b.staff_id ?? 'auto') : null,
    start: b.starts_at,
    partySize: b.party_size,
    mode: 'staff',
    force: Boolean(input.force) && a.canForce,
    now: deps.clock.now(),
  });
  const to: BookingStatus = b.status === 'no_show' ? 'arrived' : 'confirmed';
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET status = $3, occupancy_id = $4, staff_id = $5, canceled_at = NULL, cancel_reason = NULL, cancel_late = NULL,
            no_show_at = NULL, consumption_review = NULL, arrived_at = CASE WHEN $3 = 'arrived' THEN coalesce(arrived_at, $6) ELSE arrived_at END,
            version = version + 1
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, bookingId, to, allocation.occupancyId, allocation.staffId, deps.clock.now()],
  );
  await refreshWaitlistIfAny(q, deps, orgId, updated);
  await addEvent(q, updated, a, 'restored', b.status, to);
  await writeAudit(q, orgId, a.actor, {
    action: 'booking.restored',
    targetType: 'booking',
    targetId: bookingId,
    locationId: b.location_id,
    before: { status: b.status },
    after: { status: to },
    metadata: input.force ? { forceReason: input.forceReason } : undefined,
    requestId: a.requestId,
  });
  await notifyChange(q, orgId, b.location_id, 'booking', bookingId);
  return updated;
}
