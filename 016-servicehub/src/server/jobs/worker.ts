import { parseOrgSettings } from '../../shared/constants.js';
import { withSystem, withSystemForOrg } from '../db/tx.js';
import type { Deps } from '../deps.js';
import { renderNotification, type NotificationRow } from '../notifications/render.js';

const LEASE_MS = 2 * 60_000;

export interface WorkerResult {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

function allowlisted(allowlist: string | undefined, to: string): boolean {
  if (!allowlist) return true;
  const entries = allowlist.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const addr = to.toLowerCase();
  return entries.some((e) => (e.includes('@') ? addr === e : addr.endsWith(`@${e}`)));
}

/**
 * 送信箱から期限の来た通知を取得して送信する。
 * - FOR UPDATE SKIP LOCKED で複数ワーカーが同じ通知を取らない
 * - 取得時に sending + リース(2分)。落ちた場合はリース切れ後に再取得
 * - 失敗は指数バックオフで再試行、max_attempts で failed
 */
export async function processDueNotifications(deps: Deps, limit = 20): Promise<WorkerResult> {
  const now = deps.clock.now();
  const res: WorkerResult = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 };
  const claimed = await withSystem(deps.pool, (q) =>
    q.many<NotificationRow>(
      `WITH due AS (
         SELECT id FROM notifications
          WHERE status IN ('pending','sending') AND next_attempt_at <= $1
            AND (status = 'pending' OR locked_until IS NULL OR locked_until < $1)
          ORDER BY next_attempt_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE notifications n SET status = 'sending', locked_until = $3, attempts = n.attempts + 1
         FROM due WHERE n.id = due.id
       RETURNING n.id, n.organization_id, n.type, n.recipient, n.customer_id, n.booking_id, n.payload, n.attempts, n.max_attempts`,
      [now, limit, new Date(now.getTime() + LEASE_MS)],
    ),
  );
  res.claimed = claimed.length;
  for (const n of claimed) {
    try {
      const outcome = await withSystemForOrg(deps.pool, n.organization_id, async (q) => {
        const org = await q.one<{ name: string; is_sample: boolean; settings: unknown }>('SELECT name, is_sample, settings FROM organizations WHERE id = $1', [
          n.organization_id,
        ]);
        const settings = parseOrgSettings(org.settings);
        const r = await renderNotification(q, deps, n, org.name, settings.replyToEmail);
        if ('skip' in r) return { skip: r.skip, subject: null as string | null, mail: null };
        if (org.is_sample) return { skip: 'sample_org', subject: r.subject, mail: null };
        if (!allowlisted(deps.config.EMAIL_ALLOWLIST, r.to)) return { skip: 'not_allowlisted', subject: r.subject, mail: null };
        return { skip: null, subject: r.subject, mail: r };
      });
      if (outcome.skip || !outcome.mail) {
        await markDone(deps, n.id, 'skipped', { subject: outcome.subject, skipReason: outcome.skip ?? 'unknown' });
        res.skipped++;
        continue;
      }
      const sent = await deps.mailer.send({
        to: outcome.mail.to,
        subject: outcome.mail.subject,
        text: outcome.mail.text,
        replyTo: outcome.mail.replyTo,
        messageId: `<notification-${n.id}@servicehub>`,
      });
      if (!deps.mailer.delivers) {
        // log プロバイダ: 実際には送信していないことを明示
        await markDone(deps, n.id, 'skipped', { subject: outcome.subject, skipReason: 'email_provider_log' });
        res.skipped++;
      } else {
        await markDone(deps, n.id, 'sent', { subject: outcome.subject, providerMessageId: sent.providerMessageId });
        res.sent++;
      }
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      if (n.attempts >= n.max_attempts) {
        await withSystem(deps.pool, (q) =>
          q.exec(`UPDATE notifications SET status = 'failed', last_error = $2, locked_until = NULL WHERE id = $1`, [n.id, message]),
        );
        res.failed++;
      } else {
        const delayMin = Math.min(60, 2 ** n.attempts);
        await withSystem(deps.pool, (q) =>
          q.exec(`UPDATE notifications SET status = 'pending', last_error = $2, locked_until = NULL, next_attempt_at = $3 WHERE id = $1`, [
            n.id,
            message,
            new Date(deps.clock.now().getTime() + delayMin * 60_000),
          ]),
        );
        res.retried++;
      }
      deps.log.warn({ notificationId: n.id, type: n.type, err: message }, 'notification send failed');
    }
  }
  return res;
}

async function markDone(
  deps: Deps,
  id: string,
  status: 'sent' | 'skipped',
  info: { subject?: string | null; providerMessageId?: string | null; skipReason?: string },
): Promise<void> {
  await withSystem(deps.pool, (q) =>
    q.exec(
      `UPDATE notifications
          SET status = $2, subject = coalesce($3, subject), provider_message_id = $4, skip_reason = $5,
              sent_at = CASE WHEN $2 = 'sent' THEN $6::timestamptz ELSE sent_at END, locked_until = NULL, last_error = NULL,
              -- 秘密を含み得る URL は処理後に送信箱から消す
              payload = payload - 'url'
        WHERE id = $1`,
      [id, status, info.subject ?? null, info.providerMessageId ?? null, info.skipReason ?? null, deps.clock.now()],
    ),
  );
}
