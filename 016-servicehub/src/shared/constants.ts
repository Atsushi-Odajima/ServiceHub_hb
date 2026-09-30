import { z } from 'zod';

export const BOOKING_STATUSES = [
  'confirmed',
  'arrived',
  'in_service',
  'completed',
  'canceled_customer',
  'canceled_business',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** 状態表示は色だけに頼らず、文字と記号を必ず併記する */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, { label: string; short: string; icon: string; tone: string }> = {
  confirmed: { label: '来店待ち', short: '予約', icon: '○', tone: 'info' },
  arrived: { label: '来店済み', short: '来店', icon: '●', tone: 'accent' },
  in_service: { label: '対応中', short: '対応中', icon: '▶', tone: 'warning' },
  completed: { label: '完了', short: '完了', icon: '✓', tone: 'success' },
  canceled_customer: { label: 'キャンセル(顧客)', short: '取消', icon: '×', tone: 'muted' },
  canceled_business: { label: 'キャンセル(事業者)', short: '取消', icon: '×', tone: 'muted' },
  no_show: { label: '無断欠席', short: '欠席', icon: '!', tone: 'danger' },
};

export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['confirmed', 'arrived', 'in_service', 'completed'];
export const CANCELED_STATUSES: readonly BookingStatus[] = ['canceled_customer', 'canceled_business'];
export const TERMINAL_STATUSES: readonly BookingStatus[] = ['completed', 'canceled_customer', 'canceled_business', 'no_show'];

/** 許可される状態遷移(DATA_MODEL.md §4)。completed→in_service は実施記録の取消時のみ */
export const STATUS_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  confirmed: ['arrived', 'in_service', 'completed', 'canceled_customer', 'canceled_business', 'no_show'],
  arrived: ['confirmed', 'in_service', 'completed', 'canceled_customer', 'canceled_business', 'no_show'],
  in_service: ['arrived', 'completed'],
  completed: [],
  canceled_customer: [],
  canceled_business: [],
  no_show: [],
};

export const SHIFT_TYPES = ['work', 'break', 'vacation', 'training', 'other_work', 'block'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];
export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
  work: '勤務',
  break: '休憩',
  vacation: '休暇',
  training: '研修',
  other_work: '他業務',
  block: '予約不可',
};

export const QUESTION_TYPES = ['short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'confirm'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  short_text: '短文',
  long_text: '長文',
  single_choice: '単一選択',
  multi_choice: '複数選択',
  yes_no: 'はい/いいえ',
  confirm: '確認(同意)',
};

export const CHANNEL_LABELS: Record<string, string> = {
  public: '公開予約',
  staff: 'スタッフ',
  reception: '受付',
  waitlist: '待機から',
  import: '取込',
  restore: '復元',
};

export const PASS_ENTRY_LABELS: Record<string, string> = {
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

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  booking_confirmed: '予約確定',
  booking_changed: '予約変更',
  booking_canceled: '予約キャンセル',
  booking_reminder: 'リマインダー',
  waitlist_available: '空き枠のお知らせ',
  pass_expiring: '回数券期限のお知らせ',
  plan_expiring: 'プラン期限のお知らせ',
  member_invitation: 'メンバー招待',
  password_reset: 'パスワード再設定',
};

// ---- 組織設定(organizations.settings) ----
export const OrgSettingsSchema = z.object({
  /** 拠点間移動時間(分)。0 = 無効(同時刻の重複のみ防止) */
  travelBufferMinutes: z.number().int().min(0).max(240).default(0),
  /** 締切後キャンセル/無断欠席時の回数券・プラン消化: none=消化しない / confirm=運営者が確認 */
  lateCancelPolicy: z.enum(['none', 'confirm']).default('confirm'),
  /** 完了時の消化候補表示: on_complete=完了ダイアログで候補表示 / manual=実施記録から後で */
  consumptionPrompt: z.enum(['on_complete', 'manual']).default('on_complete'),
  /** Staff が自拠点の顧客を検索できるか(既定: 自分の担当顧客のみ) */
  staffCanSearchLocationCustomers: z.boolean().default(false),
  reminderLeadHours: z.number().int().min(0).max(168).default(24),
  passExpiringNoticeDays: z.number().int().min(0).max(90).default(7),
  planExpiringNoticeDays: z.number().int().min(0).max(90).default(7),
  notifications: z
    .object({
      bookingConfirmed: z.boolean().default(true),
      bookingChanged: z.boolean().default(true),
      bookingCanceled: z.boolean().default(true),
      bookingReminder: z.boolean().default(true),
      waitlistAvailable: z.boolean().default(true),
      passExpiring: z.boolean().default(true),
      planExpiring: z.boolean().default(true),
    })
    .prefault({}),
  replyToEmail: z.string().email().nullable().default(null),
  /** 将来の保存期間設定用(初版は手動匿名化のみ) */
  retention: z
    .object({
      customerInactiveMonths: z.number().int().positive().nullable().default(null),
    })
    .prefault({}),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  const r = OrgSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : OrgSettingsSchema.parse({});
}

// ---- 拠点の予約ページ設定(locations.booking_page) ----
export const BookingPageSchema = z.object({
  message: z.string().max(2000).default(''),
  notice: z.string().max(2000).default(''),
  themeColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#0f5f73'),
  allowStaffSelection: z.boolean().default(true),
  showPrices: z.boolean().default(true),
});
export type BookingPage = z.infer<typeof BookingPageSchema>;

export function parseBookingPage(raw: unknown): BookingPage {
  const r = BookingPageSchema.safeParse(raw ?? {});
  return r.success ? r.data : BookingPageSchema.parse({});
}
