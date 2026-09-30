import { parseOrgSettings, type ShiftType } from '../../shared/constants.js';
import { addDays, localDateOf } from '../../shared/time.js';
import type { Q } from '../db/tx.js';
import type { EngineInput, EngineOccupancy, EngineResource, EngineService, EngineShift, EngineStaff } from './types.js';

export interface LoadParams {
  orgId: string;
  locationId: string;
  serviceId: string;
  from: Date;
  to: Date;
  now: Date;
  mode: 'public' | 'staff';
  force?: boolean;
  partySize?: number;
}

interface LocRow {
  id: string;
  timezone: string;
  status: string;
  is_public: boolean;
  slot_interval_min: number;
  min_notice_min: number;
  max_advance_days: number;
  max_concurrent_sessions: number | null;
}

interface SvcRow {
  id: string;
  name: string;
  status: string;
  is_bookable: boolean;
  is_public: boolean;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  capacity: number;
  max_party_size: number;
  requires_staff: boolean;
  schedule_mode: 'flexible' | 'fixed';
  slot_interval_min: number | null;
  min_notice_min: number | null;
  max_advance_days: number | null;
}

/**
 * 予約エンジンの入力を DB から読み込む(1 回の呼び出しで期間分)。
 * RLS 下で索引を使うため、時間重複は比較演算で書く(DEVELOPMENT.md §5)。
 */
