import type { Q } from '../db/tx.js';

export interface EnqueueInput {
  orgId: string;
  type: string;
  recipient?: string | null;
  customerId?: string | null;
  bookingId?: string | null;
  locationId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  nextAttemptAt?: Date;
}

/**
 * 通知を送信箱へ登録する(業務トランザクション内で呼ぶ)。
 * 同じ冪等キーは二度登録されない(ON CONFLICT DO NOTHING)。登録されたら true。
 */
export async function enqueueNotification(q: Q, input: EnqueueInput): Promise<boolean> {
  const noRecipient = !input.recipient;
  const n = await q.exec(
    `INSERT INTO notifications (organization_id, type, recipient, customer_id, booking_id, location_id, payload,
                                idempotency_key, status, skip_reason, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [
      input.orgId,
      input.type,
      input.recipient ?? null,
      input.customerId ?? null,
      input.bookingId ?? null,
      input.locationId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey,
      noRecipient ? 'skipped' : 'pending',
      noRecipient ? 'no_recipient' : null,
      input.nextAttemptAt ?? null,
    ],
  );
  return n > 0;
}
