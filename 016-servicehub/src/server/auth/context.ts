import type { FastifyRequest } from 'fastify';
import { type Permission, type Role, ROLE_PERMISSIONS } from '../../shared/permissions.js';
import { AppError, forbidden, notFound } from '../errors.js';
import type { SessionRow } from './session.js';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  userId: string;
  userName: string;
  userEmail: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgTimezone: string;
  orgIsSample: boolean;
  membershipId: string;
  role: Role;
  staffId: string | null;
  /** owner または all_locations=true */
  allLocations: boolean;
  locationIds: string[];
  permissions: ReadonlySet<Permission>;
}

/** 組織未選択のセッション(ユーザーとしてはログイン済み) */
export interface UserOnlyContext {
  sessionId: string;
  csrfToken: string;
  userId: string;
  userName: string;
  userEmail: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRow | null;
  }
}

export function contextFromSession(s: SessionRow): AuthContext | null {
  if (!s.organization_id || !s.membership_id || !s.role) return null;
  const role = s.role as Role;
  return {
    sessionId: s.id,
    csrfToken: s.csrf_token,
    userId: s.user_id,
    userName: s.user_name,
    userEmail: s.user_email,
    orgId: s.organization_id,
    orgName: s.org_name ?? '',
    orgSlug: s.org_slug ?? '',
    orgTimezone: s.org_timezone ?? 'Asia/Tokyo',
    orgIsSample: Boolean(s.org_is_sample),
    membershipId: s.membership_id,
    role,
    staffId: s.staff_id,
    allLocations: role === 'owner' || Boolean(s.all_locations),
    locationIds: s.location_ids ?? [],
    permissions: ROLE_PERMISSIONS[role] ?? new Set(),
  };
}

/** 認証必須 + 指定した権限のいずれかを要求(サーバー側認可) */
export function requireAuth(req: FastifyRequest, ...anyOf: Permission[]): AuthContext {
  const s = req.session;
  if (!s) throw new AppError('UNAUTHENTICATED', 'ログインが必要です');
  const ctx = contextFromSession(s);
  if (!ctx) throw new AppError('FORBIDDEN', '組織が選択されていません');
  if (anyOf.length > 0 && !anyOf.some((p) => ctx.permissions.has(p))) {
    throw forbidden();
  }
  return ctx;
}

export function requireUser(req: FastifyRequest): UserOnlyContext {
  const s = req.session;
  if (!s) throw new AppError('UNAUTHENTICATED', 'ログインが必要です');
  return { sessionId: s.id, csrfToken: s.csrf_token, userId: s.user_id, userName: s.user_name, userEmail: s.user_email };
}

export function can(ctx: AuthContext, p: Permission): boolean {
  return ctx.permissions.has(p);
}

export function assertCan(ctx: AuthContext, p: Permission, message?: string): void {
  if (!ctx.permissions.has(p)) throw forbidden(message);
}

export function canAccessLocation(ctx: AuthContext, locationId: string | null | undefined): boolean {
  if (!locationId) return false;
  return ctx.allLocations || ctx.locationIds.includes(locationId);
}

/** 権限外拠点は存在を明かさず 404 */
export function assertLocation(ctx: AuthContext, locationId: string | null | undefined, what = '拠点'): void {
  if (!canAccessLocation(ctx, locationId)) throw notFound(what);
}

/** SQL 用: 全拠点なら null、限定なら配列 */
export function locationScope(ctx: AuthContext): string[] | null {
  return ctx.allLocations ? null : ctx.locationIds;
}

/** ".all" を持たず ".own" のみの場合に担当スタッフIDでの制限が必要 */
export function ownOnly(ctx: AuthContext, all: Permission, own: Permission): boolean {
  if (ctx.permissions.has(all)) return false;
  if (ctx.permissions.has(own)) return true;
  throw forbidden();
}
