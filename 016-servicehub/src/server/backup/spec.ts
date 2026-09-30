/**
 * 組織単位バックアップの対象表と復元順序。
 *
 * - 表は外部キーの親 → 子の順に並べる(復元はこの順に投入する)。新しい表を追加したら必ずここか
 *   EXCLUDED_TABLES のどちらかに加えること(tests/integration/backup-restore.test.ts が検査する)。
 * - 自己参照・循環参照の列は deferred に列挙し、いったん NULL で投入して全表の投入後に更新する。
 * - 台帳(回数券/利用プラン)は元の順序で1件ずつ再生し、残数はDBのトリガーで再計算する。
 *   残数列(remaining)は 0 で投入し、再生後にバックアップ時の値と一致することを照合する。
 */
export const BACKUP_FORMAT = 'servicehub-org-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_FILE_EXT = '.shbak';

export interface TableSpec {
  name: string;
  /** 抽出条件(既定: organization_id = $1)。$1 は組織ID */
  where?: string;
  /** 出力順・照合順(復元後の照合でも同じ順で読み直す) */
  orderBy: string;
  /** いったん NULL で投入し、最後に更新する列 */
  deferred?: readonly string[];
  /** 台帳: group ごとの残数チェーンを元の順序で再生する */
  ledger?: { group: string; parent: 'customer_passes' | 'customer_plan_periods' };
  /** 台帳からのみ変化する残数列(0 で投入 → 台帳再生後に照合) */
  balanceColumn?: string;
  /** 出力しない列(ログイン試行回数などの一時的な状態) */
  omit?: readonly string[];
}

export const BACKUP_TABLES: readonly TableSpec[] = [
  { name: 'organizations', where: 'id = $1', orderBy: 'id' },
  {
    name: 'users',
    where: 'id IN (SELECT user_id FROM memberships WHERE organization_id = $1)',
    orderBy: 'id',
    omit: ['failed_login_count', 'locked_until'],
  },
  { name: 'locations', orderBy: 'id' },
  { name: 'location_hours', orderBy: 'id' },
  { name: 'location_exceptions', orderBy: 'id' },
  { name: 'location_blocks', orderBy: 'id' },
  { name: 'staff', orderBy: 'id' },
  { name: 'staff_locations', orderBy: 'staff_id, location_id' },
  { name: 'memberships', orderBy: 'id' },
  { name: 'membership_locations', orderBy: 'membership_id, location_id' },
  { name: 'resources', orderBy: 'id' },
  { name: 'resource_hours', orderBy: 'id' },
  { name: 'resource_blocks', orderBy: 'id' },
  { name: 'services', orderBy: 'id' },
  { name: 'service_locations', orderBy: 'service_id, location_id' },
  { name: 'service_staff', orderBy: 'service_id, staff_id' },
  { name: 'service_resource_requirements', orderBy: 'id' },
  { name: 'service_resource_options', orderBy: 'requirement_id, resource_id' },
  { name: 'service_fixed_times', orderBy: 'id' },
  { name: 'service_questions', orderBy: 'id' },
  { name: 'shift_templates', orderBy: 'id' },
  { name: 'staff_shifts', orderBy: 'id' },
  { name: 'customers', orderBy: 'id', deferred: ['merged_into_id'] },
  { name: 'customer_merges', orderBy: 'id' },
  { name: 'customer_notes', orderBy: 'id' },
  { name: 'pass_products', orderBy: 'id' },
  { name: 'pass_product_services', orderBy: 'pass_product_id, service_id' },
  { name: 'plan_products', orderBy: 'id' },
  { name: 'plan_product_services', orderBy: 'plan_product_id, service_id' },
  { name: 'occupancies', orderBy: 'id' },
  { name: 'occupancy_resources', orderBy: 'id' },
  { name: 'waitlist_entries', orderBy: 'id', deferred: ['booked_booking_id'] },
  { name: 'bookings', orderBy: 'id', deferred: ['previous_booking_id'] },
  { name: 'booking_answers', orderBy: 'id' },
  { name: 'booking_events', orderBy: 'id' },
  { name: 'waitlist_matches', orderBy: 'id' },
  { name: 'service_records', orderBy: 'id' },
  { name: 'customer_passes', orderBy: 'id', balanceColumn: 'remaining' },
  { name: 'customer_plans', orderBy: 'id' },
  { name: 'customer_plan_periods', orderBy: 'id', balanceColumn: 'remaining' },
  {
    name: 'pass_ledger_entries',
    orderBy: 'created_at, customer_pass_id, id',
    ledger: { group: 'customer_pass_id', parent: 'customer_passes' },
  },
  {
    name: 'plan_ledger_entries',
    orderBy: 'created_at, customer_plan_period_id, id',
    ledger: { group: 'customer_plan_period_id', parent: 'customer_plan_periods' },
  },
  { name: 'notifications', orderBy: 'id' },
  { name: 'csv_imports', orderBy: 'id' },
  { name: 'audit_logs', orderBy: 'created_at, id' },
];

