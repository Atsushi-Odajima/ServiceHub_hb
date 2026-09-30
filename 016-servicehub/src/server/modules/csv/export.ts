import { toDateTime, localDayRange } from '../../../shared/time.js';
import { CHANNEL_LABELS } from '../../../shared/constants.js';
import type { Permission } from '../../../shared/permissions.js';
import { type AuthContext, can } from '../../auth/context.js';
import type { Q } from '../../db/tx.js';
import { customerVisibility } from '../customers/visibility.js';

export const EXPORT_KINDS = ['customers', 'bookings', 'cancellations', 'services', 'staff', 'pass-ledger', 'plan-ledger', 'records'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_PERMS: Record<ExportKind, Permission> = {
  customers: 'csv.export.customers',
  bookings: 'csv.export.bookings',
  cancellations: 'csv.export.bookings',
  services: 'csv.export.master',
  staff: 'csv.export.master',
  'pass-ledger': 'csv.export.ledger',
  'plan-ledger': 'csv.export.ledger',
  records: 'csv.export.ledger',
};

export const EXPORT_LABELS: Record<ExportKind, string> = {
  customers: '顧客',
  bookings: '予約',
  cancellations: 'キャンセル・無断欠席',
  services: 'サービス',
  staff: 'スタッフ',
  'pass-ledger': '回数券台帳',
  'plan-ledger': '利用プラン台帳',
  records: '実施履歴',
};

/** 期間指定が必要な種類 */
export const PERIOD_KINDS: ReadonlySet<ExportKind> = new Set(['bookings', 'cancellations', 'pass-ledger', 'plan-ledger', 'records']);

export interface ExportFilters {
  from?: string;
  to?: string;
  locationId?: string;
  status?: 'active' | 'all';
}

export interface ExportQuery {
  header: string[];
  sql: string;
  params: unknown[];
  row: (r: any) => unknown[];
}

function fmt(d: Date | string | null | undefined, tz: string): string | null {
  if (!d) return null;
  return toDateTime(d, tz).toFormat('yyyy-MM-dd HH:mm');
}

const STATUS_JA: Record<string, string> = {
  confirmed: '来店待ち',
  arrived: '来店済み',
  in_service: '対応中',
  completed: '完了',
  canceled_customer: 'キャンセル(顧客)',
  canceled_business: 'キャンセル(事業者)',
  no_show: '無断欠席',
  active: '有効',
  archived: 'アーカイブ',
  merged: '統合済み',
  anonymized: '匿名化済み',
  voided: '取消',
};

const REVIEW_JA: Record<string, string> = {
  pending: '確認待ち',
  consumed: '消化した',
  waived: '消化しない',
};

const ENTRY_JA: Record<string, string> = {
  grant: '付与',
  use: '利用',
  use_reversal: '取消戻し',
  manual_add: '手動追加',
  manual_subtract: '手動減算',
  expire: '失効',
  correction: '訂正',
  carryover_in: '繰越(受入)',
  carryover_out: '繰越(移出)',
};

/**
 * 種類ごとの出力定義(権限・拠点スコープ・顧客の可視性を反映)。
 * 列見出しは取込(顧客・サービス・スタッフ)と共通。
 */
export async function buildExport(q: Q, ctx: AuthContext, kind: ExportKind, f: ExportFilters, now: Date, scope: string[] | null): Promise<ExportQuery> {
  const tz = ctx.orgTimezone;
  const locFilter = f.locationId ? [f.locationId] : scope;
  const range = f.from && f.to ? { start: localDayRange(f.from, tz).start, end: localDayRange(f.to, tz).end } : null;
  switch (kind) {
    case 'customers': {
      const params: unknown[] = [ctx.orgId];
      const vis = await customerVisibility(q, ctx, 'c', params, now);
      params.push(f.status === 'all' ? ['active', 'archived', 'merged', 'anonymized'] : ['active', 'archived']);
      return {
        header: ['顧客ID', '氏名', 'フリガナ', 'メール', '電話', 'タグ', 'よく利用する拠点', 'メモ', '状態', '初回来店', '最終来店', '登録日時'],
        sql: `SELECT c.id, c.name, c.name_kana, c.email, c.phone, c.tags, l.name AS location_name, c.memo, c.status, c.first_visit_at, c.last_visit_at, c.created_at
                FROM customers c LEFT JOIN locations l ON l.id = c.preferred_location_id
               WHERE c.organization_id = $1 AND ${vis} AND c.status = ANY($${params.length}::text[])
               ORDER BY c.created_at, c.id`,
        params,
        row: (r) => [r.id, r.name, r.name_kana, r.email, r.phone, r.tags, r.location_name, r.memo, STATUS_JA[r.status] ?? r.status, fmt(r.first_visit_at, tz), fmt(r.last_visit_at, tz), fmt(r.created_at, tz)],
      };
    }
    case 'bookings':
      return {
        header: ['予約番号', '拠点', '開始', '終了', 'サービス', '担当', '顧客ID', '顧客名', '人数', '状態', '受付経路', '強制予約', 'キャンセル理由', '締切後キャンセル', '消化', '作成日時'],
        sql: `SELECT b.code, b.location_snapshot->>'name' AS location_name, coalesce(b.location_snapshot->>'timezone', $5) AS tz, b.starts_at, b.ends_at,
                     b.service_snapshot->>'name' AS service_name, b.staff_snapshot->>'displayName' AS staff_name, b.customer_id, c.name AS customer_name,
                     b.party_size, b.status, b.channel, b.forced, b.cancel_reason, b.cancel_late, b.consumption_kind, b.created_at
                FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
               WHERE b.organization_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND ($4::uuid[] IS NULL OR b.location_id = ANY($4::uuid[]))
               ORDER BY b.starts_at, b.id`,
        params: [ctx.orgId, range!.start, range!.end, locFilter, tz],
        row: (r) => [
          r.code,
          r.location_name,
          fmt(r.starts_at, r.tz),
          fmt(r.ends_at, r.tz),
          r.service_name,
          r.staff_name,
          r.customer_id,
          r.customer_name,
          r.party_size,
          STATUS_JA[r.status] ?? r.status,
          CHANNEL_LABELS[r.channel] ?? r.channel,
          r.forced,
          r.cancel_reason,
          r.cancel_late === null ? null : r.cancel_late,
          r.consumption_kind === 'pass' ? '回数券' : r.consumption_kind === 'plan' ? '利用プラン' : null,
          fmt(r.created_at, r.tz),
        ],
      };
    case 'cancellations':
      // キャンセル(顧客/事業者)と無断欠席。区分・理由・日時・操作者(予約の履歴から)・締切後か・回数券/プランの消化の確認
      return {
        header: ['予約番号', '拠点', '予約の開始', 'サービス', '担当', '顧客ID', '顧客名', '区分', '理由', '日時', '操作者', '締切後キャンセル', '回数券・プランの消化', '受付経路'],
        sql: `SELECT b.code, b.location_snapshot->>'name' AS location_name, coalesce(b.location_snapshot->>'timezone', $5) AS tz, b.starts_at,
                     b.service_snapshot->>'name' AS service_name, b.staff_snapshot->>'displayName' AS staff_name, b.customer_id, c.name AS customer_name,
                     b.status, b.cancel_reason, coalesce(b.canceled_at, b.no_show_at) AS happened_at, b.cancel_late, b.consumption_review, b.consumption_kind, b.channel,
                     ev.actor_type, ev.actor_label
                FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.organization_id = b.organization_id
                LEFT JOIN LATERAL (
                  SELECT e.actor_type, e.actor_label FROM booking_events e
                   WHERE e.organization_id = b.organization_id AND e.booking_id = b.id AND e.to_status = b.status
                   ORDER BY e.created_at DESC, e.id DESC LIMIT 1
                ) ev ON true
               WHERE b.organization_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND ($4::uuid[] IS NULL OR b.location_id = ANY($4::uuid[]))
                 AND b.status IN ('canceled_customer', 'canceled_business', 'no_show')
               ORDER BY b.starts_at, b.id`,
        params: [ctx.orgId, range!.start, range!.end, locFilter, tz],
        row: (r) => [
          r.code,
          r.location_name,
          fmt(r.starts_at, r.tz),
          r.service_name,
          r.staff_name,
          r.customer_id,
          r.customer_name,
          STATUS_JA[r.status] ?? r.status,
          r.cancel_reason,
          fmt(r.happened_at, r.tz),
          r.actor_type === 'customer' ? '顧客(予約管理ページ)' : r.actor_type === 'system' ? 'システム' : r.actor_label,
          r.cancel_late === null ? null : r.cancel_late,
          r.consumption_kind === 'pass' ? '回数券を消化' : r.consumption_kind === 'plan' ? '利用プランを消化' : r.consumption_review ? REVIEW_JA[r.consumption_review] : null,
          CHANNEL_LABELS[r.channel] ?? r.channel,
        ],
      };
    case 'services':
      return {
        header: ['サービスID', '名称', 'カテゴリ', '所要時間(分)', '準備時間(分)', '片付け時間(分)', '定員', '最大人数', '価格表示', '説明', '提供拠点', '担当スタッフ', '公開', '回数券可', 'プラン可', '状態'],
        sql: `SELECT s.*,
                     (SELECT string_agg(l.name, ';' ORDER BY l.sort_order, l.name) FROM service_locations sl JOIN locations l ON l.id = sl.location_id WHERE sl.service_id = s.id) AS locations,
                     (SELECT string_agg(st.display_name, ';' ORDER BY st.sort_order, st.display_name) FROM service_staff ss JOIN staff st ON st.id = ss.staff_id WHERE ss.service_id = s.id) AS staff_names
                FROM services s
               WHERE s.organization_id = $1 AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM service_locations x WHERE x.service_id = s.id AND x.location_id = ANY($2::uuid[])))
               ORDER BY s.sort_order, s.name, s.id`,
        params: [ctx.orgId, locFilter],
        row: (r) => [
          r.id,
          r.name,
          r.category,
          r.duration_min,
          r.buffer_before_min,
          r.buffer_after_min,
          r.capacity,
          r.max_party_size,
          r.price_label,
          r.description,
          r.locations,
          r.staff_names,
          r.is_public,
          r.pass_eligible,
          r.plan_eligible,
          STATUS_JA[r.status] ?? r.status,
        ],
      };
    case 'staff': {
      const contact = can(ctx, 'staff.contact.read');
      return {
        header: ['スタッフID', '表示名', '内部名', ...(contact ? ['メール', '電話'] : []), '所属拠点', '対応サービス', '予約受付', '公開プロフィール', '状態'],
        sql: `SELECT s.*,
                     (SELECT string_agg(l.name, ';' ORDER BY l.sort_order, l.name) FROM staff_locations sl JOIN locations l ON l.id = sl.location_id WHERE sl.staff_id = s.id) AS locations,
                     (SELECT string_agg(sv.name, ';' ORDER BY sv.sort_order, sv.name) FROM service_staff ss JOIN services sv ON sv.id = ss.service_id WHERE ss.staff_id = s.id) AS services
                FROM staff s
               WHERE s.organization_id = $1 AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM staff_locations x WHERE x.staff_id = s.id AND x.location_id = ANY($2::uuid[])))
               ORDER BY s.sort_order, s.display_name, s.id`,
        params: [ctx.orgId, locFilter],
        row: (r) => [
          r.id,
          r.display_name,
          r.internal_name,
          ...(contact ? [r.email, r.phone] : []),
          r.locations,
          r.services,
          r.accepts_bookings,
          r.public_profile,
          STATUS_JA[r.status] ?? r.status,
        ],
      };
    }
    case 'pass-ledger': {
      const params: unknown[] = [ctx.orgId, range!.start, range!.end];
      const vis = await customerVisibility(q, ctx, 'c', params, now);
      return {
        header: ['エントリID', '日時', '顧客ID', '顧客名', '回数券ID', '回数券', '種別', '増減', '処理後の残り', '予約番号', '理由', '操作者'],
        sql: `SELECT l.id, l.created_at, cp.customer_id, c.name AS customer_name, cp.id AS pass_id, cp.product_snapshot->>'name' AS pass_name, l.entry_type, l.delta,
                     l.balance_after, b.code, l.reason, l.actor_type, l.actor_label
                FROM pass_ledger_entries l JOIN customer_passes cp ON cp.id = l.customer_pass_id JOIN customers c ON c.id = cp.customer_id
                LEFT JOIN bookings b ON b.id = l.booking_id AND b.organization_id = l.organization_id
               WHERE l.organization_id = $1 AND l.created_at >= $2 AND l.created_at < $3 AND ${vis}
               ORDER BY l.created_at, l.id`,
        params,
        row: (r) => [r.id, fmt(r.created_at, tz), r.customer_id, r.customer_name, r.pass_id, r.pass_name, ENTRY_JA[r.entry_type] ?? r.entry_type, r.delta, r.balance_after, r.code, r.reason, r.actor_type === 'system' ? 'システム' : r.actor_label],
      };
    }
    case 'plan-ledger': {
      const params: unknown[] = [ctx.orgId, range!.start, range!.end];
      const vis = await customerVisibility(q, ctx, 'c', params, now);
      return {
        header: ['エントリID', '日時', '顧客ID', '顧客名', 'プランID', 'プラン', '期間開始', '期間終了', '種別', '増減', '処理後の残り', '予約番号', '理由', '操作者'],
        sql: `SELECT l.id, l.created_at, p.customer_id, c.name AS customer_name, p.id AS plan_id, p.product_snapshot->>'name' AS plan_name, pp.period_start, pp.period_end,
                     l.entry_type, l.delta, l.balance_after, b.code, l.reason, l.actor_type, l.actor_label
                FROM plan_ledger_entries l JOIN customer_plans p ON p.id = l.customer_plan_id JOIN customers c ON c.id = p.customer_id
                JOIN customer_plan_periods pp ON pp.id = l.customer_plan_period_id
                LEFT JOIN bookings b ON b.id = l.booking_id AND b.organization_id = l.organization_id
               WHERE l.organization_id = $1 AND l.created_at >= $2 AND l.created_at < $3 AND ${vis}
               ORDER BY l.created_at, l.id`,
        params,
        row: (r) => [
          r.id,
          fmt(r.created_at, tz),
          r.customer_id,
          r.customer_name,
          r.plan_id,
          r.plan_name,
          r.period_start,
          r.period_end,
          ENTRY_JA[r.entry_type] ?? r.entry_type,
          r.delta,
          r.balance_after,
          r.code,
          r.reason,
          r.actor_type === 'system' ? 'システム' : r.actor_label,
        ],
      };
    }
    case 'records': {
      const memos = can(ctx, 'record.read');
      return {
        header: ['実施記録ID', '実施日時', '拠点', '担当', '顧客ID', '顧客名', 'サービス', '所要時間(分)', '状態', 'お客様向けメモ', ...(memos ? ['内部メモ'] : []), '次回のおすすめ日', '次回予約番号'],
        sql: `SELECT r.id, r.performed_at, l.name AS location_name, l.timezone, st.display_name AS staff_name, r.customer_id, c.name AS customer_name,
                     r.service_snapshot->>'name' AS service_name, r.duration_min, r.status, r.customer_memo, r.internal_memo, r.next_recommended_on, nb.code AS next_code
                FROM service_records r JOIN customers c ON c.id = r.customer_id JOIN locations l ON l.id = r.location_id
                LEFT JOIN staff st ON st.id = r.staff_id LEFT JOIN bookings nb ON nb.id = r.next_booking_id AND nb.organization_id = r.organization_id
               WHERE r.organization_id = $1 AND r.performed_at >= $2 AND r.performed_at < $3 AND ($4::uuid[] IS NULL OR r.location_id = ANY($4::uuid[]))
               ORDER BY r.performed_at, r.id`,
        params: [ctx.orgId, range!.start, range!.end, locFilter],
        row: (r) => [
          r.id,
          fmt(r.performed_at, r.timezone),
          r.location_name,
          r.staff_name,
          r.customer_id,
          r.customer_name,
          r.service_name,
          r.duration_min,
          r.status === 'active' ? '有効' : '取消',
          r.customer_memo,
          ...(memos ? [r.internal_memo] : []),
          r.next_recommended_on,
          r.next_code,
        ],
      };
    }
  }
}
