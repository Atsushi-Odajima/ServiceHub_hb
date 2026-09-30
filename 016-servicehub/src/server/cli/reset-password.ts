/**
 * パスワード再設定リンクをコマンドで発行する(運用担当者向け)。
 * メール送信を設定していない環境で、ただ1人のオーナーがパスワードを忘れた場合などに使う。
 *   node dist/server/cli/reset-password.js --email owner@example.com [--hours 24]
 *   開発: pnpm reset:password -- --email owner@example.com
 * リンクは1回だけ使え、有効期限は既定24時間。リンクは画面に一度だけ表示する(ログには残さない)。
 * パスワードを再設定すると、その人のすべてのログインが切れる。発行は所属する各組織の監査ログに記録する。
 */
import { argValue, loadConfigForCli } from './cli-config.js';
import { normalizeEmail } from '../../shared/normalize.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { createPool } from '../db/pool.js';
import { withSystem } from '../db/tx.js';

const config = loadConfigForCli();
const email = argValue('email');
const hours = Number(argValue('hours') ?? '24');
if (!email || !Number.isInteger(hours) || hours < 1 || hours > 72) {
  console.error('Usage: reset-password --email <メールアドレス> [--hours 1〜72(既定 24)]');
  process.exit(1);
}
const pool = createPool({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 2, applicationName: 'servicehub-reset-password' });
try {
  const result = await withSystem(pool, async (q) => {
    const user = await q.maybeOne<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [normalizeEmail(email)]);
    if (!user) return null;
    const orgs = await q.many<{ organization_id: string }>(`SELECT organization_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY organization_id`, [user.id]);
    const token = randomToken(32);
    await q.exec(`INSERT INTO password_reset_tokens (user_id, organization_id, token_hash, expires_at) VALUES ($1, NULL, $2, now() + make_interval(hours => $3::int))`, [
      user.id,
      sha256(token),
      hours,
    ]);
    for (const o of orgs) {
      await q.exec(
        `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, metadata)
         VALUES ($1, 'operator', 'reset-password (CLI)', 'member.password_reset_link_issued', 'user', $2, $3)`,
        [o.organization_id, user.id, JSON.stringify({ via: 'cli', expiresInHours: hours })],
      );
    }
    return { token, orgs: orgs.length };
  });
  if (!result) {
    console.error('このメールアドレスのユーザーは見つかりません');
    process.exitCode = 1;
  } else {
    const base = (process.env.APP_BASE_URL ?? config.APP_BASE_URL).replace(/\/+$/, '');
    console.info(`パスワード再設定リンク(${hours}時間有効・1回限り。本人にだけ安全な方法で渡してください):`);
    console.info(`  ${base}/reset-password?token=${result.token}`);
    if (result.orgs === 0) console.warn('注意: このユーザーは有効な所属組織がありません(再設定してもログイン後に使える組織がありません)');
  }
} finally {
  await pool.end();
}
