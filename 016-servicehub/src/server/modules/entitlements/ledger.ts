/**
 * 回数券・期間利用プランの台帳操作(PASS_LEDGER.md / PLAN_USAGE_RULES.md)。
 * - 残数は台帳 INSERT のトリガでのみ変化(直接 UPDATE は DB が拒否)
 * - すべての操作は冪等キー付き。同じキーの再送は既存エントリを返す
 * - 1予約につき有効な消化は1件(bookings.consumption_entry_id を行ロック下で確認)
 */
import { addDays, localDateOf, todayIn } from '../../../shared/time.js';
import { type Actor, writeAudit } from '../../audit.js';
import { advisoryLockAll, type Q } from '../../db/tx.js';
import { AppError, invalidState, notFound } from '../../errors.js';
import { notifyChange } from '../bookings/service.js';
import { eligiblePasses, eligiblePlans } from './eligibility.js';
import { nextPeriod, periodContaining, type PeriodRange, type PlanSnapshot } from '../plans/periods.js';

export interface LedgerEntry {
  id: string;
  entry_type: string;
  delta: number;
  balance_after: number;
  created_at: Date;
}

export interface PassSnapshot {
  name: string;
  totalUses: number;
  validityDays: number | null;
  allServices: boolean;
  serviceIds: string[];
}

function actorCols(a: Actor): [string, string | null, string | null] {
  return [a.type === 'customer' ? 'system' : a.type, a.membershipId ?? null, a.label ?? null];
}

async function existingPassEntry(q: Q, orgId: string, key: string): Promise<LedgerEntry | null> {
  return q.maybeOne<LedgerEntry>(
    'SELECT id, entry_type, delta, balance_after, created_at FROM pass_ledger_entries WHERE organization_id = $1 AND idempotency_key = $2',
    [orgId, key],
  );
}

async function existingPlanEntry(q: Q, orgId: string, key: string): Promise<LedgerEntry | null> {
  return q.maybeOne<LedgerEntry>(
    'SELECT id, entry_type, delta, balance_after, created_at FROM plan_ledger_entries WHERE organization_id = $1 AND idempotency_key = $2',
    [orgId, key],
  );
}

async function insertPassEntry(
  q: Q,
  orgId: string,
  a: Actor,
  e: { passId: string; type: string; delta: number; bookingId?: string | null; recordId?: string | null; reverses?: string | null; reason?: string | null; key: string },
): Promise<LedgerEntry> {
  const [actorType, membershipId, label] = actorCols(a);
  try {
    return await q.one<LedgerEntry>(
      `INSERT INTO pass_ledger_entries (organization_id, customer_pass_id, entry_type, delta, booking_id, service_record_id, reverses_entry_id,
                                        reason, actor_type, actor_membership_id, actor_label, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, entry_type, delta, balance_after, created_at`,
      [orgId, e.passId, e.type, e.delta, e.bookingId ?? null, e.recordId ?? null, e.reverses ?? null, e.reason ?? null, actorType, membershipId, label, e.key],
    );
  } catch (err) {
    if (String((err as Error).message).includes('PASS_BALANCE_NEGATIVE')) {
      throw new AppError('INSUFFICIENT_BALANCE', '回数券の残回数が足りません');
    }
    throw err;
  }
}

async function insertPlanEntry(
  q: Q,
  orgId: string,
  a: Actor,
  e: { planId: string; periodId: string; type: string; delta: number; bookingId?: string | null; recordId?: string | null; reverses?: string | null; reason?: string | null; key: string },
): Promise<LedgerEntry> {
  const [actorType, membershipId, label] = actorCols(a);
  try {
    return await q.one<LedgerEntry>(
      `INSERT INTO plan_ledger_entries (organization_id, customer_plan_id, customer_plan_period_id, entry_type, delta, booking_id, service_record_id,
                                        reverses_entry_id, reason, actor_type, actor_membership_id, actor_label, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, entry_type, delta, balance_after, created_at`,
      [orgId, e.planId, e.periodId, e.type, e.delta, e.bookingId ?? null, e.recordId ?? null, e.reverses ?? null, e.reason ?? null, actorType, membershipId, label, e.key],
    );
  } catch (err) {
    if (String((err as Error).message).includes('PLAN_BALANCE_NEGATIVE')) {
      throw new AppError('INSUFFICIENT_BALANCE', '利用プランの残り回数が足りません');
    }
    throw err;
  }
}

// ============================ 回数券 ============================

