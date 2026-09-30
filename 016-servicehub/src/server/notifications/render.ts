/**
 * 通知本文の生成(送信時に最新データから生成する。本文はDBに保存しない)。
 * 予約管理URLのトークンは冪等キーから HMAC で再計算するため、送信箱にトークンを保存しない。
 */
import { formatDateTimeJa, localTimeOf } from '../../shared/time.js';
import type { Q } from '../db/tx.js';
import type { Deps } from '../deps.js';
import { manageTokenFor } from '../modules/bookings/service.js';

export interface NotificationRow {
  id: string;
  organization_id: string;
  type: string;
  recipient: string | null;
  customer_id: string | null;
  booking_id: string | null;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

export interface Rendered {
  to: string;
  subject: string;
  text: string;
  replyTo: string | null;
}

export type RenderResult = Rendered | { skip: string };

const FOOTER = '\n---\nこのメールは ServiceHub から自動送信されています。心当たりのない場合は破棄してください。';

interface BookingInfo {
  id: string;
  code: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  party_size: number;
  idempotency_key: string | null;
  service_snapshot: { name: string; notice?: string | null };
  location_snapshot: { name: string; timezone: string };
  staff_snapshot: { displayName: string } | null;
  contact_snapshot: { name?: string; email?: string | null };
  address: string | null;
  phone: string | null;
  cancel_deadline_hours: number;
}

async function loadBooking(q: Q, orgId: string, id: string): Promise<BookingInfo | null> {
  return q.maybeOne<BookingInfo>(
    `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.party_size, b.idempotency_key, b.service_snapshot, b.location_snapshot,
            b.staff_snapshot, b.contact_snapshot, l.address, l.phone, l.cancel_deadline_hours
       FROM bookings b JOIN locations l ON l.id = b.location_id
      WHERE b.organization_id = $1 AND b.id = $2`,
    [orgId, id],
  );
}

function bookingBlock(b: BookingInfo): string {
  const tz = b.location_snapshot.timezone;
  return [
    `予約番号: ${b.code}`,
    `日時: ${formatDateTimeJa(b.starts_at, tz)}〜${localTimeOf(b.ends_at, tz)}`,
    `サービス: ${b.service_snapshot.name}${b.party_size > 1 ? `(${b.party_size}名)` : ''}`,
    `担当: ${b.staff_snapshot?.displayName ?? 'おまかせ'}`,
    `場所: ${b.location_snapshot.name}${b.address ? ` ${b.address}` : ''}`,
  ].join('\n');
}

export async function renderNotification(q: Q, deps: Deps, n: NotificationRow, orgName: string, replyTo: string | null): Promise<RenderResult> {
  const base = deps.config.APP_BASE_URL;
  const to = n.recipient;
  if (!to) return { skip: 'no_recipient' };
  const p = n.payload ?? {};
  const bookingTypes = ['booking_confirmed', 'booking_changed', 'booking_canceled', 'booking_reminder'];
  if (bookingTypes.includes(n.type)) {
    if (!n.booking_id) return { skip: 'no_booking' };
    const b = await loadBooking(q, n.organization_id, n.booking_id);
    if (!b) return { skip: 'booking_not_found' };
    const tz = b.location_snapshot.timezone;
    const name = b.contact_snapshot?.name ?? 'お客様';
    const manageUrl = b.idempotency_key ? `${base}/b/${manageTokenFor(deps.config.SESSION_SECRET, n.organization_id, b.idempotency_key)}` : null;
    const contact = b.phone ? `お問い合わせ: ${b.location_snapshot.name} ${b.phone}` : '';
    if (n.type === 'booking_reminder') {
      if (b.status !== 'confirmed') return { skip: 'booking_not_active' };
      if (p.startsAt && new Date(p.startsAt).getTime() !== b.starts_at.getTime()) return { skip: 'booking_rescheduled' };
      return {
        to,
        replyTo,
        subject: `【${orgName}】ご予約のお知らせ(${formatDateTimeJa(b.starts_at, tz)})`,
        text: `${name} 様\n\nご予約の日時が近づいてまいりました。\n\n${bookingBlock(b)}\n\n${manageUrl ? `予約の確認・変更: ${manageUrl}\n` : ''}${contact}\n${FOOTER}`,
      };
    }
    if (n.type === 'booking_confirmed') {
      if (b.status.startsWith('canceled')) return { skip: 'booking_canceled' };
      return {
        to,
        replyTo,
        subject: `【${orgName}】ご予約を承りました(${formatDateTimeJa(b.starts_at, tz)})`,
        text:
          `${name} 様\n\n${orgName} ${b.location_snapshot.name} のご予約を承りました。\n\n${bookingBlock(b)}\n\n` +
          (manageUrl ? `ご予約の確認・変更・キャンセルはこちら:\n${manageUrl}\n(Webでの変更・キャンセルは開始の${b.cancel_deadline_hours}時間前まで)\n\n` : '') +
          (b.service_snapshot.notice ? `【ご注意】\n${b.service_snapshot.notice}\n\n` : '') +
          `${contact}\n${FOOTER}`,
      };
    }
    if (n.type === 'booking_changed') {
      const prev = p.previousStartsAt ? `変更前: ${formatDateTimeJa(p.previousStartsAt, tz)}\n` : '';
      return {
        to,
        replyTo,
        subject: `【${orgName}】ご予約の日時を変更しました(${formatDateTimeJa(b.starts_at, tz)})`,
        text: `${name} 様\n\nご予約の内容を変更しました。\n\n${prev}${bookingBlock(b)}\n\n${manageUrl ? `予約の確認: ${manageUrl}\n` : ''}${contact}\n${FOOTER}`,
      };
    }
    return {
      to,
      replyTo,
      subject: `【${orgName}】ご予約のキャンセルを承りました`,
      text: `${name} 様\n\n以下のご予約はキャンセルされました。\n\n${bookingBlock(b)}\n\n${contact}\n${FOOTER}`,
    };
  }
  if (n.type === 'waitlist_available') {
    return {
      to,
      replyTo,
      subject: `【${orgName}】ご希望の日時に空きが出ました`,
      text:
        `${p.customerName ?? 'お客様'} 様\n\nキャンセル待ちにご登録いただいた条件で空きが出ました。\n\n` +
        `日時: ${p.startsAtLabel}\nサービス: ${p.serviceName}\n場所: ${p.locationName}\n\n` +
        `ご予約はこちらから(先着順です。予約確定時点で空いている場合のみ予約できます):\n${p.url}\n${FOOTER}`,
    };
  }
  if (n.type === 'pass_expiring') {
    return {
      to,
      replyTo,
      subject: `【${orgName}】回数券の有効期限が近づいています`,
      text: `${p.customerName ?? 'お客様'} 様\n\nお持ちの回数券「${p.passName}」の有効期限が近づいています。\n\n残り回数: ${p.remaining}回\n有効期限: ${p.expiresOn}\n\nご予約はお早めにどうぞ。\n${FOOTER}`,
    };
  }
  if (n.type === 'plan_expiring') {
    return {
      to,
      replyTo,
      subject: `【${orgName}】ご利用プランの期間終了が近づいています`,
      text: `${p.customerName ?? 'お客様'} 様\n\nご利用中のプラン「${p.planName}」は ${p.endsOn} で終了予定です。\n継続のご希望は店舗までお知らせください。\n${FOOTER}`,
    };
  }
  if (n.type === 'member_invitation') {
    if (!p.url) return { skip: 'payload_scrubbed' };
    return {
      to,
      replyTo: null,
      subject: `【ServiceHub】${p.orgName ?? orgName} への招待`,
      text: `${p.inviter ?? '管理者'} さんから ${p.orgName ?? orgName} のメンバーとして招待されました。\n\n次のリンクから参加してください(7日間有効):\n${p.url}\n${FOOTER}`,
    };
  }
  if (n.type === 'password_reset') {
    if (!p.url) return { skip: 'payload_scrubbed' };
    return {
      to,
      replyTo: null,
      subject: '【ServiceHub】パスワード再設定のご案内',
      text: `パスワード再設定のリクエストを受け付けました。\n次のリンクから1時間以内に新しいパスワードを設定してください:\n${p.url}\n\n心当たりがない場合はこのメールを破棄してください。\n${FOOTER}`,
    };
  }
  return { skip: 'unknown_type' };
}
