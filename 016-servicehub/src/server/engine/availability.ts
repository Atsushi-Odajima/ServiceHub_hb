/**
 * 予約エンジン(純関数)。BOOKING_ENGINE.md の判定条件を実装する。
 * DB に依存しないため、候補表示時とトランザクション内の確定時の両方で同じ関数を使う。
 */
import {
  addDays,
  addMinutes,
  isoWeekday,
  localDateOf,
  localTimeOf,
  localToUtc,
  localToUtcLenient,
  minutesToTime,
  todayIn,
} from '../../shared/time.js';
import type {
  EngineInput,
  EngineLocation,
  EngineOccupancy,
  EngineResource,
  EngineStaff,
  EvaluateResult,
  Interval,
  ResourceAllocation,
  Slot,
  StaffOption,
  Violation,
  ViolationCode,
} from './types.js';

export const VIOLATION_MESSAGES: Record<ViolationCode, string> = {
  LOCATION_INACTIVE: 'この拠点は現在予約を受け付けていません',
  SERVICE_UNAVAILABLE: 'このサービスは現在予約を受け付けていません',
  SERVICE_NOT_AT_LOCATION: 'このサービスはこの拠点では提供していません',
  PARTY_SIZE: '人数が上限を超えています',
  OUTSIDE_BUSINESS_HOURS: '営業時間外です',
  NOT_FIXED_TIME: 'このサービスの開催時刻ではありません',
  LOCATION_BLOCKED: 'この時間は予約受付を停止しています',
  TOO_SOON: '予約受付の締切を過ぎています',
  TOO_FAR: 'まだ予約を受け付けていない日付です',
  IN_PAST: '過去の日時です',
  STAFF_INVALID: 'このスタッフは担当できません(アーカイブ済み・拠点外・対応外のいずれか)',
  OUTSIDE_SHIFT: 'スタッフの勤務時間外です',
  STAFF_UNAVAILABLE: 'スタッフの休憩・休暇・研修・予約不可の時間です',
  STAFF_BUSY: 'スタッフはこの時間に他の予約があります(他拠点を含む)',
  TRAVEL_TIME: 'スタッフの拠点間の移動時間が確保できません',
  RESOURCE_UNAVAILABLE: '必要な部屋・設備が空いていません',
  CAPACITY_FULL: '定員に達しています',
  MAX_CONCURRENT: '同時受付上限に達しています',
};

const HARD: ReadonlySet<ViolationCode> = new Set([
  'LOCATION_INACTIVE',
  'SERVICE_UNAVAILABLE',
  'SERVICE_NOT_AT_LOCATION',
  'PARTY_SIZE',
  'STAFF_INVALID',
  'STAFF_BUSY',
  'TRAVEL_TIME',
  'RESOURCE_UNAVAILABLE',
  'CAPACITY_FULL',
]);

function v(code: ViolationCode): Violation {
  return { code, hard: HARD.has(code), message: VIOLATION_MESSAGES[code] };
}

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && a.end > b.start;
export const contains = (outer: Interval, inner: Interval): boolean => outer.start <= inner.start && outer.end >= inner.end;

/** 連続・重複する区間を結合 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** 拠点ローカル日付の営業区間(例外日が優先) */
export function businessIntervals(loc: EngineLocation, date: string): Interval[] {
  const ex = loc.exceptions.filter((e) => e.date === date);
  let ranges: { open: string; close: string }[];
  if (ex.length > 0) {
    if (ex.some((e) => e.kind === 'closed')) return [];
    ranges = ex.filter((e) => e.kind === 'special_hours' && e.open && e.close).map((e) => ({ open: e.open!, close: e.close! }));
  } else {
    const wd = isoWeekday(date);
    ranges = loc.hours.filter((h) => h.weekday === wd).map((h) => ({ open: h.open, close: h.close }));
  }
  return mergeIntervals(
    ranges
      .map((r) => ({ start: localToUtcLenient(date, r.open, loc.timezone), end: localToUtcLenient(date, r.close, loc.timezone) }))
      .filter((i) => i.end > i.start),
  );
}

