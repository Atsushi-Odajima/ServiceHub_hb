/**
 * ServiceHub 空き枠お知らせ画像 — 画像の内容(状態)と、空き枠データからの組み立て。
 * #005「サロン空き枠お知らせ画像メーカー」の core.js を移植し、手入力の代わりに
 * ServiceHub の予約エンジンの空き枠(GET /api/v1/availability/announcement)から状態を作る。
 * DOM/Canvas に依存しない純関数のみ(単体テスト対象)。
 */
import { addDays, isoWeekday } from '../time.js';

export const DAY_COUNT = 7;
export const MAX_SLOTS_PER_DAY = 4;

export const LIMITS = { shopName: 30, booking: 50, note: 50, label: 12 } as const;

export type SlotStatus = 'open' | 'full' | 'hidden';
export type DayMode = 'slots' | 'full' | 'closed';
export type PaletteId = 'white' | 'beige' | 'charcoal';
export type SizeId = 'square' | 'story';
export type OutputMode = 'week' | 'single';
export type SingleTitle = 'vacancy' | 'cancel';

export const STATUS_LABELS: Record<SlotStatus, string> = { open: '空きあり', full: '満席', hidden: '非表示' };
export const DAY_MODE_LABELS: Record<DayMode, string> = { slots: '枠を表示', full: '満席', closed: '休業' };
export const SIZE_LABELS: Record<SizeId, string> = { square: '正方形', story: '縦長' };
export const PALETTE_LABELS: Record<PaletteId, string> = { white: 'ホワイト', beige: 'ウォームベージュ', charcoal: 'チャコール' };
export const SINGLE_TITLE_TEXT: Record<SingleTitle, string> = { vacancy: '空き枠のお知らせ', cancel: 'キャンセル枠のご案内' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export interface AnnSlot {
  id: string;
  time: string;
  label: string;
  status: SlotStatus;
}

export interface AnnDay {
  mode: DayMode;
  slots: AnnSlot[];
}

export interface AnnState {
  shop: { name: string; booking: string; note: string };
  startDate: string;
  days: AnnDay[];
  design: { palette: PaletteId; size: SizeId };
  output: { mode: OutputMode; singleSlotId: string | null; singleTitle: SingleTitle };
}

export interface Issue {
  level: 'error' | 'warning';
  field: string | null;
  message: string;
}

/* ---------- 日付(カレンダー上の年月日。"YYYY-MM-DD") ---------- */

function parts(iso: string): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return mt ? { y: +mt[1], m: +mt[2], d: +mt[3] } : null;
}

/** 0=日 … 6=土 */
export function weekdayIndex(iso: string): number {
  return isoWeekday(iso) % 7;
}

export function weekdayLabel(iso: string): string {
  return WEEKDAYS[weekdayIndex(iso)];
}

export function weekDates(startIso: string): string[] {
  return Array.from({ length: DAY_COUNT }, (_, i) => addDays(startIso, i));
}

export function formatMonthDay(iso: string): string {
  const p = parts(iso);
  return p ? `${p.m}/${p.d}` : '';
}

export function formatJaDate(iso: string, withYear: boolean): string {
  const p = parts(iso);
  if (!p) return '';
  return `${withYear ? `${p.y}年` : ''}${p.m}月${p.d}日(${weekdayLabel(iso)})`;
}

/** 対象期間: 必ず年を含める。年をまたぐ場合は終了日にも年を付ける */
export function formatPeriod(startIso: string): string {
  const endIso = addDays(startIso, DAY_COUNT - 1);
  const s = parts(startIso);
  const e = parts(endIso);
  if (!s || !e) return '';
  return `${formatJaDate(startIso, true)}〜${formatJaDate(endIso, s.y !== e.y)}`;
}

export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/* ---------- 状態の参照 ---------- */

export function sortedSlots(slots: AnnSlot[]): AnnSlot[] {
  return slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.time < b.s.time ? -1 : a.s.time > b.s.time ? 1 : a.i - b.i))
    .map((x) => x.s);
}

/** 画像に表示する枠(日モードが「枠を表示」かつ非表示以外、時刻昇順) */
export function visibleSlots(day: AnnDay): AnnSlot[] {
  if (day.mode !== 'slots') return [];
  return sortedSlots(day.slots.filter((s) => s.status !== 'hidden' && isValidTime(s.time)));
}

