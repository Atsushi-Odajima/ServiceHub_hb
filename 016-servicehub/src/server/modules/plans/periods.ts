import { addDays, addMonthsClamped, endOfMonth, startOfMonth } from '../../../shared/time.js';

/** 顧客契約に保存する商品スナップショット(PLAN_USAGE_RULES.md) */
export interface PlanSnapshot {
  name: string;
  usesPerPeriod: number;
  periodMonths: number;
  alignment: 'calendar' | 'anniversary';
  carryoverEnabled: boolean;
  carryoverMax: number | null;
  allServices: boolean;
  serviceIds: string[];
}

export interface PeriodRange {
  start: string;
  end: string;
  index: number;
}

function monthIndex(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return y * 12 + (m - 1);
}

function fromMonthIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/**
 * 利用日 date を含む期間を返す(契約期間外なら null)。
 * - calendar: 暦月単位。初回は開始日〜月末(満額付与)
 * - anniversary: 開始日から periodMonths ごと(月末起点は月末に丸める。元の開始日から計算しズレを蓄積しない)
 * 終了日があれば最終期間は終了日で打ち切る。
 */
export function periodContaining(snap: Pick<PlanSnapshot, 'periodMonths' | 'alignment'>, startsOn: string, endsOn: string | null, date: string): PeriodRange | null {
  if (date < startsOn) return null;
  if (endsOn && date > endsOn) return null;
  const pm = Math.max(1, snap.periodMonths);
  let start: string;
  let end: string;
  let index: number;
  if (snap.alignment === 'calendar') {
    const k = Math.floor((monthIndex(date) - monthIndex(startsOn)) / pm);
    index = k;
    const firstMonth = monthIndex(startsOn) + k * pm;
    start = k === 0 ? startsOn : fromMonthIndex(firstMonth);
    end = endOfMonth(fromMonthIndex(firstMonth + pm - 1));
  } else {
    // 開始日 + k*pm ヶ月 <= date となる最大の k
    let k = Math.max(0, Math.floor((monthIndex(date) - monthIndex(startsOn)) / pm) - 1);
    while (addMonthsClamped(startsOn, (k + 1) * pm) <= date) k++;
    index = k;
    start = addMonthsClamped(startsOn, k * pm);
    end = addDays(addMonthsClamped(startsOn, (k + 1) * pm), -1);
  }
  if (endsOn && end > endsOn) end = endsOn;
  return { start, end, index };
}

/** eligibility 用(契約期間内であることは呼び出し側で確認済み) */
export function periodFor(snap: PlanSnapshot, startsOn: string, endsOn: string | null, date: string): { start: string; end: string } {
  const r = periodContaining(snap, startsOn, endsOn, date);
  if (!r) return { start: date, end: date };
  return { start: r.start, end: r.end };
}

/** 次の期間(繰越先) */
export function nextPeriod(snap: Pick<PlanSnapshot, 'periodMonths' | 'alignment'>, startsOn: string, endsOn: string | null, current: PeriodRange): PeriodRange | null {
  const nextDate = addDays(current.end, 1);
  return periodContaining(snap, startsOn, endsOn, nextDate);
}

export { startOfMonth };
