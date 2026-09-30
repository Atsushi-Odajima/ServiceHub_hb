import { describe, expect, it } from 'vitest';
import { candidateStarts, evaluateStart, listSlots, peakUsage } from '../../src/server/engine/availability.js';
import type { EngineInput, EngineOccupancy, EngineShift } from '../../src/server/engine/types.js';
import { localToUtcLenient } from '../../src/shared/time.js';

const TZ = 'Asia/Tokyo';
const DATE = '2030-01-10'; // 木曜
const L1 = 'loc-ikebukuro';
const L2 = 'loc-shinjuku';
const AKI = 'staff-aki';
const MIKA = 'staff-mika';
const at = (time: string, date = DATE, tz = TZ) => localToUtcLenient(date, time, tz);

function work(staffId: string, loc: string, from = '09:00', to = '21:00', date = DATE): EngineShift {
  return { staffId, locationId: loc, type: 'work', start: at(from, date), end: at(to, date) };
}

function occ(p: Omit<Partial<EngineOccupancy>, 'start' | 'end'> & { staffId: string | null; start: string; end: string; loc?: string; service?: string }): EngineOccupancy {
  const s = at(p.start);
  const e = at(p.end);
  return {
    id: p.id ?? `occ-${Math.random()}`,
    locationId: p.loc ?? L1,
    serviceId: p.service ?? 'svc-60',
    staffId: p.staffId,
    start: s,
    end: e,
    blockStart: p.blockStart ?? s,
    blockEnd: p.blockEnd ?? e,
    capacity: p.capacity ?? 1,
    seatsTaken: p.seatsTaken ?? 1,
    resources: p.resources ?? [],
  };
}

function base(over: Partial<EngineInput> = {}): EngineInput {
  const location = {
    id: L1,
    timezone: TZ,
    status: 'active',
    isPublic: true,
    slotIntervalMin: 30,
    minNoticeMin: 60,
    maxAdvanceDays: 60,
    maxConcurrentSessions: null,
    hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: '10:00', close: '19:00' })),
    exceptions: [],
    blocks: [],
  };
  const service = {
    id: 'svc-60',
    name: '60分パーソナル',
    status: 'active',
    isBookable: true,
    isPublic: true,
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    capacity: 1,
    maxPartySize: 1,
    requiresStaff: true,
    scheduleMode: 'flexible' as const,
    slotIntervalMin: null,
    minNoticeMin: null,
    maxAdvanceDays: null,
    locationIds: [L1, L2],
    staffIds: [AKI, MIKA],
    requirements: [],
    fixedTimes: [],
  };
  return {
    now: at('08:00', '2030-01-09'),
    location,
    service,
    staff: [
      { id: AKI, displayName: 'Aki', status: 'active', acceptsBookings: true, locationIds: [L1, L2], sortOrder: 0 },
      { id: MIKA, displayName: 'Mika', status: 'active', acceptsBookings: true, locationIds: [L1], sortOrder: 1 },
    ],
    shifts: [work(AKI, L1)],
    occupancies: [],
    resources: [],
    travelBufferMin: 0,
    mode: 'staff',
    force: false,
    partySize: 1,
    ...over,
  };
}

const times = (slots: { start: Date }[], tz = TZ) =>
  slots.map((s) => s.start.toLocaleTimeString('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit' }));