export async function grantPass(
  q: Q,
  orgId: string,
  a: Actor,
  input: { customerId: string; passProductId: string; startsOn: string; memo?: string | null; idempotencyKey: string; requestId?: string },
): Promise<{ passId: string; created: boolean }> {
  await advisoryLockAll(q, [`ledger-idem:${orgId}:${input.idempotencyKey}`]);
  const prior = await existingPassEntry(q, orgId, input.idempotencyKey);
  if (prior) {
    const p = await q.one<{ customer_pass_id: string }>('SELECT customer_pass_id FROM pass_ledger_entries WHERE id = $1', [prior.id]);
    return { passId: p.customer_pass_id, created: false };
  }
  const c = await q.maybeOne<{ status: string }>('SELECT status FROM customers WHERE organization_id = $1 AND id = $2', [orgId, input.customerId]);
  if (!c) throw notFound('顧客');
  if (c.status !== 'active') throw invalidState('有効な顧客にのみ付与できます');
  const prod = await q.maybeOne<{ name: string; total_uses: number; validity_days: number | null; all_services: boolean; status: string; service_ids: string[] }>(
    `SELECT p.name, p.total_uses, p.validity_days, p.all_services, p.status,
            coalesce((SELECT array_agg(service_id::text ORDER BY service_id::text) FROM pass_product_services s WHERE s.pass_product_id = p.id), '{}') AS service_ids
       FROM pass_products p WHERE p.organization_id = $1 AND p.id = $2`,
    [orgId, input.passProductId],
  );
  if (!prod) throw notFound('回数券の種類');
  if (prod.status !== 'active') throw invalidState('この回数券は現在付与できません(無効)');
  const snapshot: PassSnapshot = {
    name: prod.name,
    totalUses: prod.total_uses,
    validityDays: prod.validity_days,
    allServices: prod.all_services,
    serviceIds: prod.service_ids,
  };
  const expiresOn = prod.validity_days ? addDays(input.startsOn, prod.validity_days - 1) : null;
  const pass = await q.one<{ id: string }>(
    `INSERT INTO customer_passes (organization_id, customer_id, pass_product_id, product_snapshot, starts_on, expires_on, initial_uses, memo, granted_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, input.customerId, input.passProductId, JSON.stringify(snapshot), input.startsOn, expiresOn, prod.total_uses, input.memo ?? null, a.membershipId ?? null],
  );
  await insertPassEntry(q, orgId, a, { passId: pass.id, type: 'grant', delta: prod.total_uses, reason: '付与', key: input.idempotencyKey });
  await writeAudit(q, orgId, a, {
    action: 'pass.granted',
    targetType: 'customer_pass',
    targetId: pass.id,
    after: { customerId: input.customerId, product: prod.name, uses: prod.total_uses, startsOn: input.startsOn, expiresOn },
    requestId: input.requestId,
  });
  return { passId: pass.id, created: true };
}

export async function adjustPass(
  q: Q,
  orgId: string,
  a: Actor,
  input: { passId: string; type: 'manual_add' | 'manual_subtract' | 'correction'; delta: number; reason: string; idempotencyKey: string; requestId?: string },
): Promise<LedgerEntry> {
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', '理由を入力してください', { fields: { reason: '必須です' } });
  if (input.delta === 0) throw new AppError('VALIDATION_ERROR', '増減は0以外にしてください');
  const delta = input.type === 'manual_add' ? Math.abs(input.delta) : input.type === 'manual_subtract' ? -Math.abs(input.delta) : input.delta;
  await advisoryLockAll(q, [`ledger-idem:${orgId}:${input.idempotencyKey}`]);
  const prior = await existingPassEntry(q, orgId, input.idempotencyKey);
  if (prior) return prior;
  const p = await q.maybeOne<{ status: string }>('SELECT status FROM customer_passes WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, input.passId]);
  if (!p) throw notFound('回数券');
  if (p.status === 'voided') throw invalidState('無効化された回数券は調整できません');
  // 失効済みでも訂正は台帳に記録できる(再利用するには有効期限の変更で再有効化する)
  const e = await insertPassEntry(q, orgId, a, { passId: input.passId, type: input.type, delta, reason: input.reason, key: input.idempotencyKey });
  await writeAudit(q, orgId, a, {
    action: 'pass.adjusted',
    targetType: 'customer_pass',
    targetId: input.passId,
    after: { type: input.type, delta, balance: e.balance_after },
    metadata: { reason: input.reason },
    requestId: input.requestId,
  });
  return e;
}

/** 有効期限の変更(延長/短縮)。失効済みを再有効化する場合は訂正で回数を戻してから */
export async function changePassExpiry(q: Q, orgId: string, a: Actor, input: { passId: string; expiresOn: string | null; reactivate?: boolean; requestId?: string }): Promise<void> {
  const p = await q.maybeOne<{ status: string; starts_on: string; expires_on: string | null; remaining: number }>(
    'SELECT status, starts_on, expires_on, remaining FROM customer_passes WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, input.passId],
  );
  if (!p) throw notFound('回数券');
  if (p.status === 'voided') throw invalidState('無効化された回数券は変更できません');
  if (input.expiresOn && input.expiresOn < p.starts_on) throw new AppError('VALIDATION_ERROR', '有効期限は開始日以降にしてください');
  const nextStatus = p.status === 'expired' && input.reactivate ? 'active' : p.status;
  await q.exec('UPDATE customer_passes SET expires_on = $3, status = $4, version = version + 1 WHERE organization_id = $1 AND id = $2', [
    orgId,
    input.passId,
    input.expiresOn,
    nextStatus,
  ]);
  await writeAudit(q, orgId, a, {
    action: 'pass.expiry_changed',
    targetType: 'customer_pass',
    targetId: input.passId,
    before: { expiresOn: p.expires_on, status: p.status },
    after: { expiresOn: input.expiresOn, status: nextStatus },
    requestId: input.requestId,
  });
}

export async function voidPass(q: Q, orgId: string, a: Actor, input: { passId: string; reason: string; requestId?: string }): Promise<void> {
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', '理由を入力してください');
  const p = await q.maybeOne<{ status: string; remaining: number }>('SELECT status, remaining FROM customer_passes WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, input.passId]);
  if (!p) throw notFound('回数券');
  if (p.status === 'voided') return;
  if (p.remaining > 0) {
    await insertPassEntry(q, orgId, a, { passId: input.passId, type: 'correction', delta: -p.remaining, reason: `無効化: ${input.reason}`, key: `void:${input.passId}` });
  }
  await q.exec(`UPDATE customer_passes SET status = 'voided', version = version + 1 WHERE organization_id = $1 AND id = $2`, [orgId, input.passId]);
  await writeAudit(q, orgId, a, { action: 'pass.voided', targetType: 'customer_pass', targetId: input.passId, metadata: { reason: input.reason, removed: p.remaining }, requestId: input.requestId });
}

/** 失効(日次ジョブ): 期限を過ぎた active 回数券の残数を expire で0にし status=expired */
export async function expirePasses(q: Q, orgId: string, today: string): Promise<number> {
  const rows = await q.many<{ id: string; remaining: number; expires_on: string }>(
    `SELECT id, remaining, expires_on FROM customer_passes
      WHERE organization_id = $1 AND status = 'active' AND expires_on IS NOT NULL AND expires_on < $2::date
      ORDER BY expires_on LIMIT 1000 FOR UPDATE SKIP LOCKED`,
    [orgId, today],
  );
  const system: Actor = { type: 'system', label: '自動失効' };
  for (const r of rows) {
    const key = `expire:${r.id}:${r.expires_on}`;
    if (r.remaining > 0 && !(await existingPassEntry(q, orgId, key))) {
      await insertPassEntry(q, orgId, system, { passId: r.id, type: 'expire', delta: -r.remaining, reason: `有効期限(${r.expires_on})切れ`, key });
    }
    await q.exec(`UPDATE customer_passes SET status = 'expired', version = version + 1 WHERE organization_id = $1 AND id = $2`, [orgId, r.id]);
    await writeAudit(q, orgId, system, { action: 'pass.expired', targetType: 'customer_pass', targetId: r.id, metadata: { expiresOn: r.expires_on, removed: r.remaining } });
  }
  return rows.length;
}

// ============================ 利用プラン ============================

export async function assignPlan(
  q: Q,
  orgId: string,
  a: Actor,
  input: { customerId: string; planProductId: string; startsOn: string; endsOn?: string | null; memo?: string | null; idempotencyKey: string; requestId?: string },
): Promise<{ planId: string; created: boolean }> {
  await advisoryLockAll(q, [`plan-assign:${orgId}:${input.idempotencyKey}`]);
  const prior = await q.maybeOne<{ id: string }>(
    `SELECT id FROM customer_plans WHERE organization_id = $1 AND product_snapshot->>'assignKey' = $2`,
    [orgId, input.idempotencyKey],
  );
  if (prior) return { planId: prior.id, created: false };
  const c = await q.maybeOne<{ status: string }>('SELECT status FROM customers WHERE organization_id = $1 AND id = $2', [orgId, input.customerId]);
  if (!c) throw notFound('顧客');
  if (c.status !== 'active') throw invalidState('有効な顧客にのみ契約できます');
  if (input.endsOn && input.endsOn < input.startsOn) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください');
  const prod = await q.maybeOne<{
    name: string;
    uses_per_period: number;
    period_months: number;
    alignment: 'calendar' | 'anniversary';
    carryover_enabled: boolean;
    carryover_max: number | null;
    all_services: boolean;
    status: string;
    service_ids: string[];
  }>(
    `SELECT p.*, coalesce((SELECT array_agg(service_id::text ORDER BY service_id::text) FROM plan_product_services s WHERE s.plan_product_id = p.id), '{}') AS service_ids
       FROM plan_products p WHERE p.organization_id = $1 AND p.id = $2`,
    [orgId, input.planProductId],
  );
  if (!prod) throw notFound('利用プランの種類');
  if (prod.status !== 'active') throw invalidState('この利用プランは現在契約できません(無効)');
  const snapshot: PlanSnapshot & { assignKey: string } = {
    name: prod.name,
    usesPerPeriod: prod.uses_per_period,
    periodMonths: prod.period_months,
    alignment: prod.alignment,
    carryoverEnabled: prod.carryover_enabled,
    carryoverMax: prod.carryover_max,
    allServices: prod.all_services,
    serviceIds: prod.service_ids,
    assignKey: input.idempotencyKey,
  };
  const plan = await q.one<{ id: string }>(
    `INSERT INTO customer_plans (organization_id, customer_id, plan_product_id, product_snapshot, starts_on, ends_on, memo, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, input.customerId, input.planProductId, JSON.stringify(snapshot), input.startsOn, input.endsOn ?? null, input.memo ?? null, a.membershipId ?? null],
  );
  await writeAudit(q, orgId, a, {
    action: 'plan.assigned',
    targetType: 'customer_plan',
    targetId: plan.id,
    after: { customerId: input.customerId, product: prod.name, usesPerPeriod: prod.uses_per_period, startsOn: input.startsOn, endsOn: input.endsOn ?? null },
    requestId: input.requestId,
  });
  return { planId: plan.id, created: true };
}

