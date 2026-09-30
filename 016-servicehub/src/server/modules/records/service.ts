/**
 * 完了・実施記録(医療カルテではない。診断/治療の記録は前提としない)。
 * 完了・記録・消化は同じトランザクションで行い、消化エントリを実施記録に関連付ける。
 */
import { writeAudit } from '../../audit.js';
import type { Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { invalidState, notFound, versionConflict } from '../../errors.js';
import { type BookingActor, type BookingRow, loadBookingForUpdate, notifyChange } from '../bookings/service.js';
import { consumeForBooking, reverseConsumption, type LedgerEntry } from '../entitlements/ledger.js';

export interface RecordInput {
  startedAt?: Date | null;
  endedAt?: Date | null;
  durationMin?: number | null;
  internalMemo?: string | null;
  customerMemo?: string | null;
  nextRecommendedOn?: string | null;
  nextRecommendedNote?: string | null;
}

export interface CompleteInput {
  expectedVersion?: number;
  record?: RecordInput;
  consume?: { kind: 'pass' | 'plan'; entitlementId: string; idempotencyKey: string } | null;
}

export interface ServiceRecordRow {
  id: string;
  booking_id: string;
  customer_id: string;
  location_id: string;
  staff_id: string | null;
  service_id: string;
  service_snapshot: Record<string, unknown>;
  performed_at: Date;
  ended_at: Date | null;
  duration_min: number | null;
  internal_memo: string | null;
  customer_memo: string | null;
  next_recommended_on: string | null;
  next_recommended_note: string | null;
  next_booking_id: string | null;
  status: string;
  void_reason: string | null;
  voided_at: Date | null;
  version: number;
  created_at: Date;
}

async function addEvent(q: Q, b: BookingRow, a: BookingActor, type: string, from: string | null, to: string | null, data: Record<string, unknown> = {}) {
  await q.exec(
    `INSERT INTO booking_events (organization_id, booking_id, customer_id, event_type, from_status, to_status, data, actor_type, actor_membership_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.organization_id, b.id, b.customer_id, type, from, to, JSON.stringify(data), a.actor.type, a.membershipId, a.actor.label ?? null],
  );
}

async function refreshVisits(q: Q, orgId: string, customerId: string): Promise<void> {
  await q.exec(
    `UPDATE customers c SET
        first_visit_at = (SELECT min(starts_at) FROM bookings b WHERE b.organization_id = c.organization_id AND b.customer_id = c.id AND b.status = 'completed'),
        last_visit_at = (SELECT max(starts_at) FROM bookings b WHERE b.organization_id = c.organization_id AND b.customer_id = c.id AND b.status = 'completed')
      WHERE c.organization_id = $1 AND c.id = $2`,
    [orgId, customerId],
  );
}

export async function completeBooking(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor & { canWriteRecord: boolean; canConsume: boolean },
  bookingId: string,
  input: CompleteInput,
): Promise<{ booking: BookingRow; recordId: string; consumption: LedgerEntry | null }> {
  const b = await loadBookingForUpdate(q, orgId, bookingId);
  if (input.expectedVersion !== undefined && b.version !== input.expectedVersion) throw versionConflict();
  if (!['confirmed', 'arrived', 'in_service'].includes(b.status)) throw invalidState('この予約は完了にできる状態ではありません');
  const now = deps.clock.now();
  const r = input.record ?? {};
  const performedAt = r.startedAt ?? b.service_started_at ?? b.arrived_at ?? b.starts_at;
  const endedAt = r.endedAt ?? now;
  const duration = r.durationMin ?? (Number(b.service_snapshot?.durationMin) || null);
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET status = 'completed', completed_at = $3,
            arrived_at = coalesce(arrived_at, service_started_at, $4), service_started_at = coalesce(service_started_at, $4),
            version = version + 1
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, bookingId, now, performedAt],
  );
  const rec = await q.one<{ id: string }>(
    `INSERT INTO service_records (organization_id, booking_id, customer_id, location_id, staff_id, service_id, service_snapshot, performed_at, ended_at,
                                  duration_min, internal_memo, customer_memo, next_recommended_on, next_recommended_note, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      orgId,
      b.id,
      b.customer_id,
      b.location_id,
      b.staff_id,
      b.service_id,
      JSON.stringify(b.service_snapshot),
      performedAt,
      endedAt,
      duration,
      a.canWriteRecord ? (r.internalMemo ?? null) : null,
      a.canWriteRecord ? (r.customerMemo ?? null) : null,
      a.canWriteRecord ? (r.nextRecommendedOn ?? null) : null,
      a.canWriteRecord ? (r.nextRecommendedNote ?? null) : null,
      a.membershipId,
    ],
  );
  await refreshVisits(q, orgId, b.customer_id);
  await addEvent(q, updated, a, 'completed', b.status, 'completed', { recordId: rec.id });
  await writeAudit(q, orgId, a.actor, {
    action: 'booking.completed',
    targetType: 'booking',
    targetId: b.id,
    locationId: b.location_id,
    before: { status: b.status },
    after: { status: 'completed', recordId: rec.id },
    requestId: a.requestId,
  });
  let consumption: LedgerEntry | null = null;
  if (input.consume) {
    if (!a.canConsume) throw invalidState('回数券/プランを消化する権限がありません');
    const res = await consumeForBooking(q, orgId, a.actor, {
      bookingId: b.id,
      kind: input.consume.kind,
      entitlementId: input.consume.entitlementId,
      idempotencyKey: input.consume.idempotencyKey,
      requestId: a.requestId,
    });
    consumption = res.entry;
  }
  await notifyChange(q, orgId, b.location_id, 'booking', b.id);
  const final = await q.one<BookingRow>('SELECT * FROM bookings WHERE organization_id = $1 AND id = $2', [orgId, b.id]);
  return { booking: final, recordId: rec.id, consumption };
}

export async function updateRecord(q: Q, orgId: string, a: BookingActor, recordId: string, expectedVersion: number, r: RecordInput): Promise<ServiceRecordRow> {
  const cur = await q.maybeOne<ServiceRecordRow>('SELECT * FROM service_records WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, recordId]);
  if (!cur) throw notFound('実施記録');
  if (cur.status !== 'active') throw invalidState('取消済みの実施記録は編集できません');
  if (cur.version !== expectedVersion) throw versionConflict();
  const next = {
    performed_at: r.startedAt ?? cur.performed_at,
    ended_at: r.endedAt !== undefined ? r.endedAt : cur.ended_at,
    duration_min: r.durationMin !== undefined ? r.durationMin : cur.duration_min,
    internal_memo: r.internalMemo !== undefined ? r.internalMemo : cur.internal_memo,
    customer_memo: r.customerMemo !== undefined ? r.customerMemo : cur.customer_memo,
    next_recommended_on: r.nextRecommendedOn !== undefined ? r.nextRecommendedOn : cur.next_recommended_on,
    next_recommended_note: r.nextRecommendedNote !== undefined ? r.nextRecommendedNote : cur.next_recommended_note,
  };
  const updated = await q.one<ServiceRecordRow>(
    `UPDATE service_records SET performed_at=$3, ended_at=$4, duration_min=$5, internal_memo=$6, customer_memo=$7, next_recommended_on=$8,
            next_recommended_note=$9, version = version + 1
      WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, recordId, next.performed_at, next.ended_at, next.duration_min, next.internal_memo, next.customer_memo, next.next_recommended_on, next.next_recommended_note],
  );
  await writeAudit(q, orgId, a.actor, {
    action: 'record.updated',
    targetType: 'service_record',
    targetId: recordId,
    locationId: cur.location_id,
    after: { internalMemo: r.internalMemo, customerMemo: r.customerMemo, nextRecommendedOn: next.next_recommended_on, durationMin: next.duration_min },
    requestId: a.requestId,
  });
  return updated;
}

/** 実施取消: 予約を「対応中」に戻す。消化がある場合は戻す/戻さないを明示(履歴化) */
export async function voidRecord(
  q: Q,
  deps: Deps,
  orgId: string,
  a: BookingActor,
  recordId: string,
  input: { reason: string; reverseConsumption: boolean },
): Promise<{ reversed: boolean }> {
  const rec = await q.maybeOne<ServiceRecordRow>('SELECT * FROM service_records WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, recordId]);
  if (!rec) throw notFound('実施記録');
  if (rec.status !== 'active') throw invalidState('すでに取消されています');
  const b = await loadBookingForUpdate(q, orgId, rec.booking_id);
  await q.exec(`UPDATE service_records SET status = 'voided', voided_at = $3, voided_by_membership_id = $4, void_reason = $5, version = version + 1 WHERE organization_id = $1 AND id = $2`, [
    orgId,
    recordId,
    deps.clock.now(),
    a.membershipId,
    input.reason,
  ]);
  let reversed = false;
  if (b.consumption_entry_id) {
    if (input.reverseConsumption) {
      await reverseConsumption(q, orgId, a.actor, { bookingId: b.id, reason: `実施取消: ${input.reason}`, requestId: a.requestId });
      reversed = true;
    } else {
      await writeAudit(q, orgId, a.actor, {
        action: 'record.void_kept_consumption',
        targetType: 'booking',
        targetId: b.id,
        locationId: b.location_id,
        metadata: { reason: input.reason, entryId: b.consumption_entry_id },
        requestId: a.requestId,
      });
    }
  }
  const updated = await q.one<BookingRow>(
    `UPDATE bookings SET status = 'in_service', completed_at = NULL, version = version + 1 WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [orgId, b.id],
  );
  await refreshVisits(q, orgId, b.customer_id);
  await addEvent(q, updated, a, 'status_reverted', 'completed', 'in_service', { recordVoided: recordId, consumptionReversed: reversed });
  await writeAudit(q, orgId, a.actor, {
    action: 'record.voided',
    targetType: 'service_record',
    targetId: recordId,
    locationId: b.location_id,
    metadata: { reason: input.reason, consumptionReversed: reversed },
    requestId: a.requestId,
  });
  await notifyChange(q, orgId, b.location_id, 'booking', b.id);
  return { reversed };
}
