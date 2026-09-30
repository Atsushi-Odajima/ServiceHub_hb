import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeEmail, normalizeName, normalizePhone, prefixUpperBound } from '../../../shared/normalize.js';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { type AuthContext, assertCan, can, requireAuth } from '../../auth/context.js';
import { withTenant, type Q } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, invalidState, notFound, versionConflict } from '../../errors.js';
import { parse, zOptEmail, zOptText, zPhone, zUuid } from '../../http/validate.js';
import { customerKeys, insertCustomer } from './identity.js';
import { assertCustomerVisible, customerVisibility } from './visibility.js';

export interface CustomerRowFull {
  id: string;
  name: string;
  name_kana: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  memo: string | null;
  preferred_location_id: string | null;
  status: string;
  merged_into_id: string | null;
  source: string;
  first_visit_at: Date | null;
  last_visit_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function customerDto(c: CustomerRowFull) {
  return {
    id: c.id,
    name: c.name,
    nameKana: c.name_kana,
    email: c.email,
    phone: c.phone,
    tags: c.tags,
    memo: c.memo,
    preferredLocationId: c.preferred_location_id,
    status: c.status,
    mergedIntoId: c.merged_into_id,
    source: c.source,
    firstVisitAt: c.first_visit_at,
    lastVisitAt: c.last_visit_at,
    version: c.version,
    createdAt: c.created_at,
  };
}

const CustomerInput = z.object({
  name: z.string().trim().min(1).max(100),
  nameKana: zOptText(100),
  email: zOptEmail,
  phone: zPhone,
  tags: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  memo: zOptText(4000),
  preferredLocationId: zUuid.nullable().optional(),
});

/** 検索語 → 前方一致条件(RLS下でも索引が使える比較演算のみ) */
function searchCondition(qstr: string, params: unknown[]): string | null {
  const raw = qstr.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (/^[0-9０-９\-+() 　]+$/.test(raw) && digits.length >= 3) {
    const d = normalizePhone(raw)!;
    params.push(d, prefixUpperBound(d));
    const a = params.length - 1;
    const rev = [...d].reverse().join('');
    params.push(rev, prefixUpperBound(rev));
    const b = params.length - 1;
    // 前方一致(090…)または末尾一致(下4桁)
    return `((c.phone_normalized >= $${a} AND c.phone_normalized < $${a + 1}) OR (c.phone_reversed >= $${b} AND c.phone_reversed < $${b + 1}))`;
  }
  if (raw.includes('@')) {
    const e = normalizeEmail(raw)!;
    params.push(e, prefixUpperBound(e));
    const i = params.length - 1;
    return `(c.email_normalized >= $${i} AND c.email_normalized < $${i + 1})`;
  }
  const n = normalizeName(raw);
  params.push(n, prefixUpperBound(n));
  const i = params.length - 1;
  return `((c.name_norm >= $${i} AND c.name_norm < $${i + 1}) OR (c.kana_norm >= $${i} AND c.kana_norm < $${i + 1}))`;
}

async function loadCustomer(q: Q, orgId: string, id: string, forUpdate = false): Promise<CustomerRowFull> {
  const c = await q.maybeOne<CustomerRowFull>(
    `SELECT * FROM customers WHERE organization_id = $1 AND id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orgId, id],
  );
  if (!c) throw notFound('顧客');
  return c;
}

/** 検索語で顧客を探す(電話/メール/氏名・かなの前方一致 → 足りなければ部分一致)。where/params には可視性条件を含めて渡す */
export async function searchCustomerRows(q: Q, where: string[], params: unknown[], text: string, order: string, limit: number): Promise<CustomerRowFull[]> {
  let rows: CustomerRowFull[] = [];
  const p1 = [...params];
  const cond = searchCondition(text, p1);
  if (cond) {
    p1.push(limit);
    rows = await q.many<CustomerRowFull>(`SELECT c.* FROM customers c WHERE ${[...where, cond].join(' AND ')} ORDER BY ${order} LIMIT $${p1.length}`, p1);
  }
  // 前方一致で足りない場合は部分一致(組織内で絞り込み、件数上限あり)
  if (rows.length < limit && text.trim().length >= 2 && !/^[0-9\-+() ]+$/.test(text)) {
    const p2 = [...params];
    p2.push(`%${normalizeName(text).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    const likeIdx = p2.length;
    p2.push(rows.map((r) => r.id));
    const exIdx = p2.length;
    p2.push(limit - rows.length);
    const more = await q.many<CustomerRowFull>(
      `SELECT c.* FROM customers c WHERE ${where.join(' AND ')} AND (c.name_norm LIKE $${likeIdx} OR c.kana_norm LIKE $${likeIdx})
         AND NOT (c.id = ANY($${exIdx}::uuid[])) ORDER BY ${order} LIMIT $${p2.length}`,
      p2,
    );
    rows = rows.concat(more);
  }
  return rows;
}

export async function registerCustomerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock } = deps;

