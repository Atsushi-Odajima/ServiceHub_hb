/**
 * 占有(スタッフ/リソースの時間確保)の確保・解放。予約の作成/変更/復元はすべてここを通す(ロック順序の一元化)。
 * BOOKING_ENGINE.md §5 参照。
 */
import { evaluateStart } from '../../engine/availability.js';
import { loadEngineInput, lockTargets } from '../../engine/loader.js';
import type { EvaluateResult, Violation } from '../../engine/types.js';
import { advisoryLockAll, type Q } from '../../db/tx.js';
import { AppError } from '../../errors.js';

export interface AllocateParams {
  orgId: string;
  locationId: string;
  serviceId: string;
  /** スタッフID / 'auto'(おまかせ) / null(スタッフ不要サービス) */
  staffChoice: string | 'auto' | null;
  start: Date;
  partySize: number;
  mode: 'public' | 'staff';
  force: boolean;
  now: Date;
  /** 変更時: 事前に解放する旧占有 */
  release?: { occupancyId: string; partySize: number } | null;
}

export interface AllocationResult {
  occupancyId: string;
  staffId: string | null;
  joined: boolean;
  start: Date;
  end: Date;
  blockStart: Date;
  blockEnd: Date;
  violationsOverridden: Violation[];
}

export class SlotUnavailableError extends AppError {
  constructor(public readonly violations: Violation[], publicMode: boolean) {
    super(
      'SLOT_UNAVAILABLE',
      publicMode
        ? '申し訳ありません。この日時はたった今埋まったか、予約できなくなりました。別の日時をお選びください。'
        : `この日時では予約できません: ${violations.map((x) => x.message).join(' / ')}`,
      { violations: publicMode ? undefined : violations.map((x) => ({ code: x.code, hard: x.hard, message: x.message })) },
    );
  }
}

/** 旧占有の自席を解放(0席になれば released) */
export async function releaseSeats(q: Q, orgId: string, occupancyId: string, partySize: number): Promise<void> {
  const r = await q.maybeOne<{ seats_taken: number; status: string }>(
    `UPDATE occupancies
        SET seats_taken = greatest(seats_taken - $3, 0),
            status = CASE WHEN seats_taken - $3 <= 0 THEN 'released' ELSE status END
      WHERE organization_id = $1 AND id = $2 AND status = 'active'
      RETURNING seats_taken, status`,
    [orgId, occupancyId, partySize],
  );
  if (r && r.status === 'released') {
    await q.exec('UPDATE occupancy_resources SET active = false WHERE organization_id = $1 AND occupancy_id = $2', [orgId, occupancyId]);
  }
}

export async function allocate(q: Q, p: AllocateParams): Promise<AllocationResult> {
  // 1) ロック対象を決め、数値順に advisory lock(デッドロック回避)
  const targets = await lockTargets(q, p.orgId, p.locationId, p.serviceId);
  const keys = [
    ...targets.staffIds.map((id) => `staff:${id}`),
    ...targets.resourceIds.map((id) => `resource:${id}`),
    `slot:${p.locationId}:${p.serviceId}:${p.start.toISOString()}`,
  ];
  if (targets.maxConcurrent) keys.push(`location:${p.locationId}`);
  if (p.release) {
    const old = await q.maybeOne<{ staff_id: string | null; location_id: string; resource_ids: string[] }>(
      `SELECT o.staff_id, o.location_id,
              coalesce((SELECT array_agg(r.resource_id ORDER BY r.resource_id) FROM occupancy_resources r WHERE r.occupancy_id = o.id), '{}') AS resource_ids
         FROM occupancies o WHERE o.organization_id = $1 AND o.id = $2`,
      [p.orgId, p.release.occupancyId],
    );
    if (old?.staff_id) keys.push(`staff:${old.staff_id}`);
    for (const r of old?.resource_ids ?? []) keys.push(`resource:${r}`);
  }
  await advisoryLockAll(q, keys);

  // 2) 変更時は旧占有を先に解放(失敗時はトランザクションごとロールバックされ元に戻る)
  if (p.release) await releaseSeats(q, p.orgId, p.release.occupancyId, p.release.partySize);

  // 3) ロック取得後の最新データでエンジンを再実行
  const input = await loadEngineInput(q, {
    orgId: p.orgId,
    locationId: p.locationId,
    serviceId: p.serviceId,
    from: p.start,
    to: p.start,
    now: p.now,
    mode: p.mode,
    force: p.force,
    partySize: p.partySize,
  });
  if (!input) throw new AppError('NOT_FOUND', '拠点またはサービスが見つかりません');
  const result: EvaluateResult = evaluateStart(input, p.start, input.service.requiresStaff ? p.staffChoice ?? 'auto' : null);
  if (!result.ok || !result.option) throw new SlotUnavailableError(result.violations, p.mode === 'public');
  const opt = result.option;

  // 4) 占有を確保
  if (opt.joinOccupancyId) {
    const joined = await q.maybeOne<{ id: string; starts_at: Date; ends_at: Date; block_starts_at: Date; block_ends_at: Date }>(
      `UPDATE occupancies SET seats_taken = seats_taken + $3
        WHERE organization_id = $1 AND id = $2 AND status = 'active' AND seats_taken + $3 <= capacity
        RETURNING id, starts_at, ends_at, block_starts_at, block_ends_at`,
      [p.orgId, opt.joinOccupancyId, p.partySize],
    );
    if (!joined) throw new SlotUnavailableError([{ code: 'CAPACITY_FULL', hard: true, message: '定員に達しています' }], p.mode === 'public');
    return {
      occupancyId: joined.id,
      staffId: opt.staffId,
      joined: true,
      start: joined.starts_at,
      end: joined.ends_at,
      blockStart: joined.block_starts_at,
      blockEnd: joined.block_ends_at,
      violationsOverridden: result.violations,
    };
  }
  const occ = await q.one<{ id: string }>(
    `INSERT INTO occupancies (organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [p.orgId, p.locationId, p.serviceId, opt.staffId, result.start, result.end, result.blockStart, result.blockEnd, input.service.capacity, p.partySize],
  );
  for (const a of opt.resourceAllocations) {
    await q.exec(
      `INSERT INTO occupancy_resources (organization_id, occupancy_id, resource_id, requirement_id, units, block_starts_at, block_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.orgId, occ.id, a.resourceId, a.requirementId, a.units, result.blockStart, result.blockEnd],
    );
  }
  return {
    occupancyId: occ.id,
    staffId: opt.staffId,
    joined: false,
    start: result.start,
    end: result.end,
    blockStart: result.blockStart,
    blockEnd: result.blockEnd,
    violationsOverridden: result.violations,
  };
}