export function findSlot(state: AnnState, id: string | null): { dayIndex: number; slot: AnnSlot } | null {
  if (id === null) return null;
  for (let i = 0; i < state.days.length; i++) {
    const slot = state.days[i].slots.find((s) => s.id === id);
    if (slot) return { dayIndex: i, slot };
  }
  return null;
}

/** 1枠告知に選べる枠 */
export function isSlotEligible(state: AnnState, id: string | null): boolean {
  const f = findSlot(state, id);
  if (!f) return false;
  return state.days[f.dayIndex].mode === 'slots' && f.slot.status === 'open' && isValidTime(f.slot.time);
}

export function eligibleSlots(state: AnnState): { id: string; dayIndex: number; date: string; time: string; label: string }[] {
  const dates = weekDates(state.startDate);
  const list: { id: string; dayIndex: number; date: string; time: string; label: string }[] = [];
  state.days.forEach((day, i) => {
    if (day.mode !== 'slots') return;
    for (const s of sortedSlots(day.slots)) {
      if (s.status === 'open' && isValidTime(s.time)) list.push({ id: s.id, dayIndex: i, date: dates[i], time: s.time, label: s.label });
    }
  });
  return list;
}

/** 画像保存前のチェック(描画以外の問題)。error は保存不可、warning は確認のうえ保存可 */
export function collectIssues(state: AnnState): Issue[] {
  const issues: Issue[] = [];
  const dates = weekDates(state.startDate);
  if (!state.shop.name.trim()) issues.push({ level: 'warning', field: 'shop.name', message: '店舗名が空欄です(画像に店舗名が表示されません)。' });
  for (const [key, limit, label] of [
    ['name', LIMITS.shopName, '店舗名'],
    ['booking', LIMITS.booking, '予約方法の案内文'],
    ['note', LIMITS.note, '補足文'],
  ] as const) {
    if (Array.from(state.shop[key]).length > limit) issues.push({ level: 'error', field: `shop.${key}`, message: `${label}は${limit}文字までです。` });
  }
  state.days.forEach((day, i) => {
    for (const s of day.slots) {
      if (Array.from(s.label).length > LIMITS.label) {
        issues.push({ level: 'error', field: `slot:${s.id}:label`, message: `${formatJaDate(dates[i], false)} ${s.time} のメニュー名・補足は${LIMITS.label}文字までです。` });
      }
    }
  });
  if (state.output.mode === 'week') {
    state.days.forEach((day, i) => {
      if (day.mode === 'slots' && visibleSlots(day).length === 0) {
        issues.push({ level: 'warning', field: `day:${i}`, message: `${formatJaDate(dates[i], false)}:表示する枠がありません(画像には「情報未設定」と表示されます)。` });
      }
    });
  } else if (eligibleSlots(state).length === 0) {
    issues.push({ level: 'error', field: 'single', message: '1枠告知に使える「空きあり」の枠がありません。' });
  } else if (!isSlotEligible(state, state.output.singleSlotId)) {
    issues.push({ level: 'error', field: 'single', message: '告知する枠を選んでください。' });
  }
  return issues;
}

/* ---------- ファイル名 ---------- */

export function imageFileName(state: AnnState): string {
  const sizeLabel = SIZE_LABELS[state.design.size];
  if (state.output.mode === 'single') {
    const f = findSlot(state, state.output.singleSlotId);
    if (f) return `空き枠_1枠_${addDays(state.startDate, f.dayIndex)}_${f.slot.time.replace(':', '')}_${sizeLabel}.png`;
  }
  return `空き枠_週間_${state.startDate}_${sizeLabel}.png`;
}

/* ---------- ServiceHub の空き枠データから状態を組み立てる ---------- */

/** GET /api/v1/availability/announcement の1日分 */
export interface AvailabilityDay {
  date: string;
  /** 営業時間なし(定休日・臨時休業) */
  closed: boolean;
  /** 候補時刻(過去を除く)と、予約エンジンで空きがあるか */
  slots: { time: string; startsAt: string; available: boolean; seatsAvailable: number | null }[];
}

