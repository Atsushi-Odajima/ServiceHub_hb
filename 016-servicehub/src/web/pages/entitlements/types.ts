export interface PassCandidate {
  kind: 'pass';
  id: string;
  name: string;
  remaining: number;
  expiresOn: string | null;
}

export interface PlanCandidate {
  kind: 'plan';
  id: string;
  name: string;
  periodId: string | null;
  periodStart: string;
  periodEnd: string;
  remaining: number;
  endsOn: string | null;
}

export type Candidate = PassCandidate | PlanCandidate;

export interface EntitlementHint {
  kind: 'pass' | 'plan';
  id: string;
  name: string;
  remaining: number;
  until: string | null;
  expiringSoon: boolean;
}

export interface PassDto {
  id: string;
  customerId: string;
  customerName?: string;
  name: string;
  serviceIds: string[];
  allServices: boolean;
  startsOn: string;
  expiresOn: string | null;
  initialUses: number;
  remaining: number;
  status: 'active' | 'expired' | 'voided';
  usable: boolean;
  expiredByDate: boolean;
  memo: string | null;
  grantedAt: string;
  version: number;
}

export interface LedgerRow {
  id: string;
  type: string;
  delta: number;
  balanceAfter: number;
  bookingId: string | null;
  bookingCode: string | null;
  bookingStartsAt?: string | null;
  recordId?: string | null;
  reversesEntryId?: string | null;
  periodId?: string;
  reason: string | null;
  actor: string | null;
  at: string;
}

export interface PassDetail extends PassDto {
  ledger: LedgerRow[];
  ledgerSum: number;
  consistent: boolean;
}

export interface PlanDto {
  id: string;
  customerId: string;
  customerName?: string;
  name: string;
  usesPerPeriod: number;
  periodMonths: number;
  alignment: 'calendar' | 'anniversary';
  carryoverEnabled: boolean;
  serviceIds: string[];
  allServices: boolean;
  startsOn: string;
  endsOn: string | null;
  status: 'active' | 'ended' | 'canceled';
  memo: string | null;
  currentPeriod: { start: string; end: string; granted: number; used: number; remaining: number; materialized: boolean } | null;
  version: number;
}

export interface PlanDetail extends PlanDto {
  periods: { id: string; start: string; end: string; remaining: number; status: 'open' | 'closed'; consistent: boolean }[];
  ledger: LedgerRow[];
}

export interface PassProduct {
  id: string;
  name: string;
  description: string | null;
  totalUses: number;
  validityDays: number | null;
  allServices: boolean;
  serviceIds: string[];
  status: 'active' | 'inactive';
  sortOrder: number;
}

export interface PlanProduct {
  id: string;
  name: string;
  description: string | null;
  usesPerPeriod: number;
  periodMonths: number;
  alignment: 'calendar' | 'anniversary';
  carryoverEnabled: boolean;
  carryoverMax: number | null;
  allServices: boolean;
  serviceIds: string[];
  status: 'active' | 'inactive';
  sortOrder: number;
}

export const PASS_STATUS_LABELS: Record<PassDto['status'], { label: string; tone: string; icon: string }> = {
  active: { label: '有効', tone: 'success', icon: '●' },
  expired: { label: '期限切れ', tone: 'muted', icon: '○' },
  voided: { label: '無効化', tone: 'danger', icon: '×' },
};

export const PLAN_STATUS_LABELS: Record<PlanDto['status'], { label: string; tone: string; icon: string }> = {
  active: { label: '契約中', tone: 'success', icon: '●' },
  ended: { label: '終了', tone: 'muted', icon: '○' },
  canceled: { label: '解約', tone: 'danger', icon: '×' },
};

export function hintLabel(h: EntitlementHint): string {
  return `${h.name} 残${h.remaining}`;
}