/** 占有時間内のリソース同時使用数のピーク */
export function peakUsage(occupancies: EngineOccupancy[], resourceId: string, B: Interval): number {
  const events: [number, number][] = [];
  for (const o of occupancies) {
    for (const r of o.resources) {
      if (r.resourceId !== resourceId) continue;
      const iv = { start: o.blockStart, end: o.blockEnd };
      if (!overlaps(iv, B)) continue;
      const s = Math.max(iv.start.getTime(), B.start.getTime());
      const e = Math.min(iv.end.getTime(), B.end.getTime());
      events.push([s, r.units], [e, -r.units]);
    }
  }
  // 同時刻は解放(-)を先に処理([) 区間)
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function resourceHoursCover(r: EngineResource, B: Interval, zone: string): boolean {
  if (r.hours.length === 0) return true;
  const date = localDateOf(B.start, zone);
  if (localDateOf(new Date(B.end.getTime() - 1), zone) !== date) return false;
  const wd = isoWeekday(date);
  const ranges = mergeIntervals(
    r.hours
      .filter((h) => h.weekday === wd)
      .map((h) => ({ start: localToUtcLenient(date, h.start, zone), end: localToUtcLenient(date, h.end, zone) })),
  );
  return ranges.some((iv) => contains(iv, B));
}

export function allocateResources(input: EngineInput, B: Interval): { ok: boolean; allocations: ResourceAllocation[] } {
  const { service: svc, location: loc } = input;
  const allocations: ResourceAllocation[] = [];
  const used = new Map<string, number>();
  for (const req of svc.requirements) {
    let need = req.quantity;
    const candidates = input.resources
      .filter((r) => req.resourceIds.includes(r.id) && r.locationId === loc.id && r.status === 'active')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const r of candidates) {
      if (need <= 0) break;
      if (r.blocks.some((b) => overlaps(b, B))) continue;
      if (!resourceHoursCover(r, B, loc.timezone)) continue;
      const avail = r.capacity - peakUsage(input.occupancies, r.id, B) - (used.get(r.id) ?? 0);
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      allocations.push({ requirementId: req.id, resourceId: r.id, units: take });
      used.set(r.id, (used.get(r.id) ?? 0) + take);
      need -= take;
    }
    if (need > 0) return { ok: false, allocations };
  }
  return { ok: true, allocations };
}

/** 候補開始時刻(営業区間内に収まるもの) */
export function candidateStarts(input: EngineInput, date: string): Date[] {
  const { location: loc, service: svc } = input;
  const intervals = businessIntervals(loc, date);
  if (intervals.length === 0) return [];
  const fits = (t: Date) => intervals.some((iv) => contains(iv, { start: t, end: addMinutes(t, svc.durationMin) }));
  if (svc.scheduleMode === 'fixed') {
    const wd = isoWeekday(date);
    return svc.fixedTimes
      .filter((f) => f.locationId === loc.id && f.weekday === wd)
      .map((f) => localToUtc(date, f.time, loc.timezone))
      .filter((t): t is Date => t !== null && fits(t))
      .sort((a, b) => a.getTime() - b.getTime());
  }
  const step = svc.slotIntervalMin ?? loc.slotIntervalMin;
  const out: Date[] = [];
  for (let m = 0; m < 24 * 60; m += step) {
    const t = localToUtc(date, minutesToTime(m), loc.timezone);
    if (t && fits(t)) out.push(t);
  }
  return out;
}

interface StaffEval {
  violations: Violation[];
  join: EngineOccupancy | null;
}

function evalStaff(input: EngineInput, s: EngineStaff | undefined, R: Interval, B: Interval): StaffEval {
  const { service: svc, location: loc } = input;
  const out: Violation[] = [];
  if (!s || s.status !== 'active' || !s.acceptsBookings || !s.locationIds.includes(loc.id) || !svc.staffIds.includes(s.id)) {
    return { violations: [v('STAFF_INVALID')], join: null };
  }
  const join =
    svc.capacity > 1
      ? (input.occupancies.find(
          (o) => o.staffId === s.id && o.locationId === loc.id && o.serviceId === svc.id && o.start.getTime() === R.start.getTime(),
        ) ?? null)
      : null;
  if (join && join.seatsTaken + input.partySize > join.capacity) out.push(v('CAPACITY_FULL'));
  const work = mergeIntervals(
    input.shifts.filter((sh) => sh.staffId === s.id && sh.type === 'work' && sh.locationId === loc.id).map((sh) => ({ start: sh.start, end: sh.end })),
  );
  if (!work.some((iv) => contains(iv, B))) out.push(v('OUTSIDE_SHIFT'));
  if (input.shifts.some((sh) => sh.staffId === s.id && sh.type !== 'work' && overlaps(sh, B))) out.push(v('STAFF_UNAVAILABLE'));
  for (const o of input.occupancies) {
    if (o.staffId !== s.id || (join && o.id === join.id)) continue;
    if (overlaps({ start: o.blockStart, end: o.blockEnd }, B)) {
      out.push(v('STAFF_BUSY'));
      break;
    }
  }
  if (input.travelBufferMin > 0) {
    const expanded = { start: addMinutes(B.start, -input.travelBufferMin), end: addMinutes(B.end, input.travelBufferMin) };
    for (const o of input.occupancies) {
      if (o.staffId !== s.id || o.locationId === loc.id || (join && o.id === join.id)) continue;
      if (overlaps({ start: o.blockStart, end: o.blockEnd }, expanded)) {
        out.push(v('TRAVEL_TIME'));
        break;
      }
    }
  }
  return { violations: out, join };
}