  app.get('/api/v1/customers', async (req) => {
    const ctx = requireAuth(req, 'customer.read');
    const qy = parse(
      z.object({
        q: z.string().max(100).optional(),
        tag: z.string().max(30).optional(),
        status: z.enum(['active', 'archived', 'merged', 'anonymized', 'all']).default('active'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        sort: z.enum(['recent_visit', 'created', 'name']).default('recent_visit'),
      }),
      req.query,
    );
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const params: unknown[] = [ctx.orgId];
      const vis = await customerVisibility(q, ctx, 'c', params, clock.now());
      const where = [`c.organization_id = $1`, vis];
      if (qy.status !== 'all') {
        params.push(qy.status);
        where.push(`c.status = $${params.length}`);
      }
      if (qy.tag) {
        params.push(qy.tag);
        where.push(`$${params.length} = ANY(c.tags)`);
      }
      const order =
        qy.sort === 'created' ? 'c.created_at DESC, c.id DESC' : qy.sort === 'name' ? 'c.name_norm ASC, c.id' : 'c.last_visit_at DESC NULLS LAST, c.created_at DESC, c.id DESC';
      const rows = qy.q ? await searchCustomerRows(q, where, params, qy.q, order, qy.limit) : await q.many<CustomerRowFull>(`SELECT c.* FROM customers c WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.push(qy.limit)}`, params);
      return { items: rows.map((r) => ({ ...customerDto(r), memo: undefined })) };
    });
  });

  app.post('/api/v1/customers', async (req) => {
    const ctx = requireAuth(req, 'customer.create');
    const body = parse(CustomerInput, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const id = await insertCustomer(q, ctx.orgId, body, 'staff', ctx.membershipId);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'customer.created', targetType: 'customer', targetId: id, after: { name: body.name }, requestId: req.id });
      const dupes = await findDuplicates(q, ctx.orgId, id);
      return { ...customerDto(await loadCustomer(q, ctx.orgId, id)), duplicateCandidates: dupes.length };
    });
  });

  app.get('/api/v1/customers/:id', async (req) => {
    const ctx = requireAuth(req, 'customer.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      const c = await loadCustomer(q, ctx.orgId, id);
      await assertCustomerVisible(q, ctx, id, clock.now());
      const stats = await q.one<{ total: number; completed: number; canceled_customer: number; canceled_business: number; no_show: number; upcoming: number }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE status = 'completed') AS completed,
                count(*) FILTER (WHERE status = 'canceled_customer') AS canceled_customer,
                count(*) FILTER (WHERE status = 'canceled_business') AS canceled_business,
                count(*) FILTER (WHERE status = 'no_show') AS no_show,
                count(*) FILTER (WHERE status IN ('confirmed','arrived','in_service') AND starts_at >= $3) AS upcoming
           FROM bookings WHERE organization_id = $1 AND customer_id = $2`,
        [ctx.orgId, id, clock.now()],
      );
      const next = await q.maybeOne<{ id: string; starts_at: Date; service_snapshot: { name: string }; location_snapshot: { name: string; timezone: string } }>(
        `SELECT id, starts_at, service_snapshot, location_snapshot FROM bookings
          WHERE organization_id = $1 AND customer_id = $2 AND status IN ('confirmed','arrived') AND starts_at >= $3 ORDER BY starts_at LIMIT 1`,
        [ctx.orgId, id, clock.now()],
      );
      const favorite = await q.maybeOne<{ location_id: string; n: number }>(
        `SELECT location_id, count(*) AS n FROM bookings WHERE organization_id = $1 AND customer_id = $2 AND status = 'completed'
          GROUP BY location_id ORDER BY n DESC LIMIT 1`,
        [ctx.orgId, id],
      );
      const dupes = c.status === 'active' ? await findDuplicates(q, ctx.orgId, id) : [];
      return {
        ...customerDto(c),
        // 内部メモ(顧客レコードのメモ)は一般メモ扱い。機密メモは customer_notes(visibility=confidential)
        memo: can(ctx, 'customer.note.general') ? c.memo : undefined,
        stats,
        nextBooking: next ? { id: next.id, startsAt: next.starts_at, serviceName: next.service_snapshot.name, locationName: next.location_snapshot.name, timezone: next.location_snapshot.timezone } : null,
        favoriteLocationId: favorite?.location_id ?? null,
        duplicateCandidates: dupes,
      };
    });
  });

  app.patch('/api/v1/customers/:id', async (req) => {
    const ctx = requireAuth(req, 'customer.update');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(CustomerInput.partial().extend({ expectedVersion: z.number().int() }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await loadCustomer(q, ctx.orgId, id, true);
      await assertCustomerVisible(q, ctx, id, clock.now());
      if (cur.version !== body.expectedVersion) throw versionConflict();
      if (cur.status !== 'active') throw invalidState('この顧客は編集できません(統合済み/匿名化済み/アーカイブ)');
      if (body.memo !== undefined && !can(ctx, 'customer.note.general')) throw forbidden();
      const next = {
        name: body.name ?? cur.name,
        nameKana: body.nameKana !== undefined ? body.nameKana : cur.name_kana,
        email: body.email !== undefined ? body.email : cur.email,
        phone: body.phone !== undefined ? body.phone : cur.phone,
        tags: body.tags ?? cur.tags,
        memo: body.memo !== undefined ? body.memo : cur.memo,
        preferredLocationId: body.preferredLocationId !== undefined ? body.preferredLocationId : cur.preferred_location_id,
      };
      const k = customerKeys(next);
      const r = await q.one<CustomerRowFull>(
        `UPDATE customers SET name=$3, name_kana=$4, email=$5, email_normalized=$6, phone=$7, phone_normalized=$8, name_norm=$9, kana_norm=$10,
                tags=$11, memo=$12, preferred_location_id=$13, version = version + 1
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.orgId, id, next.name, next.nameKana, next.email, k.email_normalized, next.phone, k.phone_normalized, k.name_norm, k.kana_norm, next.tags, next.memo, next.preferredLocationId],
      );
      const diff = changes(
        { name: cur.name, nameKana: cur.name_kana, email: cur.email, phone: cur.phone, tags: cur.tags, memo: cur.memo, preferredLocationId: cur.preferred_location_id },
        next,
      );
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'customer.updated', targetType: 'customer', targetId: id, before: diff.before, after: diff.after, requestId: req.id });
      }
      return customerDto(r);
    });
  });

  // ---- タイムライン ----
  app.get('/api/v1/customers/:id/timeline', async (req) => {
    const ctx = requireAuth(req, 'customer.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    // ページング: before = "<ISO日時>" または "<ISO日時>|<行ID>"(同じ日時の行を取りこぼさない)
    const { before, limit } = parse(
      z.object({
        before: z
          .string()
          .regex(/^[0-9T:.+\-Z]{10,40}(\|[0-9a-f-]{36})?$/, '不正な値です')
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    const [beforeAt, beforeId] = before ? before.split('|') : [null, null];
    if (beforeAt && Number.isNaN(Date.parse(beforeAt))) throw new AppError('VALIDATION_ERROR', '不正な値です', { fields: { before: '日時の形式が正しくありません' } });
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      await loadCustomer(q, ctx.orgId, id);
      await assertCustomerVisible(q, ctx, id, clock.now());
      const items = await timeline(q, ctx, id, beforeAt, beforeId ?? null, limit);
      const last = items[items.length - 1];
      return { items: items.map(({ cursor: _c, ...rest }) => rest), nextBefore: items.length === limit && last ? last.cursor : null };
    });
  });

  // ---- 対応メモ ----
  app.post('/api/v1/customers/:id/notes', async (req) => {
    const ctx = requireAuth(req, 'customer.note.general', 'customer.note.confidential');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ body: z.string().trim().min(1).max(4000), visibility: z.enum(['general', 'confidential']).default('general') }), req.body);
    if (body.visibility === 'confidential') assertCan(ctx, 'customer.note.confidential');
    else assertCan(ctx, 'customer.note.general');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const c = await loadCustomer(q, ctx.orgId, id);
      await assertCustomerVisible(q, ctx, id, clock.now());
      if (c.status === 'anonymized') throw invalidState('匿名化済みの顧客にはメモを追加できません');
      const n = await q.one<{ id: string; created_at: Date }>(
        `INSERT INTO customer_notes (organization_id, customer_id, body, visibility, author_membership_id, author_label)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [ctx.orgId, id, body.body, body.visibility, ctx.membershipId, ctx.userName],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'customer.note_added',
        targetType: 'customer',
        targetId: id,
        after: { visibility: body.visibility, body: body.body },
        requestId: req.id,
      });
      return { id: n.id, createdAt: n.created_at };
    });
  });

  app.delete('/api/v1/customers/:id/notes/:noteId', async (req) => {
    const ctx = requireAuth(req, 'customer.note.general', 'customer.note.confidential');
    const { id, noteId } = parse(z.object({ id: zUuid, noteId: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const n = await q.maybeOne<{ author_membership_id: string | null; visibility: string }>(
        'SELECT author_membership_id, visibility FROM customer_notes WHERE organization_id = $1 AND customer_id = $2 AND id = $3 AND deleted_at IS NULL',
        [ctx.orgId, id, noteId],
      );
      if (!n) throw notFound('メモ');
      if (n.visibility === 'confidential' && !can(ctx, 'customer.note.confidential')) throw notFound('メモ');
      if (n.author_membership_id !== ctx.membershipId && !can(ctx, 'customer.merge')) throw forbidden('他の人のメモは削除できません');
      await q.exec('UPDATE customer_notes SET deleted_at = $4, body = $5 WHERE organization_id = $1 AND customer_id = $2 AND id = $3', [
        ctx.orgId,
        id,
        noteId,
        clock.now(),
        '[削除済み]',
      ]);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'customer.note_deleted', targetType: 'customer', targetId: id, requestId: req.id });
      return { ok: true };
    });
  });

  // ---- 重複候補・統合 ----
  app.get('/api/v1/customers/:id/duplicates', async (req) => {
    const ctx = requireAuth(req, 'customer.read');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
      await assertCustomerVisible(q, ctx, id, clock.now());
      return { items: await findDuplicates(q, ctx.orgId, id) };
    });
  });

  app.post('/api/v1/customers/:id/merge', async (req) => {
    const ctx = requireAuth(req, 'customer.merge');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ mergeFromId: zUuid, confirm: z.literal(true), reason: zOptText(500) }), req.body);
    if (body.mergeFromId === id) throw new AppError('VALIDATION_ERROR', '同じ顧客は統合できません');
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      // 統合は確認付きの手動操作のみ(自動統合はしない)。両顧客をロック
      const [first, second] = [id, body.mergeFromId].sort();
      await loadCustomer(q, ctx.orgId, first, true);
      await loadCustomer(q, ctx.orgId, second, true);
      const s = await loadCustomer(q, ctx.orgId, id);
      const m = await loadCustomer(q, ctx.orgId, body.mergeFromId);
      await assertCustomerVisible(q, ctx, id, clock.now());
      await assertCustomerVisible(q, ctx, body.mergeFromId, clock.now());
      if (s.status !== 'active' || m.status !== 'active') throw invalidState('有効な顧客同士のみ統合できます');
      const moved: Record<string, number> = {};
      for (const [table, label] of [
        ['bookings', 'bookings'],
        ['booking_events', 'bookingEvents'],
        ['service_records', 'serviceRecords'],
        ['customer_passes', 'passes'],
        ['customer_plans', 'plans'],
        ['customer_notes', 'notes'],
        ['waitlist_entries', 'waitlist'],
        ['notifications', 'notifications'],
      ] as const) {
        moved[label] = await q.exec(`UPDATE ${table} SET customer_id = $3 WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, m.id, s.id]);
      }
      const tags = [...new Set([...s.tags, ...m.tags])];
      const fill = {
        name_kana: s.name_kana ?? m.name_kana,
        email: s.email ?? m.email,
        phone: s.phone ?? m.phone,
      };
      const k = customerKeys({ name: s.name, nameKana: fill.name_kana, email: fill.email, phone: fill.phone });
      await q.exec(
        `UPDATE customers SET tags = $3, name_kana = $4, email = $5, email_normalized = $6, phone = $7, phone_normalized = $8, kana_norm = $9,
                first_visit_at = (SELECT min(x) FROM unnest(ARRAY[first_visit_at, $10::timestamptz]) x),
                last_visit_at = (SELECT max(x) FROM unnest(ARRAY[last_visit_at, $11::timestamptz]) x),
                version = version + 1
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, s.id, tags, fill.name_kana, fill.email, k.email_normalized, fill.phone, k.phone_normalized, k.kana_norm, m.first_visit_at, m.last_visit_at],
      );
      await q.exec(`UPDATE customers SET status = 'merged', merged_into_id = $3, version = version + 1 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, m.id, s.id]);
      await q.exec(
        `INSERT INTO customer_merges (organization_id, survivor_id, merged_id, moved_counts, reason, actor_membership_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.orgId, s.id, m.id, JSON.stringify(moved), body.reason, ctx.membershipId],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: 'customer.merged',
        targetType: 'customer',
        targetId: s.id,
        metadata: { mergedId: m.id, moved, reason: body.reason },
        requestId: req.id,
      });
      return { ok: true, survivorId: s.id, mergedId: m.id, moved };
    });
  });

  // ---- アーカイブ・匿名化・エクスポート ----
  app.post('/api/v1/customers/:id/archive', async (req) => {
    const ctx = requireAuth(req, 'customer.archive');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const c = await loadCustomer(q, ctx.orgId, id, true);
      await assertCustomerVisible(q, ctx, id, clock.now());
      if (!['active', 'archived'].includes(c.status)) throw invalidState('この顧客は変更できません');
      await q.exec(
        `UPDATE customers SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE NULL END, version = version + 1 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.archived ? 'archived' : 'active'],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), {
        action: body.archived ? 'customer.archived' : 'customer.unarchived',
        targetType: 'customer',
        targetId: id,
        before: { status: c.status },
        after: { status: body.archived ? 'archived' : 'active' },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  /**
   * 匿名化(削除要求への対応)。予約・台帳・実施記録・監査の件数と関係は保持し、個人を特定できる情報のみ消去する。
   * 法的適合を保証するものではない(SECURITY.md §10)。
   */
  app.post('/api/v1/customers/:id/anonymize', async (req) => {
    const ctx = requireAuth(req, 'customer.anonymize');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ confirmName: z.string().trim().min(1) }), req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const c = await loadCustomer(q, ctx.orgId, id, true);
      if (c.status === 'anonymized') throw invalidState('すでに匿名化されています');
      if (normalizeName(body.confirmName) !== normalizeName(c.name)) {
        throw new AppError('VALIDATION_ERROR', '確認のため顧客名を正しく入力してください', { fields: { confirmName: '氏名が一致しません' } });
      }
      const upcoming = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM bookings WHERE organization_id = $1 AND customer_id = $2 AND status IN ('confirmed','arrived','in_service') AND starts_at > $3`,
        [ctx.orgId, id, clock.now()],
      );
      if (upcoming.n > 0) throw invalidState(`今後の予約が${upcoming.n}件あります。先にキャンセルしてください`);
      await q.exec(
        `UPDATE customers SET name = '匿名化済み顧客', name_kana = NULL, email = NULL, email_normalized = NULL, phone = NULL, phone_normalized = NULL,
                name_norm = '', kana_norm = NULL, tags = '{}', memo = NULL, status = 'anonymized', anonymized_at = $3, version = version + 1
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, clock.now()],
      );
      await q.exec(`UPDATE bookings SET contact_snapshot = '{}'::jsonb, customer_request = NULL WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(
        `UPDATE booking_answers SET answer = '"[匿名化済み]"'::jsonb WHERE organization_id = $1 AND booking_id IN (SELECT id FROM bookings WHERE organization_id = $1 AND customer_id = $2)`,
        [ctx.orgId, id],
      );
      await q.exec(`UPDATE customer_notes SET body = '[匿名化済み]' WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(`UPDATE service_records SET internal_memo = NULL, customer_memo = NULL, next_recommended_note = NULL WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(`UPDATE customer_passes SET memo = NULL WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(`UPDATE customer_plans SET memo = NULL WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(`UPDATE waitlist_entries SET note = NULL WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await q.exec(`UPDATE notifications SET recipient = NULL, payload = '{}'::jsonb WHERE organization_id = $1 AND customer_id = $2`, [ctx.orgId, id]);
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'customer.anonymized', targetType: 'customer', targetId: id, requestId: req.id });
      return { ok: true };
    });
  });

  app.get('/api/v1/customers/:id/export', async (req, reply) => {
    const ctx = requireAuth(req, 'customer.export');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const data = await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const c = await loadCustomer(q, ctx.orgId, id);
      await assertCustomerVisible(q, ctx, id, clock.now());
      const bookings = await q.many(
        `SELECT code, starts_at, ends_at, status, service_snapshot->>'name' AS service, location_snapshot->>'name' AS location,
                staff_snapshot->>'displayName' AS staff, party_size, customer_request, contact_snapshot, canceled_at, cancel_reason
           FROM bookings WHERE organization_id = $1 AND customer_id = $2 ORDER BY starts_at, id`,
        [ctx.orgId, id],
      );
      const answers = await q.many(
        `SELECT b.code, a.question_snapshot->>'label' AS question, a.answer FROM booking_answers a JOIN bookings b ON b.id = a.booking_id
          WHERE a.organization_id = $1 AND b.customer_id = $2 ORDER BY b.starts_at, b.id, a.sort_order, a.id`,
        [ctx.orgId, id],
      );
      const records = await q.many(
        `SELECT performed_at, service_snapshot->>'name' AS service, customer_memo, next_recommended_on FROM service_records
          WHERE organization_id = $1 AND customer_id = $2 AND status = 'active' ORDER BY performed_at, id`,
        [ctx.orgId, id],
      );
      const passes = await q.many(
        `SELECT cp.product_snapshot->>'name' AS name, cp.starts_on, cp.expires_on, cp.initial_uses, cp.remaining, cp.status FROM customer_passes cp
          WHERE cp.organization_id = $1 AND cp.customer_id = $2`,
        [ctx.orgId, id],
      );
      const plans = await q.many(
        `SELECT product_snapshot->>'name' AS name, starts_on, ends_on, status FROM customer_plans WHERE organization_id = $1 AND customer_id = $2`,
        [ctx.orgId, id],
      );
      await writeAudit(q, ctx.orgId, actorOf(ctx), { action: 'customer.exported', targetType: 'customer', targetId: id, requestId: req.id });
      return {
        exportedAt: clock.now().toISOString(),
        customer: { name: c.name, nameKana: c.name_kana, email: c.email, phone: c.phone, tags: c.tags, createdAt: c.created_at, status: c.status },
        bookings,
        answers,
        serviceRecords: records,
        passes,
        plans,
      };
    });
    reply.header('Content-Disposition', `attachment; filename="customer-${id}.json"`);
    return data;
  });
}