describe('engine: candidates & business hours', () => {
  it('lists 30-min slots whose service time fits business hours (10:00-19:00, 60min → 10:00..18:00)', () => {
    const slots = listSlots(base(), DATE, AKI);
    expect(times(slots)[0]).toBe('10:00');
    expect(times(slots).at(-1)).toBe('18:00');
    expect(slots).toHaveLength(17);
  });

  it('closed exception removes the day; special hours replace regular hours', () => {
    const closed = base();
    closed.location.exceptions = [{ date: DATE, kind: 'closed', open: null, close: null }];
    expect(listSlots(closed, DATE, AKI)).toHaveLength(0);
    const special = base();
    special.location.exceptions = [{ date: DATE, kind: 'special_hours', open: '13:00', close: '15:00' }];
    expect(times(listSlots(special, DATE, AKI))).toEqual(['13:00', '13:30', '14:00']);
  });

  it('location block removes overlapping slots', () => {
    const i = base();
    i.location.blocks = [{ start: at('12:00'), end: at('13:00') }];
    const t = times(listSlots(i, DATE, AKI));
    expect(t).not.toContain('11:30');
    expect(t).not.toContain('12:00');
    expect(t).toContain('13:00');
    expect(evaluateStart(i, at('12:00'), AKI).violations.map((x) => x.code)).toContain('LOCATION_BLOCKED');
  });

  it('DST gap: no slots at non-existent local times (America/New_York 2030-03-10)', () => {
    const i = base();
    i.location.timezone = 'America/New_York';
    i.location.hours = [{ weekday: 7, open: '00:00', close: '06:00' }];
    i.service.durationMin = 30;
    const starts = candidateStarts(i, '2030-03-10');
    const local = times(starts.map((start) => ({ start })), 'America/New_York');
    expect(local).not.toContain('02:00');
    expect(local).not.toContain('02:30');
    expect(local).toContain('03:00');
  });

  it('fixed schedule mode lists only fixed start times', () => {
    const i = base();
    i.service.scheduleMode = 'fixed';
    i.service.fixedTimes = [
      { locationId: L1, weekday: 4, time: '10:00' },
      { locationId: L1, weekday: 4, time: '18:30' }, // 60分だと19:30終了で営業外
      { locationId: L2, weekday: 4, time: '11:00' },
    ];
    expect(times(listSlots(i, DATE, AKI))).toEqual(['10:00']);
    expect(evaluateStart(i, at('11:00'), AKI).violations.map((x) => x.code)).toContain('NOT_FIXED_TIME');
  });
});

