import { parseOrgSettings } from '../../shared/constants.js';
import { withSystem, withSystemForOrg, type Q } from '../db/tx.js';
import type { Deps } from '../deps.js';
import { enqueueNotification } from '../notifications/enqueue.js';
import { cleanupRateLimits } from '../ratelimit.js';

export interface SchedulerSummary {
  reminders: number;
  passExpiringNotices: number;
  passesExpired: number;
  planExpiringNotices: number;
  planPeriods: number;
  waitlistExpired: number;
  waitlistMatches: number;
  cleaned: number;
}

type OrgJob = (q: Q, deps: Deps, orgId: string, now: Date) => Promise<Partial<SchedulerSummary>>;

/** 他モジュールが日次/定期処理を登録する(回数券の失効・プラン期間締め・待機期限など) */
const orgJobs: { name: string; run: OrgJob }[] = [];
export function registerOrgJob(name: string, run: OrgJob): void {
  if (!orgJobs.some((j) => j.name === name)) orgJobs.push({ name, run });
}

/**
 * リマインダー登録: 開始の N 時間前を過ぎた確定予約。予約自体がその時間内に作られた場合は確定メールで足りるため送らない。
 * 冪等キー booking_reminder:{id}:{startsAt} で重複しない(日時変更後は新しいキー)。
 */
export async function enqueueReminders(q: Q, orgId: string, now: Date, leadHours: number): Promise<number> {
  if (leadHours <= 0) return 0;
  const leadMs = leadHours * 3600_000;
  const rows = await q.many<{ id: string; starts_at: Date; location_id: string; customer_id: string; email: string | null }>(
    `SELECT b.id, b.starts_at, b.location_id, b.customer_id, b.contact_snapshot->>'email' AS email
       FROM bookings b
      WHERE b.organization_id = $1 AND b.status = 'confirmed'
        AND b.starts_at > $2 AND b.starts_at <= $3
        AND b.created_at <= b.starts_at - make_interval(secs => $4::double precision)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.organization_id = b.organization_id
                         AND n.idempotency_key = 'booking_reminder:' || b.id || ':' || to_char(b.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
    [orgId, now, new Date(now.getTime() + leadMs), leadMs / 1000],
  );
  let n = 0;
  for (const r of rows) {
    const iso = r.starts_at.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const inserted = await enqueueNotification(q, {
      orgId,
      type: 'booking_reminder',
      recipient: r.email,
      customerId: r.customer_id,
      bookingId: r.id,
      locationId: r.location_id,
      idempotencyKey: `booking_reminder:${r.id}:${iso}`,
      payload: { bookingId: r.id, startsAt: r.starts_at },
    });
    if (inserted) n++;
  }
  return n;
}

export async function runScheduler(deps: Deps): Promise<SchedulerSummary> {
  const now = deps.clock.now();
  const summary: SchedulerSummary = {
    reminders: 0,
    passExpiringNotices: 0,
    passesExpired: 0,
    planExpiringNotices: 0,
    planPeriods: 0,
    waitlistExpired: 0,
    waitlistMatches: 0,
    cleaned: 0,
  };
  const run = await withSystem(deps.pool, (q) => q.one<{ id: string }>(`INSERT INTO job_runs (job_name) VALUES ('scheduler') RETURNING id`));
  try {
    const orgs = await withSystem(deps.pool, (q) => q.many<{ id: string; settings: unknown }>(`SELECT id, settings FROM organizations WHERE status = 'active'`));
    for (const org of orgs) {
      const settings = parseOrgSettings(org.settings);
      await withSystemForOrg(deps.pool, org.id, async (q) => {
        if (settings.notifications.bookingReminder) {
          summary.reminders += await enqueueReminders(q, org.id, now, settings.reminderLeadHours);
        }
        for (const job of orgJobs) {
          const r = await job.run(q, deps, org.id, now);
          for (const [k, v] of Object.entries(r)) {
            (summary as unknown as Record<string, number>)[k] += v as number;
          }
        }
      });
    }
    summary.cleaned += await withSystem(deps.pool, async (q) => {
      const a = await q.exec('DELETE FROM auth_sessions WHERE expires_at < $1 OR idle_expires_at < $1', [now]);
      const b = await q.exec(`DELETE FROM password_reset_tokens WHERE expires_at < $1::timestamptz - interval '7 days'`, [now]);
      return a + b;
    });
    summary.cleaned += await cleanupRateLimits(deps.pool, now);
    await withSystem(deps.pool, (q) =>
      q.exec(`UPDATE job_runs SET status = 'succeeded', finished_at = $2, detail = $3 WHERE id = $1`, [run.id, deps.clock.now(), JSON.stringify(summary)]),
    );
  } catch (err) {
    await withSystem(deps.pool, (q) =>
      q.exec(`UPDATE job_runs SET status = 'failed', finished_at = $2, detail = $3 WHERE id = $1`, [
        run.id,
        deps.clock.now(),
        JSON.stringify({ error: String((err as Error).message).slice(0, 500) }),
      ]),
    );
    throw err;
  }
  return summary;
}