/** 重複候補: 同じメール/電話/氏名(正規化)の有効顧客。自動統合はしない */
export async function findDuplicates(q: Q, orgId: string, id: string) {
  const c = await q.maybeOne<{ email_normalized: string | null; phone_normalized: string | null; name_norm: string }>(
    'SELECT email_normalized, phone_normalized, name_norm FROM customers WHERE organization_id = $1 AND id = $2',
    [orgId, id],
  );
  if (!c) return [];
  const rows = await q.many<{ id: string; name: string; email: string | null; phone: string | null; created_at: Date; reason_email: boolean; reason_phone: boolean; reason_name: boolean }>(
    `SELECT id, name, email, phone, created_at,
            (email_normalized = $3) AS reason_email, (phone_normalized = $4) AS reason_phone, (name_norm = $5) AS reason_name
       FROM customers
      WHERE organization_id = $1 AND id <> $2 AND status = 'active'
        AND ((email_normalized = $3) OR (phone_normalized = $4 AND length($4) >= 8) OR (name_norm = $5 AND length($5) >= 2))
      ORDER BY created_at LIMIT 20`,
    [orgId, id, c.email_normalized, c.phone_normalized, c.name_norm],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    createdAt: r.created_at,
    reasons: [r.reason_email ? 'メール一致' : null, r.reason_phone ? '電話一致' : null, r.reason_name ? '氏名一致' : null].filter(Boolean),
  }));
}

