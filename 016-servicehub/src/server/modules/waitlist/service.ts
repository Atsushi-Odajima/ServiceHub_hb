/**
 * 待機リスト(DATA_MODEL.md / NOTIFICATIONS.md)。
 * - 空きが出たら候補(waitlist_matches)を作るだけで、予約は自動確定しない
 * - 候補の通知は運営者の操作。通知時・予約時はその時点の空きで再判定する(先着順)
 * - 待機中の顧客が同じ拠点・サービスの予約をしたら、その待機は「予約済み」にする
 */
import { parseOrgSettings } from '../../../shared/constants.js';
import { addDays, daysBetween, formatDateTimeJa, localDateOf, localDayRange, localTimeOf, todayIn } from '../../../shared/time.js';
import { type Actor, writeAudit } from '../../audit.js';
import type { Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { listSlots } from '../../engine/availability.js';
import type { Slot } from '../../engine/types.js';
import { loadEngineInput } from '../../engine/loader.js';
import { AppError, invalidState, notFound } from '../../errors.js';
import { enqueueNotification } from '../../notifications/enqueue.js';

export const MAX_MATCHES_PER_ENTRY = 10;
export const MAX_RANGE_DAYS = 31;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface WaitlistEntryRow {
  id: string;
  organization_id: string;
  customer_id: string;
  location_id: string;
  service_id: string;
  staff_id: string | null;
  date_from: string;
  date_to: string;
  time_from: string | null;
  time_to: string | null;
  party_size: number;
  expires_at: Date;
  status: 'waiting' | 'notified' | 'booked' | 'expired' | 'canceled';
  note: string | null;
  source: 'public' | 'staff' | 'restore';
  notified_at: Date | null;
  booked_booking_id: string | null;
  matched_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
}

async function notifyWaitlistChange(q: Q, orgId: string, locationId: string, id: string): Promise<void> {
  await q.many('SELECT pg_notify($1, $2)', ['sh_events', JSON.stringify({ o: orgId, l: locationId, e: 'waitlist', i: id })]);
}

export interface CreateEntryInput {
  customerId: string;
  locationId: string;
  serviceId: string;
  staffId?: string | null;
  dateFrom: string;
  dateTo: string;
  timeFrom?: string | null;
  timeTo?: string | null;
  partySize: number;
  note?: string | null;
  source: 'public' | 'staff';
  createdBy?: string | null;
  requestId?: string;
}

export async function createWaitlistEntry(q: Q, deps: Deps, orgId: string, a: Actor, input: CreateEntryInput): Promise<{ id: string; created: boolean }> {
  const loc = await q.maybeOne<{ timezone: string; status: string; is_public: boolean; allow_public_waitlist: boolean; max_advance_days: number }>(
    'SELECT timezone, status, is_public, allow_public_waitlist, max_advance_days FROM locations WHERE organization_id = $1 AND id = $2',
    [orgId, input.locationId],
  );
  if (!loc || loc.status !== 'active') throw notFound('拠点');
  if (input.source === 'public' && (!loc.is_public || !loc.allow_public_waitlist)) throw notFound('キャンセル待ちの受付');
  const svc = await q.maybeOne<{ status: string; is_bookable: boolean; is_public: boolean; max_party_size: number; capacity: number; max_advance_days: number | null; requires_staff: boolean; at_loc: boolean }>(
    `SELECT s.status, s.is_bookable, s.is_public, s.max_party_size, s.capacity, s.max_advance_days, s.requires_staff,
            EXISTS (SELECT 1 FROM service_locations sl WHERE sl.service_id = s.id AND sl.location_id = $3) AS at_loc
       FROM services s WHERE s.organization_id = $1 AND s.id = $2`,
    [orgId, input.serviceId, input.locationId],
  );
  if (!svc || svc.status !== 'active' || !svc.is_bookable || !svc.at_loc || (input.source === 'public' && !svc.is_public)) throw notFound('サービス');
  if (input.partySize < 1 || input.partySize > Math.min(svc.max_party_size, svc.capacity)) {
    throw new AppError('VALIDATION_ERROR', '人数を確認してください', { fields: { partySize: `1〜${Math.min(svc.max_party_size, svc.capacity)}名で指定してください` } });
  }
  if (input.staffId) {
    if (!svc.requires_staff) throw new AppError('VALIDATION_ERROR', 'このサービスは担当者を指定できません');
    const st = await q.maybeOne(
      `SELECT 1 FROM staff s WHERE s.organization_id = $1 AND s.id = $2 AND s.status = 'active' AND s.accepts_bookings
          AND EXISTS (SELECT 1 FROM staff_locations x WHERE x.staff_id = s.id AND x.location_id = $3)
          AND EXISTS (SELECT 1 FROM service_staff y WHERE y.staff_id = s.id AND y.service_id = $4)`,
      [orgId, input.staffId, input.locationId, input.serviceId],
    );
    if (!st) throw new AppError('VALIDATION_ERROR', 'この担当者は指定できません', { fields: { staffId: '担当できないスタッフです' } });
  }
  const today = todayIn(loc.timezone, deps.clock.now());
  const maxDays = svc.max_advance_days ?? loc.max_advance_days;
  if (input.dateFrom < today) throw new AppError('VALIDATION_ERROR', '開始日は今日以降にしてください', { fields: { dateFrom: '今日以降にしてください' } });
  if (input.dateTo < input.dateFrom) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください', { fields: { dateTo: '開始日以降にしてください' } });
  if (daysBetween(input.dateFrom, input.dateTo) > MAX_RANGE_DAYS - 1) {
    throw new AppError('VALIDATION_ERROR', `希望期間は${MAX_RANGE_DAYS}日以内にしてください`, { fields: { dateTo: `${MAX_RANGE_DAYS}日以内にしてください` } });
  }
  if (input.dateTo > addDays(today, maxDays)) throw new AppError('VALIDATION_ERROR', `${maxDays}日先までの日付を指定してください`, { fields: { dateTo: '受付期間外です' } });
  if ((input.timeFrom && !input.timeTo) || (!input.timeFrom && input.timeTo)) throw new AppError('VALIDATION_ERROR', '希望時間帯は開始と終了の両方を指定してください');
  if (input.timeFrom && input.timeTo && input.timeTo <= input.timeFrom) throw new AppError('VALIDATION_ERROR', '希望時間帯の終了は開始より後にしてください', { fields: { timeTo: '開始より後にしてください' } });

  const same = await q.maybeOne<{ id: string }>(
    `SELECT id FROM waitlist_entries
      WHERE organization_id = $1 AND customer_id = $2 AND location_id = $3 AND service_id = $4 AND coalesce(staff_id, $5::uuid) = coalesce($6::uuid, $5::uuid)
        AND date_from = $7 AND date_to = $8 AND status IN ('waiting','notified')`,
    [orgId, input.customerId, input.locationId, input.serviceId, NIL_UUID, input.staffId ?? null, input.dateFrom, input.dateTo],
  );
  if (same) return { id: same.id, created: false };
  const active = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM waitlist_entries WHERE organization_id = $1 AND customer_id = $2 AND status IN ('waiting','notified')`, [
    orgId,
    input.customerId,
  ]);
  if (active.n >= 10) throw new AppError('VALIDATION_ERROR', 'キャンセル待ちの登録は1人10件までです');
  const expiresAt = localDayRange(input.dateTo, loc.timezone).end;
  const row = await q.one<{ id: string }>(
    `INSERT INTO waitlist_entries (organization_id, customer_id, location_id, service_id, staff_id, date_from, date_to, time_from, time_to,
                                   party_size, expires_at, note, source, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      orgId,
      input.customerId,
      input.locationId,
      input.serviceId,
      input.staffId ?? null,
      input.dateFrom,
      input.dateTo,
      input.timeFrom ?? null,
      input.timeTo ?? null,
      input.partySize,
      expiresAt,
      input.note ?? null,
      input.source,
      input.createdBy ?? null,
    ],
  );
  await writeAudit(q, orgId, a, {
    action: 'waitlist.created',
    targetType: 'waitlist_entry',
    targetId: row.id,
    locationId: input.locationId,
    after: { customerId: input.customerId, serviceId: input.serviceId, staffId: input.staffId ?? null, dateFrom: input.dateFrom, dateTo: input.dateTo, source: input.source },
    requestId: input.requestId,
  });
  // 登録時点で空きがある日も候補として出す(自動では予約しない)
  await refreshWaitlistMatches(q, deps, orgId, { entryIds: [row.id] });
  return { id: row.id, created: true };
}