describe('engine: staff constraints', () => {
  it('#11 outside shift is not bookable (soft: allowed only with force)', () => {
    const i = base({ shifts: [work(AKI, L1, '13:00', '17:00')] });
    const r = evaluateStart(i, at('11:00'), AKI);
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.code)).toContain('OUTSIDE_SHIFT');
    expect(evaluateStart({ ...i, force: true }, at('11:00'), AKI).ok).toBe(true);
    expect(times(listSlots(i, DATE, AKI))).toEqual(['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
  });

  it('shift at another location does not make staff available here', () => {
    const i = base({ shifts: [work(AKI, L2)] });
    expect(evaluateStart(i, at('11:00'), AKI).violations.map((x) => x.code)).toContain('OUTSIDE_SHIFT');
  });

  it('break / vacation / block shifts exclude overlapping slots', () => {
    const i = base({
      shifts: [
        work(AKI, L1),
        { staffId: AKI, locationId: L1, type: 'break', start: at('12:00'), end: at('13:00') },
        { staffId: AKI, locationId: null, type: 'block', start: at('16:00'), end: at('16:30') },
      ],
    });
    const t = times(listSlots(i, DATE, AKI));
    expect(t).toContain('11:00');
    expect(t).not.toContain('11:30');
    expect(t).not.toContain('12:00');
    expect(t).toContain('13:00');
    expect(t).not.toContain('15:30');
    expect(t).not.toContain('16:00');
    expect(evaluateStart(i, at('12:00'), AKI).violations[0].code).toBe('STAFF_UNAVAILABLE');
  });

  it('#10 archived staff cannot be assigned, even with force', () => {
    const i = base();
    i.staff[0].status = 'archived';
    const r = evaluateStart({ ...i, force: true }, at('11:00'), AKI);
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.code)).toContain('STAFF_INVALID');
    expect(listSlots(i, DATE, AKI)).toHaveLength(0);
  });

  it('staff not qualified for the service or not assigned to the location is invalid', () => {
    const i = base({ shifts: [work(MIKA, L1)] });
    i.service.staffIds = [AKI];
    expect(evaluateStart(i, at('11:00'), MIKA).violations.map((x) => x.code)).toEqual(['STAFF_INVALID']);
    const j = base({ shifts: [work(MIKA, L1)] });
    j.location = { ...j.location, id: L2 };
    expect(evaluateStart(j, at('11:00'), MIKA).violations.map((x) => x.code)).toContain('STAFF_INVALID');
  });

  it('#7 existing booking at another location blocks the same time (hard, force cannot override)', () => {
    const i = base({
      location: { ...base().location, id: L2 },
      shifts: [work(AKI, L2)],
      occupancies: [occ({ staffId: AKI, loc: L1, start: '10:00', end: '11:00' })],
    });
    const r = evaluateStart({ ...i, force: true }, at('10:00'), AKI);
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.code)).toContain('STAFF_BUSY');
    expect(times(listSlots(i, DATE, AKI))).not.toContain('10:30');
    expect(times(listSlots(i, DATE, AKI))).toContain('11:00');
  });

  it('buffers extend the staff block range', () => {
    const i = base({ occupancies: [occ({ staffId: AKI, start: '10:00', end: '11:00', blockEnd: at('11:15') })] });
    i.service.bufferBeforeMin = 10;
    // 11:00開始は B=[10:50, 12:00) → 既存 B=[10:00,11:15) と重複
    expect(evaluateStart(i, at('11:00'), AKI).violations.map((x) => x.code)).toContain('STAFF_BUSY');
    expect(evaluateStart(i, at('11:30'), AKI).ok).toBe(true);
  });

  it('travel buffer: 30 min required between locations', () => {
    const i = base({
      location: { ...base().location, id: L2 },
      shifts: [work(AKI, L2)],
      travelBufferMin: 30,
      occupancies: [occ({ staffId: AKI, loc: L1, start: '10:00', end: '10:30' })],
    });
    expect(evaluateStart(i, at('10:30'), AKI).violations.map((x) => x.code)).toContain('TRAVEL_TIME');
    expect(evaluateStart(i, at('11:00'), AKI).ok).toBe(true);
    // 同じ拠点なら移動時間は不要
    const same = base({ travelBufferMin: 30, occupancies: [occ({ staffId: AKI, loc: L1, start: '10:00', end: '10:30' })] });
    expect(evaluateStart(same, at('10:30'), AKI).ok).toBe(true);
    // 移動時間設定なしなら隣接可
    expect(evaluateStart({ ...i, travelBufferMin: 0 }, at('10:30'), AKI).ok).toBe(true);
  });
});

