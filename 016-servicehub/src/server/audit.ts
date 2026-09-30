import type { AuthContext } from './auth/context.js';
import type { Q } from './db/tx.js';

export interface Actor {
  type: 'member' | 'customer' | 'system' | 'operator';
  userId?: string | null;
  membershipId?: string | null;
  label?: string | null;
}

export function actorOf(ctx: AuthContext): Actor {
  return { type: 'member', userId: ctx.userId, membershipId: ctx.membershipId, label: ctx.userName };
}

export const SYSTEM_ACTOR: Actor = { type: 'system', label: 'システム' };
export const CUSTOMER_ACTOR: Actor = { type: 'customer', label: '顧客' };

/**
 * 監査ログに値を残さない項目(個人情報・自由記述・秘密)。変更があった事実だけ "[変更あり]" で残す。
 */
const PII_KEYS = new Set([
  'name',
  'nameKana',
  'name_kana',
  'email',
  'phone',
  'address',
  'memo',
  'body',
  'note',
  'notes',
  'internalNote',
  'internal_note',
  'internalMemo',
  'internal_memo',
  'customerMemo',
  'customer_memo',
  'customerRequest',
  'customer_request',
  'answers',
  'contact',
  'contactSnapshot',
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'publicProfile',
  'public_profile',
  'internalName',
  'internal_name',
]);

const SECRET_KEYS = new Set(['password', 'passwordHash', 'token', 'tokenHash', 'csrfToken']);

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = PII_KEYS.has(k) ? (v == null || v === '' ? v : '[変更あり]') : redact(v);
    }
    return out;
  }
  return value;
}

/** before/after のうち変更された項目だけを返す(値は redact 済み) */
export function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const bv = before[key];
    const av = after[key];
    if (JSON.stringify(bv ?? null) !== JSON.stringify(av ?? null)) {
      b[key] = bv;
      a[key] = av;
    }
  }
  if (Object.keys(a).length === 0) return null;
  return { before: redact(b) as Record<string, unknown>, after: redact(a) as Record<string, unknown> };
}

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  locationId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | null;
}

export async function writeAudit(q: Q, orgId: string, actor: Actor, e: AuditEntry): Promise<void> {
  await q.exec(
    `INSERT INTO audit_logs (organization_id, actor_type, actor_user_id, actor_membership_id, actor_label,
                             action, target_type, target_id, location_id, before, after, metadata, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      orgId,
      actor.type,
      actor.userId ?? null,
      actor.membershipId ?? null,
      actor.label ?? null,
      e.action,
      e.targetType,
      e.targetId ?? null,
      e.locationId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.metadata === undefined ? null : JSON.stringify(redact(e.metadata)),
      e.requestId ?? null,
    ],
  );
}
