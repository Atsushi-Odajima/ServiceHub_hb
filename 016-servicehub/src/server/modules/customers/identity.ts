import { normalizeEmail, normalizeName, normalizePhone } from '../../../shared/normalize.js';
import { advisoryLockAll, type Q } from '../../db/tx.js';
import { AppError, notFound } from '../../errors.js';

export interface NewCustomerInput {
  name: string;
  nameKana?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CustomerRow {
  id: string;
  name: string;
  name_kana: string | null;
  email: string | null;
  phone: string | null;
  status: string;
}

/** 顧客行の正規化キーを計算 */
export function customerKeys(c: NewCustomerInput) {
  return {
    email_normalized: normalizeEmail(c.email),
    phone_normalized: normalizePhone(c.phone),
    name_norm: normalizeName(c.name),
    kana_norm: c.nameKana ? normalizeName(c.nameKana) : null,
  };
}

export async function insertCustomer(
  q: Q,
  orgId: string,
  c: NewCustomerInput & { tags?: string[]; memo?: string | null; preferredLocationId?: string | null },
  source: 'public' | 'staff' | 'import',
  createdBy: string | null,
): Promise<string> {
  const k = customerKeys(c);
  const row = await q.one<{ id: string }>(
    `INSERT INTO customers (organization_id, name, name_kana, email, email_normalized, phone, phone_normalized, name_norm, kana_norm,
                            tags, memo, preferred_location_id, source, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      orgId,
      c.name.trim(),
      c.nameKana?.trim() || null,
      c.email?.trim() || null,
      k.email_normalized,
      c.phone?.trim() || null,
      k.phone_normalized,
      k.name_norm,
      k.kana_norm,
      c.tags ?? [],
      c.memo ?? null,
      c.preferredLocationId ?? null,
      source,
      createdBy,
    ],
  );
  return row.id;
}

/**
 * 予約用の顧客を決定する(DECISIONS D-013)。
 * - customerId 指定: 有効な顧客であること
 * - 新規入力: 正規化メール一致 かつ 正規化氏名一致 の有効顧客が1人だけなら紐付け。それ以外は新規作成(重複は候補表示のみ・自動統合しない)
 */
export async function resolveCustomer(
  q: Q,
  orgId: string,
  input: { customerId: string } | NewCustomerInput,
  opts: { source: 'public' | 'staff'; createdBy: string | null },
): Promise<{ customerId: string; created: boolean; row: CustomerRow }> {
  if ('customerId' in input) {
    const row = await q.maybeOne<CustomerRow>(
      'SELECT id, name, name_kana, email, phone, status FROM customers WHERE organization_id = $1 AND id = $2',
      [orgId, input.customerId],
    );
    if (!row) throw notFound('顧客');
    if (row.status !== 'active') {
      throw new AppError('INVALID_STATE', row.status === 'merged' ? 'この顧客は統合済みです。統合先の顧客を選んでください' : 'この顧客は予約に使用できません(アーカイブ/匿名化済み)');
    }
    return { customerId: row.id, created: false, row };
  }
  const k = customerKeys(input);
  if (k.email_normalized) {
    await advisoryLockAll(q, [`customer-email:${orgId}:${k.email_normalized}`]);
    const matches = await q.many<CustomerRow>(
      `SELECT id, name, name_kana, email, phone, status FROM customers
        WHERE organization_id = $1 AND email_normalized = $2 AND name_norm = $3 AND status = 'active' LIMIT 2`,
      [orgId, k.email_normalized, k.name_norm],
    );
    if (matches.length === 1) return { customerId: matches[0].id, created: false, row: matches[0] };
  }
  const id = await insertCustomer(q, orgId, input, opts.source, opts.createdBy);
  const row = await q.one<CustomerRow>('SELECT id, name, name_kana, email, phone, status FROM customers WHERE id = $1', [id]);
  return { customerId: id, created: true, row };
}