interface PlanRow {
  id: string;
  customer_id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  product_snapshot: PlanSnapshot;
}

/** 利用日を含む期間を取得(無ければ作成して grant +N)。冪等 */
export async function ensurePeriod(q: Q, orgId: string, plan: PlanRow, date: string): Promise<{ id: string; range: PeriodRange } | null> {
  const range = periodContaining(plan.product_snapshot, plan.starts_on, plan.ends_on, date);
  if (!range) return null;
  const existing = await q.maybeOne<{ id: string }>(
    'SELECT id FROM customer_plan_periods WHERE organization_id = $1 AND customer_plan_id = $2 AND period_start = $3',
    [orgId, plan.id, range.start],
  );
  if (existing) return { id: existing.id, range };
  await advisoryLockAll(q, [`plan-period:${plan.id}:${range.start}`]);
  const again = await q.maybeOne<{ id: string }>(
    'SELECT id FROM customer_plan_periods WHERE organization_id = $1 AND customer_plan_id = $2 AND period_start = $3',
    [orgId, plan.id, range.start],
  );
  if (again) return { id: again.id, range };
  const p = await q.one<{ id: string }>(
    `INSERT INTO customer_plan_periods (organization_id, customer_plan_id, period_start, period_end) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, plan.id, range.start, range.end],
  );
  await insertPlanEntry(q, orgId, { type: 'system', label: '期間付与' }, {
    planId: plan.id,
    periodId: p.id,
    type: 'grant',
    delta: plan.product_snapshot.usesPerPeriod,
    reason: `${range.start}〜${range.end} の利用枠`,
    key: `plan_grant:${p.id}`,
  });
  return { id: p.id, range };
}

export async function adjustPlan(
  q: Q,
  orgId: string,
  a: Actor,
  input: { planId: string; date: string; type: 'manual_add' | 'manual_subtract' | 'correction'; delta: number; reason: string; idempotencyKey: string; requestId?: string },
): Promise<LedgerEntry> {
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', '理由を入力してください', { fields: { reason: '必須です' } });
  if (input.delta === 0) throw new AppError('VALIDATION_ERROR', '増減は0以外にしてください');
  const delta = input.type === 'manual_add' ? Math.abs(input.delta) : input.type === 'manual_subtract' ? -Math.abs(input.delta) : input.delta;
  await advisoryLockAll(q, [`ledger-idem:${orgId}:${input.idempotencyKey}`]);
  const prior = await existingPlanEntry(q, orgId, input.idempotencyKey);
  if (prior) return prior;
  const plan = await q.maybeOne<PlanRow>('SELECT id, customer_id, status, starts_on, ends_on, product_snapshot FROM customer_plans WHERE organization_id = $1 AND id = $2 FOR UPDATE', [
    orgId,
    input.planId,
  ]);
  if (!plan) throw notFound('利用プラン');
  const period = await ensurePeriod(q, orgId, plan, input.date);
  if (!period) throw new AppError('VALIDATION_ERROR', '指定日は契約期間外です');
  const e = await insertPlanEntry(q, orgId, a, { planId: plan.id, periodId: period.id, type: input.type, delta, reason: input.reason, key: input.idempotencyKey });
  await writeAudit(q, orgId, a, {
    action: 'plan.adjusted',
    targetType: 'customer_plan',
    targetId: plan.id,
    after: { type: input.type, delta, balance: e.balance_after, period: period.range },
    metadata: { reason: input.reason },
    requestId: input.requestId,
  });
  return e;
}

/**
 * 契約の終了(PLAN_USAGE_RULES.md §7)。
 * - ended: 終了日まで利用可。終了日が今日より前なら即 ended、それ以外は日次ジョブが終了日の翌日に ended にする
 * - canceled: 即時に利用停止(解約)
 * 終了日は短縮のみ(延長は新しい契約として登録)。終了日より後に始まる期間の残りは失効し、終了日をまたぐ期間は終了日で打ち切る。
 */
export async function endPlan(
  q: Q,
  orgId: string,
  a: Actor,
  input: { planId: string; endsOn: string; status: 'ended' | 'canceled'; today: string; reason?: string | null; requestId?: string },
): Promise<{ status: string }> {
  const plan = await q.maybeOne<{ status: string; starts_on: string; ends_on: string | null }>(
    'SELECT status, starts_on, ends_on FROM customer_plans WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, input.planId],
  );
  if (!plan) throw notFound('利用プラン');
  if (plan.status !== 'active') throw invalidState('この契約はすでに終了しています');
  if (input.endsOn < plan.starts_on) throw new AppError('VALIDATION_ERROR', '終了日は開始日以降にしてください', { fields: { endsOn: '開始日以降にしてください' } });
  if (plan.ends_on && input.endsOn > plan.ends_on) {
    throw new AppError('VALIDATION_ERROR', '終了日を延ばすことはできません。延長する場合は新しい契約を登録してください', { fields: { endsOn: '現在の終了日以前にしてください' } });
  }
  const status = input.status === 'canceled' || input.endsOn < input.today ? input.status : 'active';
  await q.exec(`UPDATE customer_plans SET ends_on = $3, status = $4, version = version + 1 WHERE organization_id = $1 AND id = $2`, [orgId, input.planId, input.endsOn, status]);
  const system: Actor = { type: 'system', label: '契約終了' };
  // 終了日より後に始まる期間: 残りを失効して閉じる
  const later = await q.many<{ id: string; remaining: number }>(
    `SELECT id, remaining FROM customer_plan_periods
      WHERE organization_id = $1 AND customer_plan_id = $2 AND status = 'open' AND period_start > $3::date FOR UPDATE`,
    [orgId, input.planId, input.endsOn],
  );
  for (const p of later) {
    if (p.remaining > 0) {
      await insertPlanEntry(q, orgId, system, { planId: input.planId, periodId: p.id, type: 'expire', delta: -p.remaining, reason: `契約終了(${input.endsOn})`, key: `plan_end:${p.id}` });
    }
    await q.exec(`UPDATE customer_plan_periods SET status = 'closed', closed_at = now() WHERE organization_id = $1 AND id = $2`, [orgId, p.id]);
  }
  // 終了日をまたぐ期間は終了日で打ち切る(締めは日次ジョブ)
  await q.exec(
    `UPDATE customer_plan_periods SET period_end = $3 WHERE organization_id = $1 AND customer_plan_id = $2 AND period_start <= $3::date AND period_end > $3::date`,
    [orgId, input.planId, input.endsOn],
  );
  await writeAudit(q, orgId, a, {
    action: input.status === 'canceled' ? 'plan.canceled' : 'plan.ended',
    targetType: 'customer_plan',
    targetId: input.planId,
    before: { status: plan.status, endsOn: plan.ends_on },
    after: { status, endsOn: input.endsOn },
    metadata: { reason: input.reason ?? null, closedFuturePeriods: later.length },
    requestId: input.requestId,
  });
  return { status };
}

/** 期間締め(日次ジョブ): 終了した期間の残りを繰越(設定時)または失効 */
export async function closePlanPeriods(q: Q, orgId: string, today: string): Promise<number> {
  const rows = await q.many<{ id: string; customer_plan_id: string; period_start: string; period_end: string; remaining: number }>(
    `SELECT id, customer_plan_id, period_start, period_end, remaining FROM customer_plan_periods
      WHERE organization_id = $1 AND status = 'open' AND period_end < $2::date
      ORDER BY period_end LIMIT 1000 FOR UPDATE SKIP LOCKED`,
    [orgId, today],
  );
  const system: Actor = { type: 'system', label: '期間締め' };
  for (const r of rows) {
    const plan = await q.one<PlanRow>('SELECT id, customer_id, status, starts_on, ends_on, product_snapshot FROM customer_plans WHERE organization_id = $1 AND id = $2', [
      orgId,
      r.customer_plan_id,
    ]);
    let remaining = r.remaining;
    const snap = plan.product_snapshot;
    if (remaining > 0 && snap.carryoverEnabled && plan.status === 'active') {
      const next = nextPeriod(snap, plan.starts_on, plan.ends_on, { start: r.period_start, end: r.period_end, index: 0 });
      const carry = Math.min(remaining, snap.carryoverMax ?? remaining);
      if (next && carry > 0) {
        const target = await ensurePeriod(q, orgId, plan, next.start);
        if (target) {
          await insertPlanEntry(q, orgId, system, { planId: plan.id, periodId: r.id, type: 'carryover_out', delta: -carry, reason: `次期間へ繰越`, key: `plan_carry_out:${r.id}` });
          await insertPlanEntry(q, orgId, system, { planId: plan.id, periodId: target.id, type: 'carryover_in', delta: carry, reason: `前期間から繰越`, key: `plan_carry_in:${r.id}` });
          remaining -= carry;
        }
      }
    }
    if (remaining > 0) {
      await insertPlanEntry(q, orgId, system, { planId: plan.id, periodId: r.id, type: 'expire', delta: -remaining, reason: `${r.period_end} で期間終了`, key: `plan_close:${r.id}` });
    }
    await q.exec(`UPDATE customer_plan_periods SET status = 'closed', closed_at = now() WHERE organization_id = $1 AND id = $2`, [orgId, r.id]);
  }
  // 終了日を過ぎた契約は ended
  await q.exec(`UPDATE customer_plans SET status = 'ended', version = version + 1 WHERE organization_id = $1 AND status = 'active' AND ends_on IS NOT NULL AND ends_on < $2::date`, [
    orgId,
    today,
  ]);
  return rows.length;
}

// ============================ 消化・取消(回数券/プラン共通) ============================

export interface ConsumeInput {
  bookingId: string;
  kind: 'pass' | 'plan';
  entitlementId: string;
  idempotencyKey: string;
  reason?: string | null;
  requestId?: string;
}

/**
 * 予約1件につき1回消化する。完了済み、または締切後キャンセル/無断欠席で確認待ちの予約が対象。
 * 同じ冪等キーの再送は既存エントリを返す(二重タップでも1回)。
 */
export async function consumeForBooking(q: Q, orgId: string, a: Actor, input: ConsumeInput): Promise<{ entry: LedgerEntry; duplicate: boolean }> {
  await advisoryLockAll(q, [`ledger-idem:${orgId}:${input.idempotencyKey}`]);
  const prior = input.kind === 'pass' ? await existingPassEntry(q, orgId, input.idempotencyKey) : await existingPlanEntry(q, orgId, input.idempotencyKey);
  if (prior) return { entry: prior, duplicate: true };
  const b = await q.maybeOne<{
    id: string;
    customer_id: string;
    service_id: string;
    location_id: string;
    status: string;
    starts_at: Date;
    consumption_entry_id: string | null;
    consumption_review: string | null;
    location_snapshot: { timezone?: string };
  }>(
    `SELECT id, customer_id, service_id, location_id, status, starts_at, consumption_entry_id, consumption_review, location_snapshot
       FROM bookings WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, input.bookingId],
  );
  if (!b) throw notFound('予約');
  if (b.consumption_entry_id) throw invalidState('この予約ではすでに回数券/プランを消化しています');
  const reviewable = (b.status === 'canceled_customer' || b.status === 'no_show') && b.consumption_review === 'pending';
  if (b.status !== 'completed' && !reviewable) throw invalidState('完了した予約(または消化確認待ちの予約)のみ消化できます');
  const date = localDateOf(b.starts_at, b.location_snapshot?.timezone ?? 'Asia/Tokyo');
  const record = await q.maybeOne<{ id: string }>(`SELECT id FROM service_records WHERE organization_id = $1 AND booking_id = $2 AND status = 'active'`, [orgId, b.id]);
  let entry: LedgerEntry;
  if (input.kind === 'pass') {
    // 行ロックしてから候補判定(同じ回数券への同時消化で負にならない。最終的にはトリガでも検査)
    await q.exec('SELECT 1 FROM customer_passes WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, input.entitlementId]);
    const candidates = await eligiblePasses(q, orgId, b.customer_id, b.service_id, date);
    if (!candidates.some((c) => c.id === input.entitlementId)) {
      throw invalidState('この回数券はこの予約に使えません(期限切れ・残数なし・対象外サービス・他の顧客のいずれか)');
    }
    entry = await insertPassEntry(q, orgId, a, {
      passId: input.entitlementId,
      type: 'use',
      delta: -1,
      bookingId: b.id,
      recordId: record?.id ?? null,
      reason: input.reason ?? (reviewable ? '締切後キャンセル/無断欠席による消化' : null),
      key: input.idempotencyKey,
    });
  } else {
    const plan = await q.maybeOne<PlanRow>(
      'SELECT id, customer_id, status, starts_on, ends_on, product_snapshot FROM customer_plans WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [orgId, input.entitlementId],
    );
    if (!plan) throw notFound('利用プラン');
    const candidates = await eligiblePlans(q, orgId, b.customer_id, b.service_id, date);
    if (!candidates.some((c) => c.id === plan.id)) {
      throw invalidState('この利用プランはこの予約に使えません(期間外・残数なし・対象外サービス・他の顧客のいずれか)');
    }
    const period = await ensurePeriod(q, orgId, plan, date);
    if (!period) throw invalidState('利用日が契約期間外です');
    entry = await insertPlanEntry(q, orgId, a, {
      planId: plan.id,
      periodId: period.id,
      type: 'use',
      delta: -1,
      bookingId: b.id,
      recordId: record?.id ?? null,
      reason: input.reason ?? (reviewable ? '締切後キャンセル/無断欠席による消化' : null),
      key: input.idempotencyKey,
    });
  }
  await q.exec(
    `UPDATE bookings SET consumption_kind = $3, consumption_entry_id = $4,
            consumption_review = CASE WHEN consumption_review = 'pending' THEN 'consumed' ELSE consumption_review END, version = version + 1
      WHERE organization_id = $1 AND id = $2`,
    [orgId, b.id, input.kind, entry.id],
  );
  await writeAudit(q, orgId, a, {
    action: input.kind === 'pass' ? 'pass.consumed' : 'plan.consumed',
    targetType: input.kind === 'pass' ? 'customer_pass' : 'customer_plan',
    targetId: input.entitlementId,
    locationId: b.location_id,
    after: { bookingId: b.id, delta: -1, balance: entry.balance_after },
    metadata: reviewable ? { lateCancelOrNoShow: true, reason: input.reason ?? null } : undefined,
    requestId: input.requestId,
  });
  await notifyChange(q, orgId, b.location_id, 'booking', b.id);
  return { entry, duplicate: false };
}