describe('engine: resources', () => {
  const withRoom = (over: Partial<EngineInput> = {}) => {
    const i = base({ shifts: [work(AKI, L1), work(MIKA, L1)], ...over });
    i.service.requirements = [{ id: 'req-room', label: '個室', quantity: 1, resourceIds: ['room-a', 'room-b'] }];
    i.resources = [{ id: 'room-a', name: 'Room A', locationId: L1, status: 'active', capacity: 1, sortOrder: 0, hours: [], blocks: [] }];
    return i;
  };

  it('#12 resource conflict: another staff using the only room blocks the slot', () => {
    const i = withRoom({ occupancies: [occ({ staffId: MIKA, start: '10:00', end: '11:00', resources: [{ resourceId: 'room-a', units: 1 }] })] });
    const r = evaluateStart(i, at('10:30'), AKI);
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.code)).toContain('RESOURCE_UNAVAILABLE');
    expect(evaluateStart({ ...i, force: true }, at('10:30'), AKI).ok).toBe(false);
  });

  it('second room makes it available and allocates it', () => {
    const i = withRoom({ occupancies: [occ({ staffId: MIKA, start: '10:00', end: '11:00', resources: [{ resourceId: 'room-a', units: 1 }] })] });
    i.resources.push({ id: 'room-b', name: 'Room B', locationId: L1, status: 'active', capacity: 1, sortOrder: 1, hours: [], blocks: [] });
    const r = evaluateStart(i, at('10:30'), AKI);
    expect(r.ok).toBe(true);
    expect(r.option?.resourceAllocations).toEqual([{ requirementId: 'req-room', resourceId: 'room-b', units: 1 }]);
  });

  it('stopped resource and maintenance block are not used; resource at other location is ignored', () => {
    const i = withRoom();
    i.resources[0].blocks = [{ start: at('10:00'), end: at('12:00') }];
    expect(evaluateStart(i, at('11:00'), AKI).violations.map((x) => x.code)).toContain('RESOURCE_UNAVAILABLE');
    const j = withRoom();
    j.resources[0].status = 'stopped';
    expect(evaluateStart(j, at('14:00'), AKI).ok).toBe(false);
    const k = withRoom();
    k.resources[0].locationId = L2;
    expect(evaluateStart(k, at('14:00'), AKI).ok).toBe(false);
  });

  it('peak usage counts concurrent use, not total overlapping', () => {
    const B = { start: at('10:00'), end: at('12:00') };
    const list = [
      occ({ staffId: null, start: '09:30', end: '10:30', resources: [{ resourceId: 'm', units: 1 }] }),
      occ({ staffId: null, start: '11:30', end: '12:30', resources: [{ resourceId: 'm', units: 1 }] }),
    ];
    expect(peakUsage(list, 'm', B)).toBe(1);
    list.push(occ({ staffId: null, start: '10:15', end: '11:45', resources: [{ resourceId: 'm', units: 1 }] }));
    expect(peakUsage(list, 'm', B)).toBe(2);
  });

  it('resource hours restrict availability', () => {
    const i = withRoom();
    i.resources[0].hours = [{ weekday: 4, start: '13:00', end: '17:00' }];
    expect(evaluateStart(i, at('11:00'), AKI).ok).toBe(false);
    expect(evaluateStart(i, at('13:00'), AKI).ok).toBe(true);
    expect(evaluateStart(i, at('16:30'), AKI).ok).toBe(false);
  });

  it('staffless service (rental space) books a resource only', () => {
    const i = withRoom();
    i.service.requiresStaff = false;
    i.service.staffIds = [];
    const r = evaluateStart(i, at('10:00'), null);
    expect(r.ok).toBe(true);
    expect(r.option?.staffId).toBeNull();
    expect(listSlots(i, DATE, 'auto').length).toBe(17);
  });
});

describe('engine: capacity (group sessions)', () => {
  const yoga = (seatsTaken: number, partySize: number) => {
    const i = base({ partySize, occupancies: [occ({ id: 'yoga-10', staffId: AKI, service: 'svc-yoga', start: '10:00', end: '11:00', capacity: 6, seatsTaken })] });
    i.service = { ...i.service, id: 'svc-yoga', capacity: 6, maxPartySize: 3 };
    return i;
  };

  it('#13 capacity 6 with 5 booked: party of 2 rejected, party of 1 joins', () => {
    const r2 = evaluateStart(yoga(5, 2), at('10:00'), AKI);
    expect(r2.ok).toBe(false);
    expect(r2.violations.map((x) => x.code)).toContain('CAPACITY_FULL');
    const r1 = evaluateStart(yoga(5, 1), at('10:00'), AKI);
    expect(r1.ok).toBe(true);
    expect(r1.option?.joinOccupancyId).toBe('yoga-10');
    expect(r1.option?.seatsAvailable).toBe(1);
  });

  it('full session is not listed; joining does not need new resources', () => {
    const full = yoga(6, 1);
    expect(times(listSlots(full, DATE, AKI))).not.toContain('10:00');
    const open = yoga(3, 1);
    open.service.requirements = [{ id: 'req-studio', label: 'Studio', quantity: 1, resourceIds: ['studio'] }];
    open.resources = [{ id: 'studio', name: 'Studio', locationId: L1, status: 'active', capacity: 1, sortOrder: 0, hours: [], blocks: [] }];
    open.occupancies[0].resources = [{ resourceId: 'studio', units: 1 }];
    const r = evaluateStart(open, at('10:00'), AKI);
    expect(r.ok).toBe(true);
    expect(r.option?.resourceAllocations).toEqual([]);
    // 別時刻の新規開催はスタジオが空いていれば可能
    expect(evaluateStart(open, at('11:00'), AKI).ok).toBe(true);
    expect(evaluateStart(open, at('10:30'), AKI).ok).toBe(false);
  });

  it('party size above max is rejected', () => {
    const r = evaluateStart(yoga(0, 4), at('10:00'), AKI);
    expect(r.violations.map((x) => x.code)).toContain('PARTY_SIZE');
  });
});

