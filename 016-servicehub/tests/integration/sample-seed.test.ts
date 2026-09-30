/**
 * サンプル組織 Sample Wellness の投入が、実行日によらず説明どおりの状態になること。
 * (購入者が任意の日に投入するため、月初・月末など複数の日付で確認する)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withSystemForOrg } from '../../src/server/db/tx.js';
import { SAMPLE_SLUG, seedSampleOrganization, type SampleIds } from '../../src/server/sample/seed.js';
import { makeTestContext, type TestContext } from './helpers.js';

let t: TestContext;

beforeAll(async () => {
  t = await makeTestContext();
});
afterAll(async () => {
  // 他のテストファイルに通知キュー等を残さない
  await purgeSample();
  await t.close();
});

async function purgeSample() {
  await withSystem(t.pool, async (q) => {
    await q.exec(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
    await q.exec('DELETE FROM organizations WHERE slug = $1 AND is_sample = true', [SAMPLE_SLUG]);
  });
}

async function verify(ids: SampleIds, now: string) {
  return withSystemForOrg(t.pool, ids.orgId, async (q) => {
    const pass = async (customerId: string) =>
      q.one<{ id: string; remaining: number; expires_on: string; sum: number }>(
        `SELECT cp.id, cp.remaining, cp.expires_on, (SELECT sum(delta)::int FROM pass_ledger_entries l WHERE l.customer_pass_id = cp.id) AS sum
           FROM customer_passes cp WHERE cp.organization_id = $1 AND cp.customer_id = $2`,
        [ids.orgId, customerId],
      );
    const jiro = await pass(ids.customers.lastOne);
    expect(jiro.remaining).toBe(1);
    expect(jiro.sum).toBe(1);
    const misaki = await pass(ids.customers.expiring);
    expect(misaki.remaining).toBe(5);
    expect(misaki.sum).toBe(5);
    const review = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1 AND customer_id = $2 AND consumption_review = 'pending'`, [
      ids.orgId,
      ids.customers.expiring,
    ]);
    expect(review.n).toBe(1);
    const completed = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1 AND customer_id = $2 AND status = 'completed'`, [
      ids.orgId,
      ids.customers.repeater,
    ]);
    expect(completed.n).toBe(4);
    const records = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM service_records WHERE organization_id = $1 AND customer_id = $2 AND status = 'active'`, [
      ids.orgId,
      ids.customers.repeater,
    ]);
    expect(records.n).toBe(4);
    const noShow = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1 AND customer_id = $2 AND status = 'no_show'`, [
      ids.orgId,
      ids.customers.noShow,
    ]);
    expect(noShow.n).toBe(1);
    // 月4回: 先月は4回利用して締め済み。全期間で残数 = 台帳合計
    const periods = await q.many<{ period_start: string; remaining: number; status: string; sum: number }>(
      `SELECT pp.period_start, pp.remaining, pp.status, (SELECT coalesce(sum(delta), 0)::int FROM plan_ledger_entries l WHERE l.customer_plan_period_id = pp.id) AS sum
         FROM customer_plan_periods pp JOIN customer_plans p ON p.id = pp.customer_plan_id
        WHERE p.organization_id = $1 AND p.customer_id = $2 ORDER BY pp.period_start`,
      [ids.orgId, ids.customers.planMember],
    );
    expect(periods.length).toBeGreaterThanOrEqual(1);
    expect(periods[0]).toMatchObject({ remaining: 0, status: 'closed' });
    for (const p of periods) expect(p.sum).toBe(p.remaining);
    const uses = await q.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_ledger_entries l JOIN customer_plans p ON p.id = l.customer_plan_id WHERE p.customer_id = $1 AND l.entry_type = 'use'`,
      [ids.customers.planMember],
    );
    expect(uses.n).toBeGreaterThanOrEqual(4);
    // 待機 誠: 満席ヨガの待機(候補なし)
    const wl = await q.one<{ status: string; matches: number }>(
      `SELECT e.status, (SELECT count(*)::int FROM waitlist_matches m WHERE m.waitlist_entry_id = e.id AND m.status = 'open') AS matches
         FROM waitlist_entries e WHERE e.organization_id = $1 AND e.customer_id = $2`,
      [ids.orgId, ids.customers.waiting],
    );
    expect(wl).toEqual({ status: 'waiting', matches: 0 });
    // 過去の履歴は通常の予約ルールで作成(強制予約なし)
    const forced = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1 AND forced AND starts_at < $2::timestamptz - interval '1 day'`, [
      ids.orgId,
      now,
    ]);
    expect(forced.n).toBe(0);
    return { jiro, misaki };
  });
}

describe('サンプル組織の投入', () => {
  // 7日連続(全曜日・月末/月初を含む)+ 2月中旬
  const dates = ['2030-03-26', '2030-03-27', '2030-03-28', '2030-03-29', '2030-03-30', '2030-03-31', '2030-04-01'].map((d) => `${d}T01:00:00Z`);
  for (const now of [...dates, '2030-02-15T12:00:00Z']) {
    it(`${now} に投入しても説明どおりの状態になる`, async () => {
      await purgeSample();
      const ids = await seedSampleOrganization(t.pool, { appBaseUrl: 'http://localhost:3000', sessionSecret: 'test-session-secret-0123456789abcdefghijklmnop', now: new Date(now) });
      const r = await verify(ids, now);
      // 期限 美咲の回数券は投入日から約9日後が期限(期限間近の表示対象)
      const today = new Date(now);
      const days = Math.round((new Date(`${r.misaki.expires_on}T00:00:00Z`).getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400_000);
      expect(days).toBeGreaterThanOrEqual(8);
      expect(days).toBeLessThanOrEqual(10);
    });
  }
});