/** 消化の取消戻し(+1)。予約の消化記録をクリアする */
export async function reverseConsumption(
  q: Q,
  orgId: string,
  a: Actor,
  input: { bookingId: string; reason: string; requestId?: string },
): Promise<LedgerEntry | null> {
  const b = await q.maybeOne<{ id: string; location_id: string; consumption_kind: 'pass' | 'plan' | null; consumption_entry_id: string | null }>(
    'SELECT id, location_id, consumption_kind, consumption_entry_id FROM bookings WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, input.bookingId],
  );
  if (!b) throw notFound('予約');
  if (!b.consumption_entry_id || !b.consumption_kind) return null;
  let entry: LedgerEntry;
  let targetId: string;
  if (b.consumption_kind === 'pass') {
    const orig = await q.one<{ customer_pass_id: string }>('SELECT customer_pass_id FROM pass_ledger_entries WHERE organization_id = $1 AND id = $2', [
      orgId,
      b.consumption_entry_id,
    ]);
    targetId = orig.customer_pass_id;
    const pass = await q.one<{ status: string }>('SELECT status FROM customer_passes WHERE organization_id = $1 AND id = $2 FOR UPDATE', [orgId, targetId]);
    // 無効化(返金等)した回数券へは戻さない。失効済みへは戻せる(使うには期限変更で再有効化)
    if (pass.status === 'voided') throw invalidState('無効化された回数券には戻せません。必要な場合は別の回数券で調整してください');
    const key = `reverse:${b.consumption_entry_id}`;
    entry =
      (await existingPassEntry(q, orgId, key)) ??
      (await insertPassEntry(q, orgId, a, { passId: orig.customer_pass_id, type: 'use_reversal', delta: 1, bookingId: b.id, reverses: b.consumption_entry_id, reason: input.reason, key }));
  } else {
    const orig = await q.one<{ customer_plan_id: string; customer_plan_period_id: string }>(
      'SELECT customer_plan_id, customer_plan_period_id FROM plan_ledger_entries WHERE organization_id = $1 AND id = $2',
      [orgId, b.consumption_entry_id],
    );
    targetId = orig.customer_plan_id;
    const key = `reverse:${b.consumption_entry_id}`;
    entry =
      (await existingPlanEntry(q, orgId, key)) ??
      (await insertPlanEntry(q, orgId, a, {
        planId: orig.customer_plan_id,
        periodId: orig.customer_plan_period_id,
        type: 'use_reversal',
        delta: 1,
        bookingId: b.id,
        reverses: b.consumption_entry_id,
        reason: input.reason,
        key,
      }));
  }
  await q.exec(
    `UPDATE bookings SET consumption_kind = NULL, consumption_entry_id = NULL,
            consumption_review = CASE WHEN consumption_review = 'consumed' THEN 'pending' ELSE consumption_review END, version = version + 1
      WHERE organization_id = $1 AND id = $2`,
    [orgId, b.id],
  );
  await writeAudit(q, orgId, a, {
    action: b.consumption_kind === 'pass' ? 'pass.use_reversed' : 'plan.use_reversed',
    targetType: b.consumption_kind === 'pass' ? 'customer_pass' : 'customer_plan',
    targetId,
    locationId: b.location_id,
    after: { bookingId: b.id, delta: 1, balance: entry.balance_after },
    metadata: { reason: input.reason },
    requestId: input.requestId,
  });
  await notifyChange(q, orgId, b.location_id, 'booking', b.id);
  return entry;
}

