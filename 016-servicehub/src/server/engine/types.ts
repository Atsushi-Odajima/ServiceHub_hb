import type { ShiftType } from '../../shared/constants.js';

export interface Interval {
  start: Date;
  end: Date;
}

export interface EngineLocation {
  id: string;
  timezone: string;
  status: string;
  isPublic: boolean;
  slotIntervalMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  maxConcurrentSessions: number | null;
  hours: { weekday: number; open: string; close: string }[];
  exceptions: { date: string; kind: 'closed' | 'special_hours'; open: string | null; close: string | null }[];
  blocks: Interval[];
}

export interface EngineRequirement {
  id: string;
  label: string;
  quantity: number;
  resourceIds: string[];
}

export interface EngineService {
  id: string;
  name: string;
  status: string;
  isBookable: boolean;
  isPublic: boolean;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  capacity: number;
  maxPartySize: number;
  requiresStaff: boolean;
  scheduleMode: 'flexible' | 'fixed';
  slotIntervalMin: number | null;
  minNoticeMin: number | null;
  maxAdvanceDays: number | null;
  locationIds: string[];
  staffIds: string[];
  requirements: EngineRequirement[];
  fixedTimes: { locationId: string; weekday: number; time: string }[];
}

export interface EngineStaff {
  id: string;
  displayName: string;
  status: string;
  acceptsBookings: boolean;
  locationIds: string[];
  sortOrder: number;
}

export interface EngineShift {
  staffId: string;
  locationId: string | null;
  type: ShiftType;
  start: Date;
  end: Date;
}

export interface EngineOccupancy {
  id: string;
  locationId: string;
  serviceId: string;
  staffId: string | null;
  start: Date;
  end: Date;
  blockStart: Date;
  blockEnd: Date;
  capacity: number;
  seatsTaken: number;
  resources: { resourceId: string; units: number }[];
}

export interface EngineResource {
  id: string;
  name: string;
  locationId: string;
  status: string;
  capacity: number;
  sortOrder: number;
  hours: { weekday: number; start: string; end: string }[];
  blocks: Interval[];
}

export interface EngineInput {
  now: Date;
  location: EngineLocation;
  service: EngineService;
  staff: EngineStaff[];
  shifts: EngineShift[];
  occupancies: EngineOccupancy[];
  resources: EngineResource[];
  travelBufferMin: number;
  /** public: 公開状態も検査 */
  mode: 'public' | 'staff';
  /** soft 制約を上書き(Owner/Manager の強制予約) */
  force: boolean;
  partySize: number;
}

export type ViolationCode =
  | 'LOCATION_INACTIVE'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_NOT_AT_LOCATION'
  | 'PARTY_SIZE'
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'LOCATION_BLOCKED'
  | 'TOO_SOON'
  | 'TOO_FAR'
  | 'IN_PAST'
  | 'STAFF_INVALID'
  | 'OUTSIDE_SHIFT'
  | 'STAFF_UNAVAILABLE'
  | 'STAFF_BUSY'
  | 'TRAVEL_TIME'
  | 'RESOURCE_UNAVAILABLE'
  | 'CAPACITY_FULL'
  | 'MAX_CONCURRENT'
  | 'NOT_FIXED_TIME';

export interface Violation {
  code: ViolationCode;
  hard: boolean;
  message: string;
}

export interface ResourceAllocation {
  requirementId: string;
  resourceId: string;
  units: number;
}

export interface StaffOption {
  staffId: string | null;
  joinOccupancyId: string | null;
  /** この予約の前の空き席数(定員 − 既存の予約人数) */
  seatsAvailable: number;
  resourceAllocations: ResourceAllocation[];
}

export interface EvaluateResult {
  ok: boolean;
  start: Date;
  end: Date;
  blockStart: Date;
  blockEnd: Date;
  option: StaffOption | null;
  violations: Violation[];
  /** おまかせ時に評価した各スタッフの結果 */
  perStaff?: { staffId: string; violations: Violation[] }[];
}

export interface Slot {
  start: Date;
  end: Date;
  options: StaffOption[];
  seatsAvailable: number;
}
