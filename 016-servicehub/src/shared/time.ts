import { DateTime, IANAZone } from 'luxon';

/**
 * 拠点タイムゾーンの時刻計算(TIMEZONE_RULES.md)。
 * - 日付は 'YYYY-MM-DD'(拠点ローカル)、時刻は 'HH:MM' または 'HH:MM:SS'。
 * - 時点は Date または ISO 文字列(UTC)。
 */

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function parseTime(t: string): { h: number; m: number } {
  const [h, m] = t.split(':').map((x) => Number(x));
  return { h, m: m || 0 };
}

export function timeToMinutes(t: string): number {
  const { h, m } = parseTime(t);
  return h * 60 + m;
}

export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 拠点ローカルの日付+時刻 → UTC Date。
 * 存在しない時刻(DST開始で飛ぶ時刻)は null を返す(候補から除外するため)。
 * 24:00 は翌日 0:00 として扱う。
 */
export function localToUtc(date: string, time: string, zone: string): Date | null {
  const { h, m } = parseTime(time);
  let base = DateTime.fromISO(date, { zone });
  if (!base.isValid) return null;
  if (h === 24 && m === 0) {
    base = base.plus({ days: 1 });
    return base.startOf('day').toJSDate();
  }
  const dt = base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (!dt.isValid || dt.hour !== h || dt.minute !== m) return null;
  return dt.toJSDate();
}

/**
 * その日の中で UTC との時差が変わらない場合の時差(分)。夏時間の切り替えがある日は null。
 * (切り替えは1日に高々1回のため、0:00 と 23:59 の時差が同じなら日中に切り替えはない)
 */
export function constantOffsetOfDay(date: string, zone: string): number | null {
  const start = DateTime.fromISO(`${date}T00:00`, { zone });
  const end = DateTime.fromISO(`${date}T23:59`, { zone });
  if (!start.isValid || !end.isValid) return null;
  return start.offset === end.offset ? start.offset : null;
}

/** 必ず Date を返す版(存在しない時刻は Luxon の既定=後ろへずらす) */
export function localToUtcLenient(date: string, time: string, zone: string): Date {
  const { h, m } = parseTime(time);
  if (h === 24 && m === 0) return DateTime.fromISO(date, { zone }).plus({ days: 1 }).startOf('day').toJSDate();
  return DateTime.fromISO(date, { zone }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
}

export function toDateTime(d: Date | string, zone: string): DateTime {
  return (typeof d === 'string' ? DateTime.fromISO(d) : DateTime.fromJSDate(d)).setZone(zone);
}

/** 拠点ローカル日付の [0:00, 翌0:00) を UTC で返す */
export function localDayRange(date: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** 日付文字列の ISO 曜日(1=月..7=日)。日付そのものの曜日なのでタイムゾーンに依存しない */
export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday;
}

export function localDateOf(d: Date | string, zone: string): string {
  return toDateTime(d, zone).toISODate()!;
}

export function localTimeOf(d: Date | string, zone: string): string {
  return toDateTime(d, zone).toFormat('HH:mm');
}

export function todayIn(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(zone).toISODate()!;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

export function addMonthsClamped(date: string, months: number): string {
  // Luxon は月末を自動で丸める(1/31 + 1ヶ月 = 2/28 or 2/29)
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ months }).toISODate()!;
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    DateTime.fromISO(to, { zone: 'UTC' }).diff(DateTime.fromISO(from, { zone: 'UTC' }), 'days').days,
  );
}

export function startOfMonth(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).startOf('month').toISODate()!;
}

export function endOfMonth(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).endOf('month').toISODate()!;
}

export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date).isValid;
}

const WEEKDAY_JA = ['', '月', '火', '水', '木', '金', '土', '日'];
export function weekdayLabel(isoWeekdayNum: number): string {
  return WEEKDAY_JA[isoWeekdayNum] ?? '';
}

/** 表示: 2026/10/01(木) 10:00 */
export function formatDateTimeJa(d: Date | string, zone: string): string {
  const dt = toDateTime(d, zone);
  return `${dt.toFormat('yyyy/MM/dd')}(${WEEKDAY_JA[dt.weekday]}) ${dt.toFormat('HH:mm')}`;
}

export function formatDateJa(date: string): string {
  const dt = DateTime.fromISO(date, { zone: 'UTC' });
  return `${dt.toFormat('yyyy/MM/dd')}(${WEEKDAY_JA[dt.weekday]})`;
}

export function formatTimeRange(start: Date | string, end: Date | string, zone: string): string {
  return `${toDateTime(start, zone).toFormat('HH:mm')}〜${toDateTime(end, zone).toFormat('HH:mm')}`;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60000);
}