/** バックアップに含めない表と理由(画面・説明書にも表示する) */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  auth_sessions: 'ログイン中のセッション(復元後は全員が再ログイン)',
  invitations: '未使用の招待リンク(復元後に招待し直す)',
  password_reset_tokens: 'パスワード再設定リンク',
  rate_limit_buckets: 'アクセス回数制限の一時データ',
  job_runs: '定期処理の実行記録(組織に属さない)',
  schema_migrations: 'DB構造の版(バックアップの schemaVersion として記録)',
};

export function tableSpec(name: string): TableSpec | undefined {
  return BACKUP_TABLES.find((t) => t.name === name);
}

export function tableIndex(name: string): number {
  return BACKUP_TABLES.findIndex((t) => t.name === name);
}

/** 日本語の表示名(復元結果の表示用) */
export const TABLE_LABELS: Readonly<Record<string, string>> = {
  organizations: '組織',
  users: 'ログインユーザー',
  locations: '拠点',
  location_hours: '拠点の営業時間',
  location_exceptions: '拠点の臨時休業・特別営業',
  location_blocks: '拠点の受付停止',
  staff: 'スタッフ',
  staff_locations: 'スタッフの所属拠点',
  memberships: 'メンバーと権限',
  membership_locations: 'メンバーの担当拠点',
  resources: 'リソース',
  resource_hours: 'リソースの利用可能時間',
  resource_blocks: 'リソースの停止期間',
  services: 'サービス',
  service_locations: 'サービスの提供拠点',
  service_staff: 'サービスの担当スタッフ',
  service_resource_requirements: 'サービスの必要リソース',
  service_resource_options: '必要リソースの候補',
  service_fixed_times: 'サービスの開催時刻',
  service_questions: '事前質問',
  shift_templates: 'シフトテンプレート',
  staff_shifts: 'シフト',
  customers: '顧客',
  customer_merges: '顧客の統合履歴',
  customer_notes: '顧客メモ',
  pass_products: '回数券の種類',
  pass_product_services: '回数券の対象サービス',
  plan_products: '利用プランの種類',
  plan_product_services: '利用プランの対象サービス',
  occupancies: '予約枠の占有',
  occupancy_resources: '予約枠のリソース占有',
  waitlist_entries: '待機リスト',
  bookings: '予約',
  booking_answers: '事前質問の回答',
  booking_events: '予約の履歴',
  waitlist_matches: '待機の空き候補',
  service_records: '実施記録',
  customer_passes: '顧客の回数券',
  customer_plans: '顧客の利用プラン',
  customer_plan_periods: '利用プランの期間',
  pass_ledger_entries: '回数券台帳',
  plan_ledger_entries: '利用プラン台帳',
  notifications: '通知履歴',
  csv_imports: 'CSV取込履歴',
  audit_logs: '監査ログ',
};