function staffDayMinutes(input: EngineInput, staffId: string, date: string): number {
  let total = 0;
  for (const o of input.occupancies) {
    if (o.staffId !== staffId) continue;
    if (localDateOf(o.start, input.location.timezone) !== date) continue;
    total += (o.end.getTime() - o.start.getTime()) / 60000;
  }
  return total;
}

function acceptable(violations: Violation[], force: boolean): boolean {
  return !violations.some((x) => x.hard) && (force || violations.length === 0);
}

/**
 * 1つの開始時刻について判定する。
 * staffChoice: スタッフID / 'auto'(おまかせ) / null(スタッフ不要サービス)
 */
export function evaluateStart(input: EngineInput, start: Date, staffChoice: string | 'auto' | null): EvaluateResult {
  const { location: loc, service: svc } = input;
  const end = addMinutes(start, svc.durationMin);
  const blockStart = addMinutes(start, -svc.bufferBeforeMin);
  const blockEnd = addMinutes(end, svc.bufferAfterMin);
  const R = { start, end };
  const B = { start: blockStart, end: blockEnd };
  const base: Violation[] = [];

  if (loc.status !== 'active' || (input.mode === 'public' && !loc.isPublic)) base.push(v('LOCATION_INACTIVE'));
  if (svc.status !== 'active' || !svc.isBookable || (input.mode === 'public' && !svc.isPublic)) base.push(v('SERVICE_UNAVAILABLE'));
  if (!svc.locationIds.includes(loc.id)) base.push(v('SERVICE_NOT_AT_LOCATION'));
  if (input.partySize < 1 || input.partySize > svc.maxPartySize || input.partySize > svc.capacity) base.push(v('PARTY_SIZE'));

  const date = localDateOf(start, loc.timezone);
  if (!businessIntervals(loc, date).some((iv) => contains(iv, R))) base.push(v('OUTSIDE_BUSINESS_HOURS'));
  if (svc.scheduleMode === 'fixed') {
    const wd = isoWeekday(date);
    const hhmm = localTimeOf(start, loc.timezone);
    if (!svc.fixedTimes.some((f) => f.locationId === loc.id && f.weekday === wd && f.time.slice(0, 5) === hhmm)) base.push(v('NOT_FIXED_TIME'));
  }
  if (loc.blocks.some((b) => overlaps(b, R))) base.push(v('LOCATION_BLOCKED'));
  if (start.getTime() < input.now.getTime() - 5 * 60_000) {
    base.push(v('IN_PAST'));
  } else if (input.mode === 'public') {
    const minNotice = svc.minNoticeMin ?? loc.minNoticeMin;
    const maxDays = svc.maxAdvanceDays ?? loc.maxAdvanceDays;
    if (start < addMinutes(input.now, minNotice)) base.push(v('TOO_SOON'));
    if (date > addDays(todayIn(loc.timezone, input.now), maxDays)) base.push(v('TOO_FAR'));
  }

  const makeOption = (staffId: string | null, join: EngineOccupancy | null): { option: StaffOption | null; violations: Violation[] } => {
    const vs: Violation[] = [];
    let allocations: ResourceAllocation[] = [];
    if (!join) {
      const alloc = allocateResources(input, B);
      if (!alloc.ok) vs.push(v('RESOURCE_UNAVAILABLE'));
      allocations = alloc.allocations;
      if (loc.maxConcurrentSessions) {
        const concurrent = input.occupancies.filter((o) => o.locationId === loc.id && overlaps({ start: o.start, end: o.end }, R)).length;
        if (concurrent + 1 > loc.maxConcurrentSessions) vs.push(v('MAX_CONCURRENT'));
      }
    }
    const seatsAvailable = join ? join.capacity - join.seatsTaken : svc.capacity;
    return {
      option: { staffId, joinOccupancyId: join?.id ?? null, seatsAvailable, resourceAllocations: allocations },
      violations: vs,
    };
  };

  // スタッフ不要サービス
  if (!svc.requiresStaff) {
    const join =
      svc.capacity > 1
        ? (input.occupancies.find(
            (o) => o.staffId === null && o.locationId === loc.id && o.serviceId === svc.id && o.start.getTime() === start.getTime(),
          ) ?? null)
        : null;
    const extra: Violation[] = [];
    if (join && join.seatsTaken + input.partySize > join.capacity) extra.push(v('CAPACITY_FULL'));
    const { option, violations } = makeOption(null, join);
    const all = [...base, ...extra, ...violations];
    return { ok: acceptable(all, input.force), start, end, blockStart, blockEnd, option: acceptable(all, input.force) ? option : null, violations: all };
  }

  const candidates =
    staffChoice === 'auto' || staffChoice === null
      ? input.staff.filter((s) => svc.staffIds.includes(s.id) && s.locationIds.includes(loc.id))
      : [input.staff.find((s) => s.id === staffChoice) ?? ({ id: staffChoice, status: 'missing' } as EngineStaff)];

  const perStaff: { staffId: string; violations: Violation[]; option: StaffOption | null }[] = [];
  for (const s of candidates) {
    const se = evalStaff(input, s.status === 'missing' ? undefined : s, R, B);
    if (se.violations.some((x) => x.code === 'STAFF_INVALID')) {
      perStaff.push({ staffId: s.id, violations: [...base, ...se.violations], option: null });
      continue;
    }
    const { option, violations } = makeOption(s.id, se.join);
    perStaff.push({ staffId: s.id, violations: [...base, ...se.violations, ...violations], option });
  }

  if (staffChoice !== 'auto' && staffChoice !== null) {
    const r = perStaff[0];
    const ok = acceptable(r.violations, input.force);
    return { ok, start, end, blockStart, blockEnd, option: ok ? r.option : null, violations: r.violations };
  }

  // おまかせ: 相乗り可能 > その日の担当時間が少ない > 表示順
  const date2 = date;
  const okList = perStaff.filter((p) => p.option && acceptable(p.violations, input.force));
  okList.sort((a, b) => {
    const ja = a.option!.joinOccupancyId ? 0 : 1;
    const jb = b.option!.joinOccupancyId ? 0 : 1;
    if (ja !== jb) return ja - jb;
    const ma = staffDayMinutes(input, a.staffId, date2);
    const mb = staffDayMinutes(input, b.staffId, date2);
    if (ma !== mb) return ma - mb;
    const sa = input.staff.find((s) => s.id === a.staffId)!;
    const sb = input.staff.find((s) => s.id === b.staffId)!;
    return sa.sortOrder - sb.sortOrder || sa.displayName.localeCompare(sb.displayName);
  });
  const best = okList[0];
  if (best) {
    return { ok: true, start, end, blockStart, blockEnd, option: best.option, violations: best.violations, perStaff };
  }
  // 誰も不可: 代表的な理由(候補スタッフなしの場合は STAFF_INVALID)
  const violations = perStaff.length === 0 ? [...base, v('STAFF_INVALID')] : dedupe(perStaff.flatMap((p) => p.violations));
  return { ok: false, start, end, blockStart, blockEnd, option: null, violations, perStaff };
}

