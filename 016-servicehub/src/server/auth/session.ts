import type pg from 'pg';
import { withSystem, type Q } from '../db/tx.js';
import { randomToken, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'sh_session';

const HOUR = 3600_000;
export const SESSION_POLICY = {
  normal: { idleMs: 12 * HOUR, absoluteMs: 7 * 24 * HOUR },
  remember: { idleMs: 7 * 24 * HOUR, absoluteMs: 30 * 24 * HOUR },
};

export interface SessionRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  membership_id: string | null;
  csrf_token: string;
  remember: boolean;
  last_seen_at: Date;
  idle_expires_at: Date;
  expires_at: Date;
  user_name: string;
  user_email: string;
  user_status: string;
  role: string | null;
  membership_status: string | null;
  all_locations: boolean | null;
  staff_id: string | null;
  staff_status: string | null;
  org_status: string | null;
  org_name: string | null;
  org_slug: string | null;
  org_timezone: string | null;
  org_is_sample: boolean | null;
  location_ids: string[];
}

export async function createSession(
  pool: pg.Pool,
  input: { userId: string; orgId: string | null; membershipId: string | null; remember: boolean; userAgent?: string | null },
  now: Date,
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const policy = input.remember ? SESSION_POLICY.remember : SESSION_POLICY.normal;
  const expiresAt = new Date(now.getTime() + policy.absoluteMs);
  const idle = new Date(now.getTime() + policy.idleMs);
  await withSystem(pool, (q) =>
    q.exec(
      `INSERT INTO auth_sessions (token_hash, user_id, organization_id, membership_id, csrf_token, remember,
                                  created_at, last_seen_at, idle_expires_at, expires_at, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)`,
      [
        sha256(token),
        input.userId,
        input.orgId,
        input.membershipId,
        csrfToken,
        input.remember,
        now,
        idle,
        expiresAt,
        input.userAgent?.slice(0, 200) ?? null,
      ],
    ),
  );
  return { token, csrfToken, expiresAt };
}

/**
 * Cookie のトークンからセッションを読み、期限・ユーザー・メンバーシップ・組織・紐付くスタッフの状態を検査する。
 * 権限はキャッシュせず毎回DBから読む(ロール変更/無効化を即時反映)。
 */
export async function loadSession(pool: pg.Pool, token: string, now: Date): Promise<SessionRow | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return withSystem(pool, async (q) => {
    const row = await q.maybeOne<SessionRow>(
      `SELECT s.id, s.user_id, s.organization_id, s.membership_id, s.csrf_token, s.remember,
              s.last_seen_at, s.idle_expires_at, s.expires_at,
              u.display_name AS user_name, u.email AS user_email, u.status AS user_status,
              m.role, m.status AS membership_status, m.all_locations, m.staff_id,
              st.status AS staff_status,
              o.status AS org_status, o.name AS org_name, o.slug AS org_slug, o.timezone AS org_timezone,
              o.is_sample AS org_is_sample,
              coalesce((SELECT array_agg(ml.location_id ORDER BY ml.location_id) FROM membership_locations ml
                         JOIN locations l ON l.id = ml.location_id AND l.status = 'active'
                        WHERE ml.membership_id = m.id), '{}') AS location_ids
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN memberships m ON m.id = s.membership_id
         LEFT JOIN staff st ON st.id = m.staff_id AND st.organization_id = m.organization_id
         LEFT JOIN organizations o ON o.id = s.organization_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [sha256(token)],
    );
    if (!row) return null;
    if (row.expires_at <= now || row.idle_expires_at <= now) return null;
    if (row.user_status !== 'active') return null;
    if (row.membership_id) {
      if (row.membership_status !== 'active' || row.org_status !== 'active') return null;
      if (row.staff_id && row.staff_status && row.staff_status !== 'active') return null;
    }
    // アイドル期限の延長(書き込み頻度を抑えるため1分以上経過時のみ)
    if (now.getTime() - row.last_seen_at.getTime() > 60_000) {
      const policy = row.remember ? SESSION_POLICY.remember : SESSION_POLICY.normal;
      const idle = new Date(Math.min(now.getTime() + policy.idleMs, row.expires_at.getTime()));
      await q.exec('UPDATE auth_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [row.id, now, idle]);
    }
    return row;
  });
}

export async function revokeSessionById(pool: pg.Pool, sessionId: string): Promise<void> {
  await withSystem(pool, (q) => q.exec('DELETE FROM auth_sessions WHERE id = $1', [sessionId]));
}

/** メンバーの全セッションを失効(無効化・ロール変更・スタッフアーカイブ時) */
export async function revokeMembershipSessions(q: Q, membershipId: string, exceptSessionId?: string): Promise<number> {
  return q.exec(
    `DELETE FROM auth_sessions WHERE membership_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [membershipId, exceptSessionId ?? null],
  );
}

export async function revokeUserSessions(q: Q, userId: string, exceptSessionId?: string): Promise<number> {
  return q.exec(`DELETE FROM auth_sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`, [
    userId,
    exceptSessionId ?? null,
  ]);
}