function inWindow(slot: Slot, tz: string, from: string | null, to: string | null): boolean {
  if (!from || !to) return true;
  const hhmm = localTimeOf(slot.start, tz);
  return hhmm >= from.slice(0, 5) && hhmm < to.slice(0, 5);
}

/**
 * 候補の再計算。対象の待機ごとに、希望期間(今日以降・最大31日)の空きを予約エンジンで求め、
 * 希望時間帯・担当に合う枠を最大10件まで候補にする。空かなくなった候補は stale にする。
 * 公開予約できる拠点・サービスは公開予約と同じ条件(最短予約時間など)で判定する(お客様が自分で予約できる枠だけを候補にする)。
 */
export async function refreshWaitlistMatches(
  q: Q,
  deps: Deps,
  orgId: string,
  filter: { entryIds?: string[]; locationId?: string; date?: string; sourceBookingId?: string | null; staleBefore?: Date },
  limitEntries = 200,
): Promise<{ entries: number; newMatches: number }> {
  const now = deps.clock.now();
  const params: unknown[] = [orgId, now];
  const where = [`e.organization_id = $1`, `e.status IN ('waiting','notified')`, `e.expires_at > $2`];
  if (filter.entryIds) {
    params.push(filter.entryIds);
    where.push(`e.id = ANY($${params.length}::uuid[])`);
  }
  if (filter.locationId) {
    params.push(filter.locationId);
    where.push(`e.location_id = $${params.length}`);
  }
  if (filter.date) {
    params.push(filter.date);
    where.push(`e.date_from <= $${params.length}::date AND e.date_to >= $${params.length}::date`);
  }
  if (filter.staleBefore) {
    params.push(filter.staleBefore);
    where.push(`(e.matched_at IS NULL OR e.matched_at < $${params.length})`);
  }
  params.push(limitEntries);
  const entries = await q.many<WaitlistEntryRow & { tz: string; loc_public: boolean; svc_public: boolean }>(
    `SELECT e.*, l.timezone AS tz, l.is_public AS loc_public, s.is_public AS svc_public
       FROM waitlist_entries e JOIN locations l ON l.id = e.location_id JOIN services s ON s.id = e.service_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.matched_at NULLS FIRST, e.created_at LIMIT $${params.length}`,
    params,
  );
  let newMatches = 0;
  for (const e of entries) {
    const today = todayIn(e.tz, now);
    const from = filter.date ?? (e.date_from > today ? e.date_from : today);
    const to = filter.date ?? (e.date_to < addDays(from, MAX_RANGE_DAYS - 1) ? e.date_to : addDays(from, MAX_RANGE_DAYS - 1));
    if (to < from) continue;
    const range = { start: localDayRange(from, e.tz).start, end: localDayRange(to, e.tz).end };
    const mode = e.loc_public && e.svc_public ? 'public' : 'staff';
    const input = await loadEngineInput(q, { orgId, locationId: e.location_id, serviceId: e.service_id, from: range.start, to: range.end, now, mode, partySize: e.party_size });
    const found: Slot[] = [];
    if (input) {
      for (let d = from; d <= to && found.length < MAX_MATCHES_PER_ENTRY; d = addDays(d, 1)) {
        const slots = listSlots(input, d, input.service.requiresStaff ? (e.staff_id ?? 'auto') : 'auto');
        for (const s of slots) {
          if (found.length >= MAX_MATCHES_PER_ENTRY) break;
          if (s.start.getTime() <= now.getTime()) continue;
          if (!inWindow(s, e.tz, e.time_from, e.time_to)) continue;
          found.push(s);
        }
      }
    }
    for (const s of found) {
      const r = await q.maybeOne<{ inserted: boolean }>(
        `INSERT INTO waitlist_matches (organization_id, waitlist_entry_id, location_id, service_id, staff_id, starts_at, source_booking_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (waitlist_entry_id, starts_at, (COALESCE(staff_id, '${NIL_UUID}'::uuid)))
         DO UPDATE SET status = CASE WHEN waitlist_matches.status = 'stale' THEN 'open' ELSE waitlist_matches.status END
         RETURNING (xmax = 0) AS inserted`,
        [orgId, e.id, e.location_id, e.service_id, e.staff_id, s.start, filter.sourceBookingId ?? null],
      );
      if (r?.inserted) newMatches++;
    }
    // 再計算した範囲で空かなくなった候補・過ぎた候補は stale
    await q.exec(
      `UPDATE waitlist_matches SET status = 'stale'
        WHERE organization_id = $1 AND waitlist_entry_id = $2 AND status IN ('open','notified')
          AND (starts_at <= $3 OR (starts_at >= $4 AND starts_at < $5 AND NOT (starts_at = ANY($6::timestamptz[]))))`,
      [orgId, e.id, now, range.start, range.end, found.map((s) => s.start)],
    );
    await q.exec('UPDATE waitlist_entries SET matched_at = $3 WHERE organization_id = $1 AND id = $2', [orgId, e.id, now]);
    if (found.length > 0) await notifyWaitlistChange(q, orgId, e.location_id, e.id);
  }
  return { entries: entries.length, newMatches };
}

