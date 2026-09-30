// 各モジュールの定期処理をスケジューラへ登録する(runner.ts から副作用 import)
import { addDays, todayIn } from '../../shared/time.js';
import { parseOrgSettings } from '../../shared/constants.js';
import { closePlanPeriods, expirePasses, passExpiringNotices } from '../modules/entitlements/ledger.js';
import { enqueueNotification } from '../notifications/enqueue.js';
import { registerOrgJob } from './scheduler.js';

registerOrgJob('passes', async (q, _deps, orgId, now) => {
  const org = await q.one<{ timezone: string; settings: unknown }>('SELECT timezone, settings FROM organizations WHERE id = $1', [orgId]);
  const settings = parseOrgSettings(org.settings);
  const today = todayIn(org.timezone, now);
  const passesExpired = await expirePasses(q, orgId, today);
  let passExpiringNotices_ = 0;
  if (settings.notifications.passExpiring) {
    passExpiringNotices_ = await passExpiringNotices(q, orgId, today, settings.passExpiringNoticeDays, (r) =>
      enqueueNotification(q, {
        orgId,
        type: 'pass_expiring',
        recipient: r.email,
        customerId: r.customerId,
        idempotencyKey: `pass_expiring:${r.passId}:${r.expiresOn}`,
        payload: { customerName: r.name, passName: r.passName, remaining: r.remaining, expiresOn: r.expiresOn },
      }),
    );
  }
  return { passesExpired, passExpiringNotices: passExpiringNotices_ };
});

registerOrgJob('plans', async (q, _deps, orgId, now) => {
  const org = await q.one<{ timezone: string; settings: unknown }>('SELECT timezone, settings FROM organizations WHERE id = $1', [orgId]);
  const settings = parseOrgSettings(org.settings);
  const today = todayIn(org.timezone, now);
  const planPeriods = await closePlanPeriods(q, orgId, today);
  let planExpiringNotices = 0;
  if (settings.notifications.planExpiring && settings.planExpiringNoticeDays > 0) {
    const rows = await q.many<{ id: string; customer_id: string; email: string | null; name: string; plan: string; ends_on: string }>(
      `SELECT p.id, p.customer_id, c.email, c.name, p.product_snapshot->>'name' AS plan, p.ends_on
         FROM customer_plans p JOIN customers c ON c.id = p.customer_id
        WHERE p.organization_id = $1 AND p.status = 'active' AND p.ends_on BETWEEN $2::date AND $3::date AND c.status = 'active'`,
      [orgId, today, addDays(today, settings.planExpiringNoticeDays)],
    );
    for (const r of rows) {
      const ok = await enqueueNotification(q, {
        orgId,
        type: 'plan_expiring',
        recipient: r.email,
        customerId: r.customer_id,
        idempotencyKey: `plan_expiring:${r.id}:${r.ends_on}`,
        payload: { customerName: r.name, planName: r.plan, endsOn: r.ends_on },
      });
      if (ok) planExpiringNotices++;
    }
  }
  return { planPeriods, planExpiringNotices };
});
