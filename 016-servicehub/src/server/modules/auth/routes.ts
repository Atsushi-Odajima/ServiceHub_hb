import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { permissionsOf, type Role } from '../../../shared/permissions.js';
import { normalizeEmail } from '../../../shared/normalize.js';
import { actorOf, writeAudit } from '../../audit.js';
import { contextFromSession, requireAuth, requireUser } from '../../auth/context.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../auth/crypto.js';
import { createSession, revokeSessionById, revokeUserSessions, SESSION_COOKIE } from '../../auth/session.js';
import { withSystem, withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError } from '../../errors.js';
import { parse, zEmail } from '../../http/validate.js';
import { enqueueNotification } from '../../notifications/enqueue.js';
import { enforceRateLimit, hitRateLimit, resetRateLimit } from '../../ratelimit.js';

export const PASSWORD_MIN = 10;
const zPassword = z.string().min(PASSWORD_MIN, `パスワードは${PASSWORD_MIN}文字以上にしてください`).max(200);

const LoginSchema = z.object({
  email: zEmail,
  password: z.string().min(1).max(200),
  remember: z.boolean().optional().default(false),
  organizationId: z.string().uuid().optional(),
});

function setSessionCookie(deps: Deps, reply: FastifyReply, token: string, expiresAt: Date, remember: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    // remember=false でもブラウザ終了で消えないよう期限を設定(サーバー側でアイドル期限を管理)
    expires: remember ? expiresAt : expiresAt,
  });
}

function clearSessionCookie(deps: Deps, reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: deps.config.cookieSecure, sameSite: 'lax', httpOnly: true });
}

interface MembershipChoice {
  membership_id: string;
  organization_id: string;
  org_name: string;
  org_slug: string;
  role: Role;
  is_sample: boolean;
}

async function activeMemberships(deps: Deps, userId: string): Promise<MembershipChoice[]> {
  return withSystem(deps.pool, (q) =>
    q.many<MembershipChoice>(
      `SELECT m.id AS membership_id, m.organization_id, o.name AS org_name, o.slug AS org_slug, m.role, o.is_sample
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN staff st ON st.id = m.staff_id AND st.organization_id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
          AND (m.staff_id IS NULL OR st.status = 'active')
        ORDER BY o.is_sample, o.name`,
      [userId],
    ),
  );
}

function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

