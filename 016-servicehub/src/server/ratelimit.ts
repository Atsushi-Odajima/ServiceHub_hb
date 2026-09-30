import type pg from 'pg';
import { sha256 } from './auth/crypto.js';
import { AppError } from './errors.js';

/**
 * DB バケット方式の固定ウィンドウレート制限(複数インスタンスでも共有)。
 * キーはハッシュ化して保存(IP/メールをそのまま保存しない)。
 */
export async function hitRateLimit(
  pool: pg.Pool,
  key: string,
  limit: number,
  windowSec: number,
  now: Date,
): Promise<{ allowed: boolean; count: number; retryAfterSec: number }> {
  const hashed = sha256(`rl:${key}`);
  const expires = new Date(now.getTime() + windowSec * 1000);
  const r = await pool.query<{ count: number; expires_at: Date }>(
    `INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limit_buckets.expires_at <= $2 THEN 1 ELSE rate_limit_buckets.count + 1 END,
       window_start = CASE WHEN rate_limit_buckets.expires_at <= $2 THEN $2 ELSE rate_limit_buckets.window_start END,
       expires_at = CASE WHEN rate_limit_buckets.expires_at <= $2 THEN $3 ELSE rate_limit_buckets.expires_at END
     RETURNING count, expires_at`,
    [hashed, now, expires],
  );
  const row = r.rows[0];
  const retryAfterSec = Math.max(1, Math.ceil((row.expires_at.getTime() - now.getTime()) / 1000));
  return { allowed: row.count <= limit, count: row.count, retryAfterSec };
}

export async function enforceRateLimit(
  pool: pg.Pool,
  key: string,
  limit: number,
  windowSec: number,
  now: Date,
  message = 'アクセスが集中しています。しばらく待ってからもう一度お試しください。',
): Promise<void> {
  const r = await hitRateLimit(pool, key, limit, windowSec, now);
  if (!r.allowed) throw new AppError('RATE_LIMITED', message, { retryAfterSec: r.retryAfterSec });
}

export async function resetRateLimit(pool: pg.Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM rate_limit_buckets WHERE key = $1', [sha256(`rl:${key}`)]);
}

export async function cleanupRateLimits(pool: pg.Pool, now: Date): Promise<number> {
  const r = await pool.query('DELETE FROM rate_limit_buckets WHERE expires_at < $1', [now]);
  return r.rowCount ?? 0;
}
