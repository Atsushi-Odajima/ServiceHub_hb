import { formatDateJa, formatDateTimeJa, formatTimeRange, localDateOf, localTimeOf, todayIn, toDateTime } from '../../shared/time';

export { formatDateJa, formatDateTimeJa, formatTimeRange, localDateOf, localTimeOf, todayIn };

export function fmtTime(d: string | Date, zone: string): string {
  return localTimeOf(d, zone);
}

export function fmtDateTime(d: string | Date | null | undefined, zone: string): string {
  if (!d) return '—';
  return formatDateTimeJa(d, zone);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return formatDateJa(d);
}

export function fmtRelativeDay(date: string, zone: string, now = new Date()): string {
  const today = todayIn(zone, now);
  const diff = Math.round(toDateTime(`${date}T00:00:00`, 'UTC').diff(toDateTime(`${today}T00:00:00`, 'UTC'), 'days').days);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  return formatDateJa(date);
}

export function fmtPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('ja-JP');
}

export function fmtMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m ? `${m}分` : ''}` : `${m}分`;
}
