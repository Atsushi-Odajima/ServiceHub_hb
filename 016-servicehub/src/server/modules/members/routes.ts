import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, type Role } from '../../../shared/permissions.js';
import { normalizeEmail } from '../../../shared/normalize.js';
import { actorOf, writeAudit } from '../../audit.js';
import { requireAuth } from '../../auth/context.js';
import { randomToken, sha256 } from '../../auth/crypto.js';
import { revokeMembershipSessions } from '../../auth/session.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, notFound } from '../../errors.js';
import { parse, zEmail, zUuid } from '../../http/validate.js';
import { enqueueNotification } from '../../notifications/enqueue.js';

const zRole = z.enum(ROLES);

const InviteSchema = z.object({
  email: zEmail,
  role: zRole,
  allLocations: z.boolean().default(false),
  locationIds: z.array(zUuid).max(200).default([]),
  staffId: zUuid.nullable().optional(),
  sendEmail: z.boolean().default(true),
});

const MemberPatchSchema = z.object({
  role: zRole.optional(),
  allLocations: z.boolean().optional(),
  locationIds: z.array(zUuid).max(200).optional(),
  staffId: zUuid.nullable().optional(),
});

async function assertLocationsInOrg(q: Q, orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await q.one<{ n: number }>(
    `SELECT count(*) AS n FROM locations WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
    [orgId, ids],
  );
  if (r.n !== new Set(ids).size) throw new AppError('VALIDATION_ERROR', '存在しない拠点が指定されています');
}

async function assertStaffAvailable(q: Q, orgId: string, staffId: string, exceptMembershipId?: string): Promise<void> {
  const st = await q.maybeOne<{ status: string }>('SELECT status FROM staff WHERE organization_id = $1 AND id = $2', [orgId, staffId]);
  if (!st || st.status !== 'active') throw new AppError('VALIDATION_ERROR', '有効なスタッフを指定してください');
  const used = await q.maybeOne(
    'SELECT 1 FROM memberships WHERE organization_id = $1 AND staff_id = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)',
    [orgId, staffId, exceptMembershipId ?? null],
  );
  if (used) throw new AppError('CONFLICT', 'このスタッフは別のログインアカウントに紐付いています');
}

async function activeOwnerCount(q: Q, orgId: string): Promise<number> {
  const r = await q.one<{ n: number }>(
    `SELECT count(*) AS n FROM memberships WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
    [orgId],
  );
  return r.n;
}