async function timeline(q: Q, ctx: AuthContext, customerId: string, before: string | null, beforeId: string | null, limit: number) {
  const canRecord = can(ctx, 'record.read');
  const canConf = can(ctx, 'customer.note.confidential');
  const rows = await q.many<{ kind: string; at: Date; ref_id: string | null; title: string; detail: Record<string, unknown> | null; actor: string | null; row_id: string; at_cursor: string }>(
    `SELECT t.*, to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_cursor FROM (
       SELECT 'booking' AS kind, e.created_at AS at, e.booking_id AS ref_id, e.event_type AS title,
              jsonb_build_object('service', b.service_snapshot->>'name', 'location', b.location_snapshot->>'name', 'timezone', b.location_snapshot->>'timezone',
                                 'startsAt', b.starts_at, 'from', e.from_status, 'to', e.to_status, 'data', e.data, 'code', b.code) AS detail,
              e.actor_label AS actor, e.id AS row_id
         FROM booking_events e JOIN bookings b ON b.id = e.booking_id
        WHERE e.organization_id = $1 AND e.customer_id = $2
       UNION ALL
       SELECT 'pass', l.created_at, l.customer_pass_id, l.entry_type,
              jsonb_build_object('pass', cp.product_snapshot->>'name', 'delta', l.delta, 'balance', l.balance_after, 'reason', l.reason, 'bookingId', l.booking_id),
              l.actor_label, l.id
         FROM pass_ledger_entries l JOIN customer_passes cp ON cp.id = l.customer_pass_id
        WHERE l.organization_id = $1 AND cp.customer_id = $2
       UNION ALL
       SELECT 'plan', l.created_at, l.customer_plan_id, l.entry_type,
              jsonb_build_object('plan', p.product_snapshot->>'name', 'delta', l.delta, 'balance', l.balance_after, 'reason', l.reason, 'bookingId', l.booking_id),
              l.actor_label, l.id
         FROM plan_ledger_entries l JOIN customer_plans p ON p.id = l.customer_plan_id
        WHERE l.organization_id = $1 AND p.customer_id = $2
       UNION ALL
       SELECT 'note', n.created_at, n.id, n.visibility,
              jsonb_build_object('body', n.body, 'deleted', n.deleted_at IS NOT NULL), n.author_label, n.id
         FROM customer_notes n
        WHERE n.organization_id = $1 AND n.customer_id = $2 AND (n.visibility = 'general' OR $5::boolean)
       UNION ALL
       SELECT 'record', r.created_at, r.id, r.status,
              jsonb_build_object('service', r.service_snapshot->>'name', 'performedAt', r.performed_at,
                                 'internalMemo', CASE WHEN $4::boolean THEN r.internal_memo END,
                                 'customerMemo', CASE WHEN $4::boolean THEN r.customer_memo END,
                                 'nextRecommendedOn', r.next_recommended_on, 'bookingId', r.booking_id), NULL, r.id
         FROM service_records r
        WHERE r.organization_id = $1 AND r.customer_id = $2
       UNION ALL
       SELECT 'merge', m.created_at, m.merged_id, 'merged', jsonb_build_object('moved', m.moved_counts), NULL, m.id
         FROM customer_merges m WHERE m.organization_id = $1 AND m.survivor_id = $2
     ) t
     WHERE ($3::timestamptz IS NULL OR t.at < $3 OR (t.at = $3 AND $7::uuid IS NOT NULL AND t.row_id < $7::uuid))
     ORDER BY t.at DESC, t.row_id DESC LIMIT $6`,
    [ctx.orgId, customerId, before, canRecord, canConf, limit, beforeId],
  );
  return rows.map((r) => ({ kind: r.kind, at: r.at, refId: r.ref_id, title: r.title, detail: r.detail, actor: r.actor, cursor: `${r.at_cursor}|${r.row_id}` }));
}