describe('engine: booking window, concurrency limit, auto assignment', () => {
  it('public mode enforces min notice and max advance; staff mode does not', () => {
    const i = base({ mode: 'public', now: at('09:30') });
    expect(evaluateStart(i, at('10:00'), AKI).violations.map((x) => x.code)).toContain('TOO_SOON');
    expect(evaluateStart(i, at('11:00'), AKI).ok).toBe(true);
    expect(evaluateStart({ ...i, mode: 'staff' }, at('10:00'), AKI).ok).toBe(true);
    const far = base({ mode: 'public', shifts: [work(AKI, L1, '09:00', '21:00', '2030-03-20')] });
    expect(evaluateStart(far, at('11:00', '2030-03-20'), AKI).violations.map((x) => x.code)).toContain('TOO_FAR');
  });

  it('public mode hides non-public service/location', () => {
    const i = base({ mode: 'public' });
    i.service.isPublic = false;
    expect(evaluateStart(i, at('11:00'), AKI).violations.map((x) => x.code)).toContain('SERVICE_UNAVAILABLE');
    expect(evaluateStart({ ...i, mode: 'staff' }, at('11:00'), AKI).ok).toBe(true);
  });

  it('past start is rejected unless forced', () => {
    const i = base({ now: at('12:00') });
    expect(evaluateStart(i, at('10:00'), AKI).violations.map((x) => x.code)).toContain('IN_PAST');
    expect(evaluateStart({ ...i, force: true }, at('10:00'), AKI).ok).toBe(true);
  });

  it('max concurrent sessions per location', () => {
    const i = base({ shifts: [work(AKI, L1), work(MIKA, L1)], occupancies: [occ({ staffId: MIKA, start: '10:00', end: '11:00' })] });
    i.location.maxConcurrentSessions = 1;
    expect(evaluateStart(i, at('10:00'), AKI).violations.map((x) => x.code)).toContain('MAX_CONCURRENT');
    expect(evaluateStart(i, at('11:00'), AKI).ok).toBe(true);
  });

  it('auto assignment picks the less busy staff, and lists all available staff', () => {
    const i = base({ shifts: [work(AKI, L1), work(MIKA, L1)], occupancies: [occ({ staffId: AKI, start: '14:00', end: '15:00' })] });
    const r = evaluateStart(i, at('10:00'), 'auto');
    expect(r.ok).toBe(true);
    expect(r.option?.staffId).toBe(MIKA);
    const slots = listSlots(i, DATE, 'auto');
    const ten = slots.find((s) => s.start.getTime() === at('10:00').getTime())!;
    expect(ten.options.map((o) => o.staffId)).toEqual([MIKA, AKI]);
    const two = slots.find((s) => s.start.getTime() === at('14:00').getTime())!;
    expect(two.options.map((o) => o.staffId)).toEqual([MIKA]);
  });

  it('auto assignment fails with reasons when nobody is available', () => {
    const i = base({ shifts: [] });
    const r = evaluateStart(i, at('10:00'), 'auto');
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.code)).toContain('OUTSIDE_SHIFT');
  });
});