function dedupe(list: Violation[]): Violation[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
}

/**
 * 1日の空き枠一覧(soft 制約も満たす枠のみ。強制予約は個別に evaluateStart で判定)。
 * staffChoice 'auto' の場合、各枠で担当可能なスタッフ全員を options に入れる。
 */
export function listSlots(input: EngineInput, date: string, staffChoice: string | 'auto'): Slot[] {
  const listingInput: EngineInput = { ...input, force: false };
  const slots: Slot[] = [];
  for (const start of candidateStarts(listingInput, date)) {
    if (!input.service.requiresStaff) {
      const r = evaluateStart(listingInput, start, null);
      if (r.ok && r.option) slots.push({ start, end: r.end, options: [r.option], seatsAvailable: r.option.seatsAvailable });
      continue;
    }
    if (staffChoice !== 'auto') {
      const r = evaluateStart(listingInput, start, staffChoice);
      if (r.ok && r.option) slots.push({ start, end: r.end, options: [r.option], seatsAvailable: r.option.seatsAvailable });
      continue;
    }
    const r = evaluateStart(listingInput, start, 'auto');
    if (!r.ok) continue;
    const options: StaffOption[] = (r.perStaff ?? [])
      .map((p) => {
        const again = evaluateStart(listingInput, start, p.staffId);
        return again.ok && again.option ? again.option : null;
      })
      .filter((o): o is StaffOption => o !== null);
    // 自動割当の優先順を保つ(先頭 = おまかせ時に割り当てるスタッフ)
    options.sort((a, b) => (a.staffId === r.option!.staffId ? -1 : b.staffId === r.option!.staffId ? 1 : 0));
    const seatsAvailable = Math.max(...options.map((o) => o.seatsAvailable));
    slots.push({ start, end: r.end, options, seatsAvailable });
  }
  return slots;
}