/**
 * キャンセル・無断欠席・日時変更・復元など、枠の空きが変わったときに呼ぶ(その日の待機だけ再計算)。
 * 失敗しても元の操作は取り消さない(SAVEPOINT)。
 * 件数が多い場合は定期ジョブが残りを処理する。
 */
export async function onAvailabilityChanged(q: Q, deps: Deps, orgId: string, p: { locationId: string; startsAt: Date; timezone: string; sourceBookingId?: string | null }): Promise<void> {
  await q.exec('SAVEPOINT waitlist_refresh');
  try {
    await refreshWaitlistMatches(q, deps, orgId, { locationId: p.locationId, date: localDateOf(p.startsAt, p.timezone), sourceBookingId: p.sourceBookingId ?? null }, 20);
    await q.exec('RELEASE SAVEPOINT waitlist_refresh');
  } catch (err) {
    await q.exec('ROLLBACK TO SAVEPOINT waitlist_refresh');
    deps.log.warn({ err: String((err as Error).message) }, 'waitlist refresh failed (will retry in scheduler)');
  }
}

/** 予約作成時: 待機からの予約(指定あり)または同じ顧客・拠点・サービスの待機を「予約済み」にする */
export async function closeWaitlistForBooking(
  q: Q,
  orgId: string,
  a: Actor,
  b: { id: string; customer_id: string; location_id: string; service_id: string; starts_at: Date; location_snapshot?: { timezone?: string } | null },
  waitlistEntryId?: string | null,
): Promise<void> {
  const tz = b.location_snapshot?.timezone ?? 'Asia/Tokyo';
  const date = localDateOf(b.starts_at, tz);
  let entries: { id: string }[];
  if (waitlistEntryId) {
    const e = await q.maybeOne<{ id: string; customer_id: string; location_id: string; service_id: string; status: string }>(
      'SELECT id, customer_id, location_id, service_id, status FROM waitlist_entries WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [orgId, waitlistEntryId],
    );
    if (!e) throw notFound('待機');
    if (e.customer_id !== b.customer_id || e.location_id !== b.location_id || e.service_id !== b.service_id) {
      throw new AppError('VALIDATION_ERROR', '待機の顧客・拠点・サービスと予約の内容が一致しません');
    }
    if (e.status !== 'waiting' && e.status !== 'notified') throw invalidState('この待機はすでに終了しています');
    entries = [e];
  } else {
    entries = await q.many<{ id: string }>(
      `SELECT id FROM waitlist_entries
        WHERE organization_id = $1 AND customer_id = $2 AND location_id = $3 AND service_id = $4 AND status IN ('waiting','notified')
          AND date_from <= $5::date AND date_to >= $5::date FOR UPDATE`,
      [orgId, b.customer_id, b.location_id, b.service_id, date],
    );
  }
  for (const e of entries) {
    await q.exec(`UPDATE waitlist_entries SET status = 'booked', booked_booking_id = $3 WHERE organization_id = $1 AND id = $2`, [orgId, e.id, b.id]);
    await q.exec(
      `UPDATE waitlist_matches SET status = CASE WHEN starts_at = $3 THEN 'booked' ELSE 'stale' END
        WHERE organization_id = $1 AND waitlist_entry_id = $2 AND status IN ('open','notified')`,
      [orgId, e.id, b.starts_at],
    );
    await writeAudit(q, orgId, a, { action: 'waitlist.booked', targetType: 'waitlist_entry', targetId: e.id, locationId: b.location_id, metadata: { bookingId: b.id, linkedBy: waitlistEntryId ? 'explicit' : 'same_customer' } });
    await notifyWaitlistChange(q, orgId, b.location_id, e.id);
  }
}