export async function loadEngineInput(q: Q, p: LoadParams): Promise<EngineInput | null> {
  const loc = await q.maybeOne<LocRow>(
    `SELECT id, timezone, status, is_public, slot_interval_min, min_notice_min, max_advance_days, max_concurrent_sessions
       FROM locations WHERE organization_id = $1 AND id = $2`,
    [p.orgId, p.locationId],
  );
  const svc = await q.maybeOne<SvcRow>(
    `SELECT id, name, status, is_bookable, is_public, duration_min, buffer_before_min, buffer_after_min, capacity, max_party_size,
            requires_staff, schedule_mode, slot_interval_min, min_notice_min, max_advance_days
       FROM services WHERE organization_id = $1 AND id = $2`,
    [p.orgId, p.serviceId],
  );
  if (!loc || !svc) return null;
  const org = await q.one<{ settings: unknown }>('SELECT settings FROM organizations WHERE id = $1', [p.orgId]);
  const settings = parseOrgSettings(org.settings);
  const travel = settings.travelBufferMinutes;

  // 前後のbuffer・移動時間・日付境界を含めるため余裕を持った窓で読む
  const winFrom = new Date(p.from.getTime() - 36 * 3600_000);
  const winTo = new Date(p.to.getTime() + 36 * 3600_000);
  const dateFrom = addDays(localDateOf(p.from, loc.timezone), -1);
  const dateTo = addDays(localDateOf(p.to, loc.timezone), 1);

  const hours = await q.many<{ weekday: number; open_time: string; close_time: string }>(
      'SELECT weekday, open_time, close_time FROM location_hours WHERE organization_id = $1 AND location_id = $2',
      [p.orgId, loc.id],
    );
  const exceptions = await q.many<{ date: string; kind: 'closed' | 'special_hours'; open_time: string | null; close_time: string | null }>(
      `SELECT date, kind, open_time, close_time FROM location_exceptions
        WHERE organization_id = $1 AND location_id = $2 AND date BETWEEN $3 AND $4`,
      [p.orgId, loc.id, dateFrom, dateTo],
    );
  const blocks = await q.many<{ starts_at: Date; ends_at: Date }>(
      `SELECT starts_at, ends_at FROM location_blocks
        WHERE organization_id = $1 AND location_id = $2 AND starts_at < $4 AND ends_at > $3`,
      [p.orgId, loc.id, winFrom, winTo],
    );
  const svcLocs = await q.many<{ location_id: string }>('SELECT location_id FROM service_locations WHERE organization_id = $1 AND service_id = $2', [p.orgId, svc.id]);
  const svcStaff = await q.many<{ staff_id: string }>('SELECT staff_id FROM service_staff WHERE organization_id = $1 AND service_id = $2', [p.orgId, svc.id]);
  const reqs = await q.many<{ id: string; label: string; quantity: number; resource_ids: string[] }>(
      `SELECT r.id, r.label, r.quantity,
              coalesce((SELECT array_agg(o.resource_id ORDER BY o.resource_id) FROM service_resource_options o WHERE o.requirement_id = r.id), '{}') AS resource_ids
         FROM service_resource_requirements r
        WHERE r.organization_id = $1 AND r.service_id = $2 ORDER BY r.sort_order, r.label`,
      [p.orgId, svc.id],
    );
  const fixed = await q.many<{ location_id: string; weekday: number; start_time: string }>(
      'SELECT location_id, weekday, start_time FROM service_fixed_times WHERE organization_id = $1 AND service_id = $2',
      [p.orgId, svc.id],
    );

  const staffIds = svcStaff.map((s) => s.staff_id);
  const staffRows = staffIds.length
    ? await q.many<{ id: string; display_name: string; status: string; accepts_bookings: boolean; sort_order: number; location_ids: string[] }>(
        `SELECT s.id, s.display_name, s.status, s.accepts_bookings, s.sort_order,
                coalesce((SELECT array_agg(sl.location_id ORDER BY sl.location_id) FROM staff_locations sl WHERE sl.staff_id = s.id), '{}') AS location_ids
           FROM staff s WHERE s.organization_id = $1 AND s.id = ANY($2::uuid[])`,
        [p.orgId, staffIds],
      )
    : [];

  const shifts = staffIds.length
    ? await q.many<{ staff_id: string; location_id: string | null; shift_type: ShiftType; starts_at: Date; ends_at: Date }>(
        `SELECT staff_id, location_id, shift_type, starts_at, ends_at FROM staff_shifts
          WHERE organization_id = $1 AND staff_id = ANY($2::uuid[])
            AND starts_at >= $3::timestamptz - interval '2 days' AND starts_at < $4 AND ends_at > $3`,
        [p.orgId, staffIds, winFrom, winTo],
      )
    : [];

  const resourceIds = [...new Set(reqs.flatMap((r) => r.resource_ids))];
  const resourceRows = resourceIds.length
    ? await q.many<{ id: string; name: string; location_id: string; status: string; capacity: number; sort_order: number }>(
        `SELECT id, name, location_id, status, capacity, sort_order FROM resources
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND location_id = $3`,
        [p.orgId, resourceIds, loc.id],
      )
    : [];
  const localResIds = resourceRows.map((r) => r.id);
  const resHours = localResIds.length
    ? await q.many<{ resource_id: string; weekday: number; start_time: string; end_time: string }>(
        'SELECT resource_id, weekday, start_time, end_time FROM resource_hours WHERE organization_id = $1 AND resource_id = ANY($2::uuid[])',
        [p.orgId, localResIds],
      )
    : [];
  const resBlocks = localResIds.length
    ? await q.many<{ resource_id: string; starts_at: Date; ends_at: Date }>(
        `SELECT resource_id, starts_at, ends_at FROM resource_blocks
          WHERE organization_id = $1 AND resource_id = ANY($2::uuid[]) AND starts_at < $4 AND ends_at > $3`,
        [p.orgId, localResIds, winFrom, winTo],
      )
    : [];

  // この拠点の有効占有 + 候補スタッフの(他拠点を含む)有効占有
  const occRows = await q.many<{
    id: string;
    location_id: string;
    service_id: string;
    staff_id: string | null;
    starts_at: Date;
    ends_at: Date;
    block_starts_at: Date;
    block_ends_at: Date;
    capacity: number;
    seats_taken: number;
  }>(
    `SELECT id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken
       FROM occupancies
      WHERE organization_id = $1 AND status = 'active'
        AND (location_id = $2 OR staff_id = ANY($3::uuid[]))
        AND block_starts_at >= $4::timestamptz - interval '2 days' AND block_starts_at < $5 AND block_ends_at > $4`,
    [p.orgId, loc.id, staffIds, winFrom, winTo],
  );
  const occIds = occRows.map((o) => o.id);
  const occRes = occIds.length
    ? await q.many<{ occupancy_id: string; resource_id: string; units: number }>(
        `SELECT occupancy_id, resource_id, units FROM occupancy_resources
          WHERE organization_id = $1 AND occupancy_id = ANY($2::uuid[]) AND active`,
        [p.orgId, occIds],
      )
    : [];

  const service: EngineService = {
    id: svc.id,
    name: svc.name,
    status: svc.status,
    isBookable: svc.is_bookable,
    isPublic: svc.is_public,
    durationMin: svc.duration_min,
    bufferBeforeMin: svc.buffer_before_min,
    bufferAfterMin: svc.buffer_after_min,
    capacity: svc.capacity,
    maxPartySize: svc.max_party_size,
    requiresStaff: svc.requires_staff,
    scheduleMode: svc.schedule_mode,
    slotIntervalMin: svc.slot_interval_min,
    minNoticeMin: svc.min_notice_min,
    maxAdvanceDays: svc.max_advance_days,
    locationIds: svcLocs.map((x) => x.location_id),
    staffIds,
    requirements: reqs.map((r) => ({ id: r.id, label: r.label, quantity: r.quantity, resourceIds: r.resource_ids })),
    fixedTimes: fixed.map((f) => ({ locationId: f.location_id, weekday: f.weekday, time: f.start_time.slice(0, 5) })),
  };
  const staff: EngineStaff[] = staffRows.map((s) => ({
    id: s.id,
    displayName: s.display_name,
    status: s.status,
    acceptsBookings: s.accepts_bookings,
    locationIds: s.location_ids,
    sortOrder: s.sort_order,
  }));
  const engineShifts: EngineShift[] = shifts.map((s) => ({
    staffId: s.staff_id,
    locationId: s.location_id,
    type: s.shift_type,
    start: s.starts_at,
    end: s.ends_at,
  }));
  const resources: EngineResource[] = resourceRows.map((r) => ({
    id: r.id,
    name: r.name,
    locationId: r.location_id,
    status: r.status,
    capacity: r.capacity,
    sortOrder: r.sort_order,
    hours: resHours.filter((h) => h.resource_id === r.id).map((h) => ({ weekday: h.weekday, start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5) })),
    blocks: resBlocks.filter((b) => b.resource_id === r.id).map((b) => ({ start: b.starts_at, end: b.ends_at })),
  }));
  const occupancies: EngineOccupancy[] = occRows.map((o) => ({
    id: o.id,
    locationId: o.location_id,
    serviceId: o.service_id,
    staffId: o.staff_id,
    start: o.starts_at,
    end: o.ends_at,
    blockStart: o.block_starts_at,
    blockEnd: o.block_ends_at,
    capacity: o.capacity,
    seatsTaken: o.seats_taken,
    resources: occRes.filter((r) => r.occupancy_id === o.id).map((r) => ({ resourceId: r.resource_id, units: r.units })),
  }));

  return {
    now: p.now,
    location: {
      id: loc.id,
      timezone: loc.timezone,
      status: loc.status,
      isPublic: loc.is_public,
      slotIntervalMin: loc.slot_interval_min,
      minNoticeMin: loc.min_notice_min,
      maxAdvanceDays: loc.max_advance_days,
      maxConcurrentSessions: loc.max_concurrent_sessions,
      hours: hours.map((h) => ({ weekday: h.weekday, open: h.open_time.slice(0, 5), close: h.close_time.slice(0, 5) })),
      exceptions: exceptions.map((e) => ({ date: e.date, kind: e.kind, open: e.open_time?.slice(0, 5) ?? null, close: e.close_time?.slice(0, 5) ?? null })),
      blocks: blocks.map((b) => ({ start: b.starts_at, end: b.ends_at })),
    },
    service,
    staff,
    shifts: engineShifts,
    occupancies,
    resources,
    travelBufferMin: travel,
    mode: p.mode,
    force: p.force ?? false,
    partySize: p.partySize ?? 1,
  };
}

/** 確定時にロックすべき対象(候補スタッフ・候補リソース)を取得 */
export async function lockTargets(q: Q, orgId: string, locationId: string, serviceId: string): Promise<{ staffIds: string[]; resourceIds: string[]; maxConcurrent: boolean }> {
  const staff = await q.many<{ staff_id: string }>('SELECT staff_id FROM service_staff WHERE organization_id = $1 AND service_id = $2', [orgId, serviceId]);
  const res = await q.many<{ resource_id: string }>(
    `SELECT o.resource_id FROM service_resource_options o
       JOIN service_resource_requirements r ON r.id = o.requirement_id
       JOIN resources x ON x.id = o.resource_id
      WHERE r.organization_id = $1 AND r.service_id = $2 AND x.location_id = $3`,
    [orgId, serviceId, locationId],
  );
  const loc = await q.maybeOne<{ max_concurrent_sessions: number | null }>(
    'SELECT max_concurrent_sessions FROM locations WHERE organization_id = $1 AND id = $2',
    [orgId, locationId],
  );
  return {
    staffIds: staff.map((s) => s.staff_id),
    resourceIds: [...new Set(res.map((r) => r.resource_id))],
    maxConcurrent: Boolean(loc?.max_concurrent_sessions),
  };
}