/** 締切後キャンセル/無断欠席の「消化しない」判断を記録 */
export async function waiveConsumption(q: Q, orgId: string, a: Actor, input: { bookingId: string; reason?: string | null; requestId?: string }): Promise<void> {
  const b = await q.maybeOne<{ consumption_review: string | null; location_id: string }>(
    'SELECT consumption_review, location_id FROM bookings WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, input.bookingId],
  );
  if (!b) throw notFound('予約');
  if (b.consumption_review !== 'pending') throw invalidState('消化確認待ちの予約ではありません');
  await q.exec(`UPDATE bookings SET consumption_review = 'waived', version = version + 1 WHERE organization_id = $1 AND id = $2`, [orgId, input.bookingId]);
  await writeAudit(q, orgId, a, {
    action: 'booking.consumption_waived',
    targetType: 'booking',
    targetId: input.bookingId,
    locationId: b.location_id,
    metadata: { reason: input.reason ?? null },
    requestId: input.requestId,
  });
}

/** 期限間近のお知らせ(日次ジョブ) */
export async function passExpiringNotices(q: Q, orgId: string, today: string, days: number, enqueue: (row: { passId: string; customerId: string; email: string | null; name: string; passName: string; remaining: number; expiresOn: string }) => Promise<boolean>): Promise<number> {
  if (days <= 0) return 0;
  const target = addDays(today, days);
  const rows = await q.many<{ id: string; customer_id: string; email: string | null; cname: string; pname: string; remaining: number; expires_on: string }>(
    `SELECT cp.id, cp.customer_id, c.email, c.name AS cname, cp.product_snapshot->>'name' AS pname, cp.remaining, cp.expires_on
       FROM customer_passes cp JOIN customers c ON c.id = cp.customer_id
      WHERE cp.organization_id = $1 AND cp.status = 'active' AND cp.remaining > 0 AND cp.expires_on BETWEEN $2::date AND $3::date
        AND c.status = 'active'`,
    [orgId, today, target],
  );
  let n = 0;
  for (const r of rows) {
    if (await enqueue({ passId: r.id, customerId: r.customer_id, email: r.email, name: r.cname, passName: r.pname, remaining: r.remaining, expiresOn: r.expires_on })) n++;
  }
  return n;
}

export { todayIn };