/** 候補の空きを今の状態で再判定(通知前)。空いていれば true */
async function stillAvailable(q: Q, deps: Deps, orgId: string, m: { location_id: string; service_id: string; staff_id: string | null; starts_at: Date; party_size: number; tz: string; mode: 'public' | 'staff' }): Promise<boolean> {
  const date = localDateOf(m.starts_at, m.tz);
  const day = localDayRange(date, m.tz);
  const input = await loadEngineInput(q, { orgId, locationId: m.location_id, serviceId: m.service_id, from: day.start, to: day.end, now: deps.clock.now(), mode: m.mode, partySize: m.party_size });
  if (!input) return false;
  const slots = listSlots(input, date, input.service.requiresStaff ? (m.staff_id ?? 'auto') : 'auto');
  return slots.some((s) => s.start.getTime() === m.starts_at.getTime());
}

/**
 * 候補を顧客へ知らせる(運営者の操作)。method=email は送信箱へ登録、manual は電話等で連絡済みとして記録のみ。
 * 通知前に空きを再判定し、埋まっていれば stale にして知らせない。予約は確定しない(お客様が先着順で予約する)。
 */
export async function notifyWaitlistMatch(
  q: Q,
  deps: Deps,
  orgId: string,
  a: Actor,
  matchId: string,
  method: 'email' | 'manual',
  requestId?: string,
): Promise<{ result: 'notified' | 'stale'; queued: boolean }> {
  const m = await q.maybeOne<{
    id: string;
    waitlist_entry_id: string;
    location_id: string;
    service_id: string;
    staff_id: string | null;
    starts_at: Date;
    status: string;
  }>('SELECT id, waitlist_entry_id, location_id, service_id, staff_id, starts_at, status FROM waitlist_matches WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, matchId]);
  if (!m) throw notFound('候補');
  const e = await q.one<WaitlistEntryRow & { tz: string; loc_slug: string; loc_name: string; loc_public: boolean; svc_public: boolean; svc_name: string; org_slug: string; c_name: string; c_email: string | null; settings: unknown }>(
    `SELECT e.*, l.timezone AS tz, l.slug AS loc_slug, l.name AS loc_name, l.is_public AS loc_public, s.is_public AS svc_public, s.name AS svc_name,
            o.slug AS org_slug, o.settings, c.name AS c_name, c.email AS c_email
       FROM waitlist_entries e JOIN locations l ON l.id = e.location_id JOIN services s ON s.id = e.service_id
       JOIN organizations o ON o.id = e.organization_id JOIN customers c ON c.id = e.customer_id
      WHERE e.organization_id = $1 AND e.id = $2 FOR UPDATE OF e`,
    [orgId, m.waitlist_entry_id],
  );
  if (e.status !== 'waiting' && e.status !== 'notified') throw invalidState('この待機はすでに終了しています');
  if (m.status !== 'open' && m.status !== 'notified') throw invalidState('この候補はすでに使えません');
  const mode = e.loc_public && e.svc_public ? 'public' : 'staff';
  if (m.starts_at.getTime() <= deps.clock.now().getTime() || !(await stillAvailable(q, deps, orgId, { ...m, party_size: e.party_size, tz: e.tz, mode }))) {
    await q.exec(`UPDATE waitlist_matches SET status = 'stale' WHERE organization_id = $1 AND id = $2`, [orgId, m.id]);
    return { result: 'stale', queued: false };
  }
  let queued = false;
  if (method === 'email') {
    if (!e.c_email) throw new AppError('VALIDATION_ERROR', 'この顧客にはメールアドレスが登録されていません。電話等で連絡し「連絡済みにする」を使ってください');
    if (!parseOrgSettings(e.settings).notifications.waitlistAvailable) throw new AppError('INVALID_STATE', '組織設定で「空き枠のお知らせ(待機)」がオフになっています');
    const date = localDateOf(m.starts_at, e.tz);
    const time = localTimeOf(m.starts_at, e.tz);
    const qs = new URLSearchParams({ service: m.service_id, date, time, ...(m.staff_id ? { staff: m.staff_id } : {}) });
    queued = await enqueueNotification(q, {
      orgId,
      type: 'waitlist_available',
      recipient: e.c_email,
      customerId: e.customer_id,
      locationId: e.location_id,
      idempotencyKey: `waitlist_available:${m.id}`,
      payload: {
        customerName: e.c_name,
        serviceName: e.svc_name,
        locationName: e.loc_name,
        startsAtLabel: formatDateTimeJa(m.starts_at, e.tz),
        url: `${deps.config.APP_BASE_URL}/p/${e.org_slug}/${e.loc_slug}?${qs.toString()}`,
      },
    });
  }
  const now = deps.clock.now();
  await q.exec(`UPDATE waitlist_matches SET status = 'notified', notified_at = $3 WHERE organization_id = $1 AND id = $2`, [orgId, m.id, now]);
  await q.exec(`UPDATE waitlist_entries SET status = 'notified', notified_at = $3 WHERE organization_id = $1 AND id = $2`, [orgId, e.id, now]);
  await writeAudit(q, orgId, a, {
    action: 'waitlist.notified',
    targetType: 'waitlist_entry',
    targetId: e.id,
    locationId: e.location_id,
    metadata: { matchId: m.id, method, startsAt: m.starts_at, queued },
    requestId,
  });
  await notifyWaitlistChange(q, orgId, e.location_id, e.id);
  return { result: 'notified', queued };
}

export async function cancelWaitlistEntry(q: Q, orgId: string, a: Actor, id: string, reason: string | null, requestId?: string): Promise<void> {
  const e = await q.maybeOne<{ status: string; location_id: string }>('SELECT status, location_id FROM waitlist_entries WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, id]);
  if (!e) throw notFound('待機');
  if (e.status !== 'waiting' && e.status !== 'notified') throw invalidState('この待機はすでに終了しています');
  await q.exec(`UPDATE waitlist_entries SET status = 'canceled', cancel_reason = $3 WHERE organization_id = $1 AND id = $2`, [orgId, id, reason]);
  await q.exec(`UPDATE waitlist_matches SET status = 'stale' WHERE organization_id = $1 AND waitlist_entry_id = $2 AND status IN ('open','notified')`, [orgId, id]);
  await writeAudit(q, orgId, a, { action: 'waitlist.canceled', targetType: 'waitlist_entry', targetId: id, locationId: e.location_id, metadata: { reason }, requestId });
  await notifyWaitlistChange(q, orgId, e.location_id, id);
}

/** 日次/定期ジョブ: 期限切れの待機を expired、過ぎた候補を stale にする */
export async function expireWaitlist(q: Q, orgId: string, now: Date): Promise<number> {
  const rows = await q.many<{ id: string }>(
    `UPDATE waitlist_entries SET status = 'expired'
      WHERE organization_id = $1 AND status IN ('waiting','notified') AND expires_at <= $2 RETURNING id`,
    [orgId, now],
  );
  await q.exec(`UPDATE waitlist_matches SET status = 'stale' WHERE organization_id = $1 AND status IN ('open','notified') AND starts_at <= $2`, [orgId, now]);
  if (rows.length > 0) {
    await q.exec(`UPDATE waitlist_matches SET status = 'stale' WHERE organization_id = $1 AND waitlist_entry_id = ANY($2::uuid[]) AND status IN ('open','notified')`, [
      orgId,
      rows.map((r) => r.id),
    ]);
  }
  return rows.length;
}