export async function registerMemberRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock, config } = deps;

  app.get('/api/v1/members', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const rows = await q.many<{
        id: string;
        role: Role;
        status: string;
        all_locations: boolean;
        staff_id: string | null;
        staff_name: string | null;
        user_id: string;
        email: string;
        display_name: string;
        last_login_at: Date | null;
        location_ids: string[];
        created_at: Date;
      }>(
        `SELECT m.id, m.role, m.status, m.all_locations, m.staff_id, st.display_name AS staff_name,
                u.id AS user_id, u.email, u.display_name, u.last_login_at, m.created_at,
                coalesce((SELECT array_agg(location_id) FROM membership_locations ml WHERE ml.membership_id = m.id), '{}') AS location_ids
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN staff st ON st.id = m.staff_id AND st.organization_id = m.organization_id
          WHERE m.organization_id = $1
          ORDER BY m.status, CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, u.display_name`,
        [ctx.orgId],
      );
      const invitations = await q.many<{ id: string; email: string; role: Role; expires_at: Date; created_at: Date }>(
        `SELECT id, email, role, expires_at, created_at FROM invitations
          WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
          ORDER BY created_at DESC`,
        [ctx.orgId, clock.now()],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          role: r.role,
          status: r.status,
          allLocations: r.role === 'owner' || r.all_locations,
          locationIds: r.location_ids,
          staffId: r.staff_id,
          staffName: r.staff_name,
          user: { id: r.user_id, email: r.email, name: r.display_name, lastLoginAt: r.last_login_at },
          isSelf: r.id === ctx.membershipId,
        })),
        invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, createdAt: i.created_at })),
      };
    });
  });

  app.post('/api/v1/members/invitations', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    const body = parse(InviteSchema, req.body);
    const now = clock.now();
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      await assertLocationsInOrg(q, ctx.orgId, body.locationIds);
      if (body.staffId) await assertStaffAvailable(q, ctx.orgId, body.staffId);
      const emailNorm = normalizeEmail(body.email)!;
      const already = await q.maybeOne(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email_normalized = $2`,
        [ctx.orgId, emailNorm],
      );
      if (already) throw new AppError('CONFLICT', 'このメールアドレスはすでにメンバーです');
      await q.exec(
        `UPDATE invitations SET revoked_at = $3 WHERE organization_id = $1 AND email_normalized = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, emailNorm, now],
      );
      const token = randomToken(32);
      const inv = await q.one<{ id: string; expires_at: Date }>(
        `INSERT INTO invitations (organization_id, email, email_normalized, role, all_locations, location_ids, staff_id,
                                  token_hash, expires_at, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, expires_at`,
        [
          ctx.orgId,
          body.email,
          emailNorm,
          body.role,
          body.role === 'owner' || body.allLocations,
          body.locationIds,
          body.staffId ?? null,
          sha256(token),
          new Date(now.getTime() + 7 * 24 * 3600_000),
          ctx.membershipId,
        ],
      );
      const url = `${config.APP_BASE_URL}/invite/${token}`;
      if (body.sendEmail) {
        await enqueueNotification(q, {
          orgId: ctx.orgId,
          type: 'member_invitation',
          recipient: body.email,
          idempotencyKey: `member_invitation:${inv.id}`,
          payload: { url, orgName: ctx.orgName, role: body.role, inviter: ctx.userName },
        });
      }
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'member.invited',
        targetType: 'invitation',
        targetId: inv.id,
        after: { role: body.role, allLocations: body.allLocations, locationIds: body.locationIds, staffId: body.staffId ?? null },
        requestId: req.id,
      });
      // 招待URLは作成者にだけ一度返す(メールが使えない環境でも手渡しできるように)
      return { id: inv.id, inviteUrl: url, expiresAt: inv.expires_at };
    });
  });

  app.delete('/api/v1/members/invitations/:id', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.exec(
        'UPDATE invitations SET revoked_at = $3 WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
        [ctx.orgId, id, clock.now()],
      );
      if (n === 0) throw notFound('招待');
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'member.invitation_revoked', targetType: 'invitation', targetId: id, requestId: req.id });
      return { ok: true };
    });
  });

  app.patch('/api/v1/members/:id', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(MemberPatchSchema, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<{ id: string; role: Role; status: string; all_locations: boolean; staff_id: string | null }>(
        'SELECT id, role, status, all_locations, staff_id FROM memberships WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [ctx.orgId, id],
      );
      if (!cur) throw notFound('メンバー');
      const curLocs = (
        await q.many<{ location_id: string }>('SELECT location_id FROM membership_locations WHERE membership_id = $1', [id])
      ).map((r) => r.location_id);
      const nextRole = body.role ?? cur.role;
      if (cur.role === 'owner' && nextRole !== 'owner' && cur.status === 'active' && (await activeOwnerCount(q, ctx.orgId)) <= 1) {
        throw new AppError('INVALID_STATE', 'オーナーが1人もいなくなるため変更できません');
      }
      if (body.locationIds) await assertLocationsInOrg(q, ctx.orgId, body.locationIds);
      if (body.staffId) await assertStaffAvailable(q, ctx.orgId, body.staffId, id);
      const nextAll = nextRole === 'owner' ? true : (body.allLocations ?? cur.all_locations);
      const nextStaff = body.staffId !== undefined ? body.staffId : cur.staff_id;
      await q.exec('UPDATE memberships SET role = $3, all_locations = $4, staff_id = $5 WHERE organization_id = $1 AND id = $2', [
        ctx.orgId,
        id,
        nextRole,
        nextAll,
        nextStaff,
      ]);
      if (body.locationIds) {
        await q.exec('DELETE FROM membership_locations WHERE membership_id = $1', [id]);
        for (const loc of new Set(body.locationIds)) {
          await q.exec('INSERT INTO membership_locations (organization_id, membership_id, location_id) VALUES ($1,$2,$3)', [ctx.orgId, id, loc]);
        }
      }
      const roleChanged = nextRole !== cur.role;
      const scopeChanged = nextAll !== cur.all_locations || (body.locationIds && JSON.stringify([...body.locationIds].sort()) !== JSON.stringify([...curLocs].sort()));
      // 権限は毎リクエストDBから読むため即時反映。ロール変更時は他端末のセッションも失効させる
      if (roleChanged && id !== ctx.membershipId) await revokeMembershipSessions(q, id);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'member.permissions_changed',
        targetType: 'membership',
        targetId: id,
        before: { role: cur.role, allLocations: cur.all_locations, locationIds: curLocs, staffId: cur.staff_id },
        after: { role: nextRole, allLocations: nextAll, locationIds: body.locationIds ?? curLocs, staffId: nextStaff },
        metadata: { roleChanged, scopeChanged: Boolean(scopeChanged) },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  app.post('/api/v1/members/:id/status', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.maybeOne<{ role: Role; status: string }>(
        'SELECT role, status FROM memberships WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [ctx.orgId, id],
      );
      if (!cur) throw notFound('メンバー');
      if (body.status === 'disabled') {
        if (id === ctx.membershipId) throw new AppError('INVALID_STATE', '自分自身は無効化できません');
        if (cur.role === 'owner' && (await activeOwnerCount(q, ctx.orgId)) <= 1) {
          throw new AppError('INVALID_STATE', 'オーナーが1人もいなくなるため無効化できません');
        }
      }
      await q.exec(
        `UPDATE memberships SET status = $3, disabled_at = CASE WHEN $3 = 'disabled' THEN now() ELSE NULL END
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.status],
      );
      let revoked = 0;
      if (body.status === 'disabled') revoked = await revokeMembershipSessions(q, id);
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: body.status === 'disabled' ? 'member.disabled' : 'member.enabled',
        targetType: 'membership',
        targetId: id,
        before: { status: cur.status },
        after: { status: body.status },
        metadata: { sessionsRevoked: revoked },
        requestId: req.id,
      });
      return { ok: true, sessionsRevoked: revoked };
    });
  });

  // メールを使わないスタッフ向け: 管理者がパスワード再設定リンクを発行して手渡す
  app.post('/api/v1/members/:id/password-reset-link', async (req) => {
    const ctx = requireAuth(req, 'member.manage');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const now = clock.now();
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const m = await q.maybeOne<{ user_id: string; status: string }>(
        'SELECT user_id, status FROM memberships WHERE organization_id = $1 AND id = $2',
        [ctx.orgId, id],
      );
      if (!m || m.status !== 'active') throw notFound('メンバー');
      const token = randomToken(32);
      await q.exec(
        `INSERT INTO password_reset_tokens (user_id, organization_id, token_hash, expires_at, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [m.user_id, ctx.orgId, sha256(token), new Date(now.getTime() + 24 * 3600_000), ctx.membershipId],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'member.password_reset_link_issued', targetType: 'membership', targetId: id, requestId: req.id });
      return { url: `${config.APP_BASE_URL}/reset-password?token=${token}`, expiresInHours: 24 };
    });
  });
}