export async function registerAuthRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock, config } = deps;

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = parse(LoginSchema, req.body);
    const now = clock.now();
    const email = normalizeEmail(body.email)!;
    await enforceRateLimit(pool, `login-ip:${clientIp(req)}`, config.LOGIN_RATE_LIMIT_PER_15MIN * 3, 900, now);
    const emailLimit = await hitRateLimit(pool, `login-email:${email}`, config.LOGIN_RATE_LIMIT_PER_15MIN, 900, now);
    if (!emailLimit.allowed) {
      throw new AppError('RATE_LIMITED', 'ログイン試行が多すぎます。15分ほど待ってからお試しください。', {
        retryAfterSec: emailLimit.retryAfterSec,
      });
    }
    const user = await withSystem(pool, (q) =>
      q.maybeOne<{ id: string; password_hash: string | null; status: string; locked_until: Date | null; failed_login_count: number }>(
        'SELECT id, password_hash, status, locked_until, failed_login_count FROM users WHERE email_normalized = $1',
        [email],
      ),
    );
    const ok = await verifyPassword(body.password, user?.password_hash ?? null);
    const invalid = new AppError('UNAUTHENTICATED', 'メールアドレスまたはパスワードが正しくありません');
    if (!user || user.status !== 'active') throw invalid;
    if (user.locked_until && user.locked_until > now) {
      throw new AppError('RATE_LIMITED', 'ログイン試行が多すぎるため一時的にロックされています。しばらく待ってからお試しください。');
    }
    if (!ok) {
      await withSystem(pool, (q) =>
        q.exec(
          `UPDATE users SET failed_login_count = failed_login_count + 1,
                  locked_until = CASE WHEN failed_login_count + 1 >= 10 THEN $2::timestamptz ELSE locked_until END
            WHERE id = $1`,
          [user.id, new Date(now.getTime() + 15 * 60_000)],
        ),
      );
      throw invalid;
    }
    const memberships = await activeMemberships(deps, user.id);
    const chosen = body.organizationId
      ? memberships.find((m) => m.organization_id === body.organizationId)
      : memberships[0];
    // 有効な所属が1つもない(無効化された)アカウントはログインさせない
    if (!chosen) throw invalid;
    await withSystem(pool, (q) =>
      q.exec('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [user.id, now]),
    );
    await resetRateLimit(pool, `login-email:${email}`);
    const s = await createSession(
      pool,
      {
        userId: user.id,
        orgId: chosen?.organization_id ?? null,
        membershipId: chosen?.membership_id ?? null,
        remember: body.remember,
        userAgent: req.headers['user-agent'] ?? null,
      },
      now,
    );
    setSessionCookie(deps, reply, s.token, s.expiresAt, body.remember);
    return { ok: true, csrfToken: s.csrfToken, organizations: memberships.length };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    if (req.session) await revokeSessionById(pool, req.session.id);
    clearSessionCookie(deps, reply);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const u = requireUser(req);
    const memberships = await activeMemberships(deps, u.userId);
    const ctx = req.session ? contextFromSession(req.session) : null;
    if (!ctx) {
      return {
        user: { id: u.userId, name: u.userName, email: u.userEmail },
        csrfToken: u.csrfToken,
        organization: null,
        memberships: memberships.map((m) => ({ organizationId: m.organization_id, name: m.org_name, role: m.role })),
      };
    }
    const locations = await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) =>
      q.many<{ id: string; name: string; slug: string; timezone: string }>(
        `SELECT id, name, slug, timezone FROM locations
          WHERE organization_id = $1 AND status = 'active' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
          ORDER BY sort_order, name`,
        [ctx.orgId, ctx.allLocations ? null : ctx.locationIds],
      ),
    );
    return {
      user: { id: ctx.userId, name: ctx.userName, email: ctx.userEmail },
      csrfToken: ctx.csrfToken,
      organization: {
        id: ctx.orgId,
        name: ctx.orgName,
        slug: ctx.orgSlug,
        timezone: ctx.orgTimezone,
        isSample: ctx.orgIsSample,
      },
      membership: {
        id: ctx.membershipId,
        role: ctx.role,
        staffId: ctx.staffId,
        allLocations: ctx.allLocations,
        permissions: permissionsOf(ctx.role),
      },
      locations,
      memberships: memberships.map((m) => ({ organizationId: m.organization_id, name: m.org_name, role: m.role })),
    };
  });

  app.post('/api/v1/auth/switch-org', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ organizationId: z.string().uuid() }), req.body);
    const memberships = await activeMemberships(deps, u.userId);
    const chosen = memberships.find((m) => m.organization_id === body.organizationId);
    if (!chosen) throw new AppError('NOT_FOUND', '組織が見つかりません');
    const remember = Boolean(req.session?.remember);
    await revokeSessionById(pool, u.sessionId);
    const s = await createSession(
      pool,
      { userId: u.userId, orgId: chosen.organization_id, membershipId: chosen.membership_id, remember, userAgent: req.headers['user-agent'] ?? null },
      clock.now(),
    );
    setSessionCookie(deps, reply, s.token, s.expiresAt, remember);
    return { ok: true, csrfToken: s.csrfToken };
  });

  app.post('/api/v1/auth/change-password', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }), req.body);
    const row = await withSystem(pool, (q) =>
      q.one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [u.userId]),
    );
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new AppError('VALIDATION_ERROR', '現在のパスワードが正しくありません', {
        fields: { currentPassword: '現在のパスワードが正しくありません' },
      });
    }
    const hash = await hashPassword(body.newPassword);
    await withSystem(pool, async (q) => {
      await q.exec('UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [u.userId, hash, clock.now()]);
      // 他の端末のセッションは失効(現在の端末は維持)
      await revokeUserSessions(q, u.userId, u.sessionId);
    });
    const ctx = req.session ? contextFromSession(req.session) : null;
    if (ctx) {
      await withTenant(pool, { orgId: ctx.orgId }, (q) =>
        writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'user.password_changed', targetType: 'user', targetId: u.userId }),
      );
    }
    return { ok: true };
  });

  // ---- 招待の受諾 ----
  app.get('/api/v1/auth/invitations/:token', async (req) => {
    const { token } = req.params as { token: string };
    await enforceRateLimit(pool, `invite-view:${clientIp(req)}`, 30, 60, clock.now());
    const inv = await withSystem(pool, (q) =>
      q.maybeOne<{ email: string; role: Role; org_name: string; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; user_exists: boolean }>(
        `SELECT i.email, i.role, o.name AS org_name, i.expires_at, i.accepted_at, i.revoked_at,
                EXISTS (SELECT 1 FROM users u WHERE u.email_normalized = i.email_normalized) AS user_exists
           FROM invitations i JOIN organizations o ON o.id = i.organization_id
          WHERE i.token_hash = $1`,
        [sha256(token)],
      ),
    );
    if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at <= clock.now()) {
      throw new AppError('NOT_FOUND', '招待リンクが無効か、有効期限が切れています');
    }
    return { email: inv.email, role: inv.role, organizationName: inv.org_name, userExists: inv.user_exists };
  });

  app.post('/api/v1/auth/invitations/:token/accept', async (req, reply) => {
    const { token } = req.params as { token: string };
    const now = clock.now();
    await enforceRateLimit(pool, `invite-accept:${clientIp(req)}`, 10, 600, now);
    const body = parse(
      z.object({ displayName: z.string().trim().min(1).max(100).optional(), password: z.string().min(1).max(200) }),
      req.body,
    );
    const result = await withSystem(pool, async (q) => {
      const inv = await q.maybeOne<{
        id: string;
        organization_id: string;
        email: string;
        email_normalized: string;
        role: Role;
        all_locations: boolean;
        location_ids: string[];
        staff_id: string | null;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>('SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE', [sha256(token)]);
      if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at <= now) {
        throw new AppError('NOT_FOUND', '招待リンクが無効か、有効期限が切れています');
      }
      let user = await q.maybeOne<{ id: string; password_hash: string | null; display_name: string }>(
        'SELECT id, password_hash, display_name FROM users WHERE email_normalized = $1 FOR UPDATE',
        [inv.email_normalized],
      );
      if (user && user.password_hash) {
        // 既存ユーザー: 本人確認として既存パスワードを要求
        if (!(await verifyPassword(body.password, user.password_hash))) {
          throw new AppError('VALIDATION_ERROR', 'このメールアドレスは登録済みです。既存のパスワードを入力してください', {
            fields: { password: '既存のパスワードを入力してください' },
          });
        }
      } else {
        const pw = parse(zPassword, body.password);
        const name = body.displayName ?? inv.email.split('@')[0];
        const hash = await hashPassword(pw);
        if (user) {
          await q.exec('UPDATE users SET password_hash = $2, display_name = $3, password_changed_at = $4 WHERE id = $1', [
            user.id,
            hash,
            name,
            now,
          ]);
        } else {
          user = await q.one<{ id: string; password_hash: string | null; display_name: string }>(
            `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
             VALUES ($1,$2,$3,$4,$5) RETURNING id, password_hash, display_name`,
            [inv.email, inv.email_normalized, hash, name, now],
          );
        }
      }
      const existing = await q.maybeOne<{ id: string }>(
        'SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2',
        [inv.organization_id, user.id],
      );
      if (existing) throw new AppError('CONFLICT', 'すでにこの組織のメンバーです');
      // 招待後にスタッフが他メンバーへ紐付けられていないか
      const staffId =
        inv.staff_id &&
        (await q.maybeOne(`SELECT 1 FROM memberships WHERE organization_id = $1 AND staff_id = $2`, [inv.organization_id, inv.staff_id]))
          ? null
          : inv.staff_id;
      const m = await q.one<{ id: string }>(
        `INSERT INTO memberships (organization_id, user_id, role, all_locations, staff_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [inv.organization_id, user.id, inv.role, inv.role === 'owner' ? true : inv.all_locations, staffId],
      );
      if (inv.location_ids.length > 0) {
        await q.exec(
          `INSERT INTO membership_locations (organization_id, membership_id, location_id)
           SELECT $1, $2, l.id FROM locations l WHERE l.organization_id = $1 AND l.id = ANY($3::uuid[])`,
          [inv.organization_id, m.id, inv.location_ids],
        );
      }
      await q.exec('UPDATE invitations SET accepted_at = $2, accepted_user_id = $3 WHERE id = $1', [inv.id, now, user.id]);
      await writeAudit(q, inv.organization_id, { type: 'member', userId: user.id, membershipId: m.id, label: user.display_name }, {
        action: 'member.invitation_accepted',
        targetType: 'membership',
        targetId: m.id,
        after: { role: inv.role },
      });
      return { userId: user.id, orgId: inv.organization_id, membershipId: m.id };
    });
    const s = await createSession(
      pool,
      { userId: result.userId, orgId: result.orgId, membershipId: result.membershipId, remember: false, userAgent: req.headers['user-agent'] ?? null },
      now,
    );
    setSessionCookie(deps, reply, s.token, s.expiresAt, false);
    return { ok: true, csrfToken: s.csrfToken };
  });

  // ---- パスワード再設定 ----
  app.post('/api/v1/auth/password-reset/request', async (req) => {
    const body = parse(z.object({ email: zEmail }), req.body);
    const now = clock.now();
    await enforceRateLimit(pool, `pwreset-ip:${clientIp(req)}`, 10, 900, now);
    const email = normalizeEmail(body.email)!;
    const limit = await hitRateLimit(pool, `pwreset-email:${email}`, 3, 3600, now);
    if (limit.allowed) {
      await withSystem(pool, async (q) => {
        const user = await q.maybeOne<{ id: string; email: string; status: string }>(
          'SELECT id, email, status FROM users WHERE email_normalized = $1',
          [email],
        );
        if (!user || user.status !== 'active') return;
        const m = await q.maybeOne<{ organization_id: string }>(
          `SELECT organization_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
          [user.id],
        );
        if (!m) return;
        const token = randomToken(32);
        const t = await q.one<{ id: string }>(
          `INSERT INTO password_reset_tokens (user_id, organization_id, token_hash, expires_at)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [user.id, m.organization_id, sha256(token), new Date(now.getTime() + 3600_000)],
        );
        await enqueueNotification(q, {
          orgId: m.organization_id,
          type: 'password_reset',
          recipient: user.email,
          idempotencyKey: `password_reset:${t.id}`,
          payload: { url: `${config.APP_BASE_URL}/reset-password?token=${token}` },
        });
      });
    }
    // アカウントの有無に関わらず同じ応答
    return { ok: true, message: '登録があれば、パスワード再設定用のメールを送信しました' };
  });

  app.post('/api/v1/auth/password-reset/confirm', async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(200), password: zPassword }), req.body);
    const now = clock.now();
    await enforceRateLimit(pool, `pwreset-confirm:${clientIp(req)}`, 10, 900, now);
    const hash = await hashPassword(body.password);
    await withSystem(pool, async (q) => {
      const t = await q.maybeOne<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
        'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE',
        [sha256(body.token)],
      );
      if (!t || t.used_at || t.expires_at <= now) {
        throw new AppError('NOT_FOUND', '再設定リンクが無効か、有効期限が切れています');
      }
      await q.exec('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [t.id, now]);
      await q.exec(
        `UPDATE users SET password_hash = $2, password_changed_at = $3, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
        [t.user_id, hash, now],
      );
      await revokeUserSessions(q, t.user_id);
    });
    clearSessionCookie(deps, reply);
    return { ok: true };
  });

  // 認証済みユーザーの簡易確認(PWA のオンライン確認にも使用)
  app.get('/api/v1/auth/ping', async (req) => {
    requireAuth(req);
    return { ok: true, time: clock.now().toISOString() };
  });
}
