/**
 * 通知本文の生成(送信時に最新データから生成する。本文はDBに保存しない)。
 * 予約管理URLのトークンは冪等キーから HMAC で再計算するため、送信箱にトークンを保存しない。
 */
import { NOTIFICATION_TYPE_LABELS, parseBookingPage } from '../../shared/constants.js';
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

const BASE_FOOTER = '\n---\nこのメールは ServiceHub から自動送信されています。心当たりのない場合は破棄してください。';

interface BookingInfo {
  id: string;
  code: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  party_size: number;
  idempotency_key: string | null;
  manage_token_nonce: number;
  manage_token_hash: string | null;
  channel: string;
  customer_request: string | null;
  booking_page: unknown;
  service_snapshot: { name: string; notice?: string | null };
  location_snapshot: { name: string; timezone: string };
  staff_snapshot: { displayName: string } | null;
  contact_snapshot: { name?: string; email?: string | null; phone?: string | null };
  address: string | null;
  phone: string | null;
  cancel_deadline_hours: number;
}

async function loadBooking(q: Q, orgId: string, id: string): Promise<BookingInfo | null> {
  return q.maybeOne<BookingInfo>(
    `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.party_size, b.idempotency_key, b.manage_token_nonce, b.manage_token_hash,
            b.channel, b.customer_request, b.service_snapshot, b.location_snapshot,
            b.staff_snapshot, b.contact_snapshot, l.address, l.phone, l.cancel_deadline_hours, l.booking_page
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

async function loadAnswers(q: Q, orgId: string, bookingId: string): Promise<string> {
  const rows = await q.many<{ question_snapshot: { label: string; options?: { id: string; label: string }[] }; answer: unknown }>(
    'SELECT question_snapshot, answer FROM booking_answers WHERE organization_id = $1 AND booking_id = $2 ORDER BY sort_order, id',
    [orgId, bookingId],
  );
  return rows.map((r) => `・${r.question_snapshot.label}: ${answerText(r.question_snapshot, r.answer)}`).join('\n');
}

/** 回答(JSON)を人が読める文字にする(選択肢IDは表示名に置き換える) */
export function answerText(snap: { options?: { id: string; label: string }[] }, v: unknown): string {
  const label = (x: unknown) => snap.options?.find((o) => o.id === x)?.label ?? String(x);
  if (v === null || v === undefined || v === '') return '(未回答)';
  if (Array.isArray(v)) return v.map(label).join('、') || '(未回答)';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  return label(v);
}

const CHANNEL_LABELS: Record<string, string> = { public: 'Web予約', staff: 'スタッフ登録', reception: '受付', waitlist: 'キャンセル待ち', import: '取込', restore: '復元' };

export async function renderNotification(
  q: Q,
  deps: Deps,
  n: NotificationRow,
  orgName: string,
  replyTo: string | null,
  signature = '',
): Promise<RenderResult> {
  const base = deps.config.APP_BASE_URL;
  const to = n.recipient;
  if (!to) return { skip: 'no_recipient' };
  const p = n.payload ?? {};
  const FOOTER = signature.trim() ? `\n${signature.trim()}\n${BASE_FOOTER}` : BASE_FOOTER;
  if (n.type.startsWith('owner_')) {
    if (!n.booking_id) return { skip: 'no_booking' };
    const b = await loadBooking(q, n.organization_id, n.booking_id);
    if (!b) return { skip: 'booking_not_found' };
    const tz = b.location_snapshot.timezone;
    const who = `お客様: ${b.contact_snapshot?.name ?? '(名前なし)'}${b.contact_snapshot?.phone ? ` / ${b.contact_snapshot.phone}` : ''}${b.contact_snapshot?.email ? ` / ${b.contact_snapshot.email}` : ''}`;
    const adminUrl = `${base}/app/bookings/${b.id}`;
    const title = NOTIFICATION_TYPE_LABELS[n.type]?.replace('店舗向け: ', '') ?? n.type;
    let lead = '';
    if (n.type === 'owner_booking_changed' && p.previousStartsAt) lead = `変更前: ${formatDateTimeJa(p.previousStartsAt, tz)}\n`;
    if (n.type === 'owner_booking_canceled') lead = `${p.late ? '※キャンセル締切後のキャンセルです\n' : ''}${p.reason ? `理由: ${p.reason}\n` : ''}`;
    if (n.type === 'owner_waitlist_opening') lead = `この予約のキャンセルで空いた枠に、キャンセル待ちの該当者が ${p.matches ?? 1} 件あります。\n待機の画面からお客様へご連絡ください。\n`;
    const answers = n.type === 'owner_booking_created' ? await loadAnswers(q, n.organization_id, b.id) : '';
    return {
      to,
      replyTo: null,
      subject: `【${orgName}】${title}(${formatDateTimeJa(b.starts_at, tz)} ${b.contact_snapshot?.name ?? ''})`,
      text:
        `${title}がありました。\n\n${lead}${bookingBlock(b)}\n${who}\n受付経路: ${CHANNEL_LABELS[b.channel] ?? b.channel}\n` +
        (b.customer_request ? `ご要望: ${b.customer_request}\n` : '') +
        (answers ? `\n事前質問の回答:\n${answers}\n` : '') +
        `\n予約の詳細: ${adminUrl}\n${BASE_FOOTER}`,
    };
  }
  const bookingTypes = ['booking_confirmed', 'booking_changed', 'booking_canceled', 'booking_reminder', 'booking_manage_link'];
  if (bookingTypes.includes(n.type)) {
    if (!n.booking_id) return { skip: 'no_booking' };
    const b = await loadBooking(q, n.organization_id, n.booking_id);
    if (!b) return { skip: 'booking_not_found' };
    const tz = b.location_snapshot.timezone;
    const name = b.contact_snapshot?.name ?? 'お客様';
    const page = parseBookingPage(b.booking_page);
    // 無効化されたリンクは載せない。再発行後は新しい nonce のリンクになる
    const manageUrl =
      b.idempotency_key && b.manage_token_hash
        ? `${base}/b/${manageTokenFor(deps.config.SESSION_SECRET, n.organization_id, b.idempotency_key, b.manage_token_nonce)}`
        : null;
    const contact = b.phone ? `お問い合わせ: ${b.location_snapshot.name} ${b.phone}` : '';
    const notes = page.notes.trim() ? `【ご案内】\n${page.notes.trim()}\n\n` : '';
    const changeHours = page.changeDeadlineHours ?? b.cancel_deadline_hours;
    const deadlineText =
      changeHours === b.cancel_deadline_hours
        ? `(Webでの変更・キャンセルは開始の${b.cancel_deadline_hours}時間前まで)`
        : `(Webでの日時変更は開始の${changeHours}時間前まで、キャンセルは${b.cancel_deadline_hours}時間前まで)`;
    if (n.type === 'booking_manage_link') {
      if (!manageUrl) return { skip: 'manage_link_revoked' };
      if (b.status.startsWith('canceled')) return { skip: 'booking_canceled' };
      return {
        to,
        replyTo,
        subject: `【${orgName}】ご予約の確認・変更用リンクのお知らせ`,
        text: `${name} 様\n\nご予約の確認・変更・キャンセル用のリンクをお送りします。以前お送りしたリンクは使えなくなりました。\n\n${bookingBlock(b)}\n\n${manageUrl}\n${deadlineText}\n\n${contact}\n${FOOTER}`,
      };
    }
    if (n.type === 'booking_reminder') {
      if (b.status !== 'confirmed') return { skip: 'booking_not_active' };
      if (p.startsAt && new Date(p.startsAt).getTime() !== b.starts_at.getTime()) return { skip: 'booking_rescheduled' };
      return {
        to,
        replyTo,
        subject: `【${orgName}】ご予約のお知らせ(${formatDateTimeJa(b.starts_at, tz)})`,
        text: `${name} 様\n\nご予約の日時が近づいてまいりました。\n\n${bookingBlock(b)}\n\n${notes}${manageUrl ? `予約の確認・変更: ${manageUrl}\n` : ''}${contact}\n${FOOTER}`,
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
          (manageUrl ? `ご予約の確認・変更・キャンセルはこちら:\n${manageUrl}\n${deadlineText}\n\n` : '') +
          (b.service_snapshot.notice ? `【ご注意】\n${b.service_snapshot.notice}\n\n` : '') +
          notes +
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
      text: `${p.inviter ?? '管理者'} さんから ${p.orgName ?? orgName} のメンバーとして招待されました。\n\n次のリンクから参加してください(7日間有効):\n${p.url}\n${BASE_FOOTER}`,
    };
  }
  if (n.type === 'password_reset') {
    if (!p.url) return { skip: 'payload_scrubbed' };
    return {
      to,
      replyTo: null,
      subject: '【ServiceHub】パスワード再設定のご案内',
      text: `パスワード再設定のリクエストを受け付けました。\n次のリンクから1時間以内に新しいパスワードを設定してください:\n${p.url}\n\n心当たりがない場合はこのメールを破棄してください。\n${BASE_FOOTER}`,
    };
  }
  return { skip: 'unknown_type' };
}
