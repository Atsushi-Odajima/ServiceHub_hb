/**
 * RBAC 定義(サーバー/クライアント共通)。
 * - 権限はロールに付与する。将来はロール定義をDB化して組織ごとに調整できるよう、判定は必ず can() 経由で行う。
 * - 拠点スコープ: owner は全拠点。その他は membership_locations(または all_locations=true)。
 * - ".own" 権限は「自分が担当スタッフの予約/顧客」に限定される。
 * UI の表示制御は補助であり、最終判定は必ずサーバー側で行う。
 */

export const ROLES = ['owner', 'manager', 'staff', 'reception'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'オーナー',
  manager: 'マネージャー',
  staff: 'スタッフ',
  reception: '受付',
};

export const PERMISSIONS = [
  // 組織・設定
  'org.manage', // 組織設定・通知設定・キャンセル規則・移動時間
  'member.manage', // メンバー招待・ロール/拠点変更・無効化
  'location.manage', // 拠点の作成/編集/アーカイブ・予約ページ
  'location.schedule.manage', // 拠点の臨時休業/特別営業/予約ブロック(自拠点)
  'service.manage', // サービス・事前質問・必要リソース
  'resource.manage', // リソース・メンテナンス停止(自拠点)
  'staff.manage', // スタッフプロフィール・所属拠点・対応サービス・アーカイブ
  'staff.contact.read', // スタッフ連絡先の閲覧
  'shift.manage', // シフト作成/編集/テンプレート生成(自拠点)
  'shift.read.all', // 自拠点スタッフのシフト閲覧
  'shift.read.own', // 自分のシフト閲覧
  // 予約
  'booking.read.all',
  'booking.read.own',
  'booking.create.all',
  'booking.create.own',
  'booking.update.all',
  'booking.update.own',
  'booking.cancel.all',
  'booking.cancel.own',
  'booking.status.all', // 来店/対応中/完了/無断欠席
  'booking.status.own',
  'booking.force', // soft 制約の上書き(理由必須)
  'booking.restore', // キャンセル/無断欠席の取り消し
  'booking.internal_note', // 予約の内部メモ閲覧/編集
  'reception.operate', // 受付モード
  // 顧客
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.note.general',
  'customer.note.confidential', // 機密メモ(受付は不可)
  'customer.merge',
  'customer.archive',
  'customer.anonymize',
  'customer.export',
  // 実施記録
  'record.read', // 内部メモを含む
  'record.write.all',
  'record.write.own',
  'record.void',
  // 回数券・利用プラン
  'pass.product.manage',
  'pass.read',
  'pass.grant',
  'pass.consume',
  'pass.reverse',
  'pass.adjust',
  'plan.product.manage',
  'plan.read',
  'plan.assign',
  'plan.consume',
  'plan.reverse',
  'plan.adjust',
  // 待機
  'waitlist.read',
  'waitlist.manage',
  // 分析・運用
  'dashboard.operations', // 拠点全体の運営ダッシュボード
  'kpi.read', // 経営/運営KPI
  'audit.read',
  'notification.read',
  'notification.retry',
  'csv.export.customers',
  'csv.export.bookings',
  'csv.export.master', // サービス/スタッフ
  'csv.export.ledger', // 回数券台帳/利用プラン/実施履歴
  'csv.import',
  'backup.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const MANAGER: readonly Permission[] = [
  'location.schedule.manage',
  'resource.manage',
  'staff.contact.read',
  'shift.manage',
  'shift.read.all',
  'shift.read.own',
  'booking.read.all',
  'booking.create.all',
  'booking.update.all',
  'booking.cancel.all',
  'booking.status.all',
  'booking.force',
  'booking.restore',
  'booking.internal_note',
  'reception.operate',
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.note.general',
  'customer.note.confidential',
  'customer.merge',
  'customer.archive',
  'customer.export',
  'record.read',
  'record.write.all',
  'record.void',
  'pass.read',
  'pass.grant',
  'pass.consume',
  'pass.reverse',
  'pass.adjust',
  'plan.read',
  'plan.assign',
  'plan.consume',
  'plan.reverse',
  'plan.adjust',
  'waitlist.read',
  'waitlist.manage',
  'dashboard.operations',
  'kpi.read',
  'audit.read',
  'notification.read',
  'notification.retry',
  'csv.export.customers',
  'csv.export.bookings',
  'csv.export.master',
  'csv.export.ledger',
];

const STAFF: readonly Permission[] = [
  'shift.read.own',
  'booking.read.own',
  'booking.create.own',
  'booking.update.own',
  'booking.cancel.own',
  'booking.status.own',
  'booking.internal_note',
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.note.general',
  'customer.note.confidential',
  'record.read',
  'record.write.own',
  'pass.read',
  'pass.consume',
  'plan.read',
  'plan.consume',
];

const RECEPTION: readonly Permission[] = [
  'shift.read.all',
  'booking.read.all',
  'booking.create.all',
  'booking.update.all',
  'booking.cancel.all',
  'booking.status.all',
  'reception.operate',
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.note.general',
  'pass.read',
  'pass.grant',
  'pass.consume',
  'plan.read',
  'plan.assign',
  'plan.consume',
  'waitlist.read',
  'waitlist.manage',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ALL),
  manager: new Set(MANAGER),
  staff: new Set(STAFF),
  reception: new Set(RECEPTION),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function permissionsOf(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/** ".all" または ".own" のどちらかを持つか */
export function roleHasAny(role: Role, ...perms: Permission[]): boolean {
  return perms.some((p) => roleHas(role, p));
}