/** 日ごとの手動の上書き */
export interface DayOverride {
  /** auto: 空き枠データから自動判定(営業なし→休業、空きなし→満席) */
  mode: 'auto' | DayMode;
  /** null: 空きのある時刻から自動で最大4枠を選ぶ / 配列: 表示する時刻を手動で指定 */
  times: string[] | null;
}

export interface AnnouncementOverrides {
  days: Record<string, DayOverride | undefined>;
  /** キー `${date}|${time}`: 枠の状態の上書き(非表示・満席扱いなど) */
  slotStatus: Record<string, SlotStatus | undefined>;
  /** キー `${date}|${time}`: 枠に添えるメニュー名・補足 */
  labels: Record<string, string | undefined>;
}

export const emptyOverrides = (): AnnouncementOverrides => ({ days: {}, slotStatus: {}, labels: {} });

export const slotKey = (date: string, time: string) => `${date}|${time}`;
export const slotId = (dayIndex: number, time: string) => `d${dayIndex}-${time.replace(':', '')}`;

/** 一覧から最大 n 件を、朝〜夜に散らばるよう等間隔で選ぶ(順序は保つ) */
export function pickSpread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list.slice();
  if (n <= 1) return list.slice(0, n);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out;
}

/** 日ごとに、自動判定で決まる表示モードと表示候補を返す(画面の表示にも使う) */
export function resolveDay(day: AvailabilityDay, ov: DayOverride | undefined): {
  mode: DayMode;
  autoMode: DayMode;
  times: string[];
  manual: boolean;
} {
  // 自動選択は予約エンジンの空きだけで決める(状態の上書き=非表示などは選んだ枠に後から効く。
  // 非表示にした枠も一覧に残るので、画面で元に戻せる)
  const openTimes = day.slots.filter((s) => s.available).map((s) => s.time);
  const autoMode: DayMode = day.closed ? 'closed' : openTimes.length === 0 ? 'full' : 'slots';
  const manual = Boolean(ov?.times);
  const known = new Set(day.slots.map((s) => s.time));
  const times = manual ? [...new Set(ov!.times!)].filter((t) => known.has(t)).sort().slice(0, MAX_SLOTS_PER_DAY) : pickSpread(openTimes, MAX_SLOTS_PER_DAY);
  let mode: DayMode = !ov || ov.mode === 'auto' ? autoMode : ov.mode;
  // 自動判定で「満席」でも、手動で時刻を選んだ日は枠を表示する
  if ((!ov || ov.mode === 'auto') && manual && times.length > 0 && !day.closed) mode = 'slots';
  return { mode, autoMode, times, manual };
}

export interface BuildParams {
  shop: AnnState['shop'];
  design: AnnState['design'];
  output: { mode: OutputMode; singleKey: string | null; singleTitle: SingleTitle };
  startDate: string;
  days: AvailabilityDay[];
  overrides: AnnouncementOverrides;
}

/** 空き枠データ + 上書き → 画像の状態(元ツールと同じ形) */
export function buildAnnouncementState(p: BuildParams): AnnState {
  const dates = weekDates(p.startDate);
  const byDate = new Map(p.days.map((d) => [d.date, d]));
  let singleSlotId: string | null = null;
  const days: AnnDay[] = dates.map((date, i) => {
    const day = byDate.get(date) ?? { date, closed: true, slots: [] };
    const r = resolveDay(day, p.overrides.days[date]);
    const avail = new Map(day.slots.map((s) => [s.time, s.available]));
    const slots: AnnSlot[] = r.times.map((time) => {
      const key = slotKey(date, time);
      const id = slotId(i, time);
      if (p.output.singleKey === key) singleSlotId = id;
      return {
        id,
        time,
        label: (p.overrides.labels[key] ?? '').trim(),
        status: p.overrides.slotStatus[key] ?? (avail.get(time) ? 'open' : 'full'),
      };
    });
    return { mode: r.mode, slots };
  });
  const state: AnnState = {
    shop: { ...p.shop },
    startDate: p.startDate,
    days,
    design: { ...p.design },
    output: { mode: p.output.mode, singleSlotId, singleTitle: p.output.singleTitle },
  };
  if (!isSlotEligible(state, state.output.singleSlotId)) state.output.singleSlotId = null;
  return state;
}
