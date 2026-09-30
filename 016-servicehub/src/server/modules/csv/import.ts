/**
 * CSV 取込: プレビュー(解析・検証・重複確認)→ 確認 → 反映。
 * - 取込は新規登録のみ(既存データの更新・削除はしない)
 * - エラーが1件でもあれば反映できない(修正したファイルで再度プレビュー)
 * - 同じ内容のファイル(SHA-256 一致)は二度反映できない
 */
import { normalizeEmail, normalizeName, normalizePhone } from '../../../shared/normalize.js';
import { type Actor, writeAudit } from '../../audit.js';
import { sha256 } from '../../auth/crypto.js';
import { advisoryLockAll, type Q } from '../../db/tx.js';
import { AppError, invalidState, notFound } from '../../errors.js';
import { insertCustomer } from '../customers/identity.js';
import { parseCsv, unescapeCell } from './format.js';

export const IMPORT_KINDS = ['customers', 'services', 'staff'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

type Field = { key: string; label: string; aliases: string[]; required?: boolean };

const FIELDS: Record<ImportKind, Field[]> = {
  customers: [
    { key: 'name', label: '氏名', aliases: ['氏名', 'お名前', '名前', 'name'], required: true },
    { key: 'nameKana', label: 'フリガナ', aliases: ['フリガナ', 'ふりがな', 'カナ', 'kana', 'name_kana'] },
    { key: 'email', label: 'メール', aliases: ['メール', 'メールアドレス', 'email', 'e-mail'] },
    { key: 'phone', label: '電話', aliases: ['電話', '電話番号', 'phone', 'tel'] },
    { key: 'tags', label: 'タグ', aliases: ['タグ', 'tags'] },
    { key: 'location', label: 'よく利用する拠点', aliases: ['よく利用する拠点', '拠点', 'location'] },
    { key: 'memo', label: 'メモ', aliases: ['メモ', '備考', 'memo'] },
  ],
  services: [
    { key: 'name', label: '名称', aliases: ['名称', 'サービス名', 'name'], required: true },
    { key: 'category', label: 'カテゴリ', aliases: ['カテゴリ', 'category'] },
    { key: 'durationMin', label: '所要時間(分)', aliases: ['所要時間(分)', '所要時間', 'duration'], required: true },
    { key: 'bufferBeforeMin', label: '準備時間(分)', aliases: ['準備時間(分)', '準備時間', 'buffer_before'] },
    { key: 'bufferAfterMin', label: '片付け時間(分)', aliases: ['片付け時間(分)', '片付け時間', 'buffer_after'] },
    { key: 'capacity', label: '定員', aliases: ['定員', 'capacity'] },
    { key: 'maxPartySize', label: '最大人数', aliases: ['最大人数', 'max_party_size'] },
    { key: 'priceLabel', label: '価格表示', aliases: ['価格表示', '料金', 'price'] },
    { key: 'description', label: '説明', aliases: ['説明', 'description'] },
    { key: 'locations', label: '提供拠点', aliases: ['提供拠点', '拠点', 'locations'] },
    { key: 'isPublic', label: '公開', aliases: ['公開', 'public'] },
    { key: 'passEligible', label: '回数券可', aliases: ['回数券可', 'pass'] },
    { key: 'planEligible', label: 'プラン可', aliases: ['プラン可', 'plan'] },
  ],
  staff: [
    { key: 'displayName', label: '表示名', aliases: ['表示名', '名前', 'display_name', 'name'], required: true },
    { key: 'internalName', label: '内部名', aliases: ['内部名', 'internal_name'] },
    { key: 'email', label: 'メール', aliases: ['メール', 'email'] },
    { key: 'phone', label: '電話', aliases: ['電話', 'phone'] },
    { key: 'locations', label: '所属拠点', aliases: ['所属拠点', '拠点', 'locations'] },
    { key: 'acceptsBookings', label: '予約受付', aliases: ['予約受付', 'accepts_bookings'] },
    { key: 'publicProfile', label: '公開プロフィール', aliases: ['公開プロフィール', 'profile'] },
  ],
};

export interface ImportRow {
  line: number;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  duplicate: { kind: 'file'; line: number } | { kind: 'existing'; id: string; name: string } | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseBool(v: string, fallback: boolean): boolean | null {
  const s = v.trim().toLowerCase();
  if (s === '') return fallback;
  if (['はい', 'true', '1', 'yes', '○', '◯', 'y'].includes(s)) return true;
  if (['いいえ', 'false', '0', 'no', '×', 'x', 'n'].includes(s)) return false;
  return null;
}

function parseIntField(v: string, min: number, max: number): number | null | 'invalid' {
  const s = v.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  return n < min || n > max ? 'invalid' : n;
}

function splitList(v: string): string[] {
  return v
    .split(/[;；、,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

interface LocationRef {
  id: string;
  name: string;
  slug: string;
}

function findLocation(locs: LocationRef[], v: string): LocationRef | undefined {
  const n = normalizeName(v);
  return locs.find((l) => normalizeName(l.name) === n || l.slug === v.trim().toLowerCase());
}

/** ヘッダーを項目に対応付ける(不明な列は無視して一覧で知らせる) */
function mapHeader(kind: ImportKind, header: string[]): { mapping: (string | null)[]; unknown: string[]; missing: string[] } {
  const fields = FIELDS[kind];
  const used = new Set<string>();
  const mapping = header.map((h) => {
    const n = normalizeName(unescapeCell(h));
    const f = fields.find((x) => !used.has(x.key) && x.aliases.some((a) => normalizeName(a) === n));
    if (f) used.add(f.key);
    return f?.key ?? null;
  });
  return {
    mapping,
    unknown: header.filter((_, i) => mapping[i] === null).filter((h) => h.trim() !== ''),
    missing: fields.filter((f) => f.required && !used.has(f.key)).map((f) => f.label),
  };
}

export async function previewImport(q: Q, orgId: string, a: Actor, input: { kind: ImportKind; fileName: string | null; content: string; createdBy: string | null }) {
  if (Buffer.byteLength(input.content, 'utf8') > MAX_IMPORT_BYTES) throw new AppError('VALIDATION_ERROR', 'ファイルが大きすぎます(5MBまで)');
  const hash = sha256(input.content.replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  const done = await q.maybeOne<{ committed_at: Date }>(
    `SELECT committed_at FROM csv_imports WHERE organization_id = $1 AND kind = $2 AND file_hash = $3 AND status = 'committed'`,
    [orgId, input.kind, hash],
  );
  if (done) throw new AppError('CONFLICT', `同じ内容のファイルはすでに取り込まれています(${done.committed_at.toISOString().slice(0, 10)})。二重登録を防ぐため取り込めません`);
  let table: string[][];
  try {
    table = parseCsv(input.content);
  } catch (e) {
    throw new AppError('VALIDATION_ERROR', `CSVを読み取れません: ${(e as Error).message}`);
  }
  if (table.length < 2) throw new AppError('VALIDATION_ERROR', '見出し行とデータ行が必要です');
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new AppError('VALIDATION_ERROR', `1回に取り込めるのは${MAX_IMPORT_ROWS}行までです。ファイルを分けてください`);
  const { mapping, unknown, missing } = mapHeader(input.kind, table[0]);
  if (missing.length > 0) throw new AppError('VALIDATION_ERROR', `必須の列がありません: ${missing.join('、')}`);

  const locs = await q.many<LocationRef>(`SELECT id, name, slug FROM locations WHERE organization_id = $1 AND status = 'active'`, [orgId]);
  const rows: ImportRow[] = [];
  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const seenName = new Map<string, number>();
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const raw: Record<string, string> = {};
    mapping.forEach((k, j) => {
      if (k) raw[k] = unescapeCell((cells[j] ?? '').trim());
    });
    const errors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const line = i + 1;
    if (input.kind === 'customers') {
      if (!raw.name) errors.name = '氏名は必須です';
      else if (raw.name.length > 100) errors.name = '100文字以内にしてください';
      values.name = raw.name;
      values.nameKana = raw.nameKana || null;
      if (raw.email && (!EMAIL_RE.test(raw.email) || raw.email.length > 254)) errors.email = 'メールアドレスの形式が正しくありません';
      values.email = raw.email || null;
      const phoneDigits = normalizePhone(raw.phone ?? null);
      if (raw.phone && (!phoneDigits || phoneDigits.length < 9 || phoneDigits.length > 15)) errors.phone = '電話番号の形式が正しくありません';
      values.phone = raw.phone || null;
      const tags = raw.tags ? raw.tags.split(/[\s　,、]+/).filter(Boolean) : [];
      if (tags.length > 20 || tags.some((t) => t.length > 30)) errors.tags = 'タグは20個まで・各30文字以内にしてください';
      values.tags = tags;
      if (raw.location) {
        const l = findLocation(locs, raw.location);
        if (!l) errors.location = `拠点「${raw.location}」が見つかりません`;
        values.preferredLocationId = l?.id ?? null;
        values.locationName = l?.name ?? raw.location;
      }
      if ((raw.memo ?? '').length > 2000) errors.memo = '2000文字以内にしてください';
      values.memo = raw.memo || null;
    } else if (input.kind === 'services') {
      if (!raw.name) errors.name = '名称は必須です';
      else if (raw.name.length > 100) errors.name = '100文字以内にしてください';
      values.name = raw.name;
      values.category = raw.category || null;
      const dur = parseIntField(raw.durationMin ?? '', 5, 1440);
      if (dur === null || dur === 'invalid') errors.durationMin = '5〜1440の整数で指定してください';
      values.durationMin = dur;
      for (const [k, max] of [
        ['bufferBeforeMin', 240],
        ['bufferAfterMin', 240],
        ['capacity', 500],
        ['maxPartySize', 500],
      ] as const) {
        const v = parseIntField(raw[k] ?? '', k.startsWith('buffer') ? 0 : 1, max);
        if (v === 'invalid') errors[k] = `${k.startsWith('buffer') ? 0 : 1}〜${max}の整数で指定してください`;
        values[k] = v === 'invalid' ? null : v;
      }
      if (typeof values.capacity === 'number' && typeof values.maxPartySize === 'number' && values.maxPartySize > values.capacity) errors.maxPartySize = '定員以下にしてください';
      values.priceLabel = raw.priceLabel || null;
      values.description = raw.description || null;
      const locNames = splitList(raw.locations ?? '');
      const found = locNames.map((n) => findLocation(locs, n));
      if (locNames.length === 0) errors.locations = '提供拠点を1つ以上指定してください(拠点名またはURL名、;区切り)';
      else if (found.some((x) => !x)) errors.locations = `見つからない拠点があります: ${locNames.filter((_, j) => !found[j]).join('、')}`;
      values.locationIds = found.filter(Boolean).map((l) => l!.id);
      values.locationNames = found.filter(Boolean).map((l) => l!.name);
      for (const [k, def] of [
        ['isPublic', true],
        ['passEligible', true],
        ['planEligible', true],
      ] as const) {
        const b = parseBool(raw[k] ?? '', def);
        if (b === null) errors[k] = '「はい」または「いいえ」で指定してください';
        values[k] = b ?? def;
      }
    } else {
      if (!raw.displayName) errors.displayName = '表示名は必須です';
      else if (raw.displayName.length > 100) errors.displayName = '100文字以内にしてください';
      values.displayName = raw.displayName;
      values.internalName = raw.internalName || null;
      if (raw.email && !EMAIL_RE.test(raw.email)) errors.email = 'メールアドレスの形式が正しくありません';
      values.email = raw.email || null;
      values.phone = raw.phone || null;
      const locNames = splitList(raw.locations ?? '');
      const found = locNames.map((n) => findLocation(locs, n));
      if (locNames.length === 0) errors.locations = '所属拠点を1つ以上指定してください(拠点名またはURL名、;区切り)';
      else if (found.some((x) => !x)) errors.locations = `見つからない拠点があります: ${locNames.filter((_, j) => !found[j]).join('、')}`;
      values.locationIds = found.filter(Boolean).map((l) => l!.id);
      values.locationNames = found.filter(Boolean).map((l) => l!.name);
      const b = parseBool(raw.acceptsBookings ?? '', true);
      if (b === null) errors.acceptsBookings = '「はい」または「いいえ」で指定してください';
      values.acceptsBookings = b ?? true;
      values.publicProfile = raw.publicProfile || null;
    }
    // ファイル内の重複
    let duplicate: ImportRow['duplicate'] = null;
    if (input.kind === 'customers') {
      const em = normalizeEmail(values.email as string | null);
      const ph = normalizePhone(values.phone as string | null);
      const prior = (em && seenEmail.get(em)) || (ph && seenPhone.get(ph));
      if (prior) duplicate = { kind: 'file', line: prior };
      if (em && !seenEmail.has(em)) seenEmail.set(em, line);
      if (ph && !seenPhone.has(ph)) seenPhone.set(ph, line);
    } else {
      const nm = normalizeName(String(values.name ?? values.displayName ?? ''));
      const prior = nm ? seenName.get(nm) : undefined;
      if (prior) duplicate = { kind: 'file', line: prior };
      else if (nm) seenName.set(nm, line);
    }
    rows.push({ line, values, errors, duplicate });
  }
  // 既存データとの重複(顧客: メール/電話、サービス・スタッフ: 名称)
  if (input.kind === 'customers') {
    const emails = [...new Set(rows.map((r) => normalizeEmail(r.values.email as string | null)).filter(Boolean))] as string[];
    const phones = [...new Set(rows.map((r) => normalizePhone(r.values.phone as string | null)).filter(Boolean))] as string[];
    const existing = await q.many<{ id: string; name: string; email_normalized: string | null; phone_normalized: string | null }>(
      `SELECT id, name, email_normalized, phone_normalized FROM customers
        WHERE organization_id = $1 AND status = 'active' AND (email_normalized = ANY($2::text[]) OR phone_normalized = ANY($3::text[]))`,
      [orgId, emails, phones],
    );
    for (const r of rows) {
      if (r.duplicate) continue;
      const em = normalizeEmail(r.values.email as string | null);
      const ph = normalizePhone(r.values.phone as string | null);
      const hit = existing.find((c) => (em && c.email_normalized === em) || (ph && c.phone_normalized === ph));
      if (hit) r.duplicate = { kind: 'existing', id: hit.id, name: hit.name };
    }
  } else {
    const table2 = input.kind === 'services' ? 'services' : 'staff';
    const col = input.kind === 'services' ? 'name' : 'display_name';
    const existing = await q.many<{ id: string; name: string }>(`SELECT id, ${col} AS name FROM ${table2} WHERE organization_id = $1 AND status <> 'archived'`, [orgId]);
    for (const r of rows) {
      if (r.duplicate) continue;
      const nm = normalizeName(String(r.values.name ?? r.values.displayName ?? ''));
      const hit = existing.find((x) => normalizeName(x.name) === nm);
      if (hit) r.duplicate = { kind: 'existing', id: hit.id, name: hit.name };
    }
  }
  const errorCount = rows.filter((r) => Object.keys(r.errors).length > 0).length;
  const rec = await q.one<{ id: string }>(
    `INSERT INTO csv_imports (organization_id, kind, file_name, file_hash, row_count, error_count, rows, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, input.kind, input.fileName, hash, rows.length, errorCount, JSON.stringify(rows), input.createdBy],
  );
  await writeAudit(q, orgId, a, { action: 'csv.import_previewed', targetType: 'csv_import', targetId: rec.id, metadata: { kind: input.kind, fileName: input.fileName, rows: rows.length, errors: errorCount } });
  return {
    id: rec.id,
    kind: input.kind,
    fileName: input.fileName,
    rowCount: rows.length,
    errorCount,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    unknownColumns: unknown,
    columns: FIELDS[input.kind].map((f) => ({ key: f.key, label: f.label, required: Boolean(f.required) })),
    rows,
  };
}

export async function commitImport(q: Q, orgId: string, a: Actor, input: { id: string; duplicates: 'skip' | 'create'; createdBy: string | null; requestId?: string }) {
  const rec = await q.maybeOne<{ id: string; kind: ImportKind; file_hash: string; status: string; error_count: number; rows: ImportRow[]; file_name: string | null }>(
    'SELECT id, kind, file_hash, status, error_count, rows, file_name FROM csv_imports WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [orgId, input.id],
  );
  if (!rec) throw notFound('取込');
  if (rec.status !== 'previewed') throw invalidState('この取込はすでに反映または取消されています');
  if (rec.error_count > 0) throw new AppError('VALIDATION_ERROR', 'エラーのある行があるため反映できません。修正したファイルで、もう一度プレビューしてください');
  await advisoryLockAll(q, [`csv-import:${orgId}:${rec.kind}:${rec.file_hash}`]);
  const done = await q.maybeOne(`SELECT 1 FROM csv_imports WHERE organization_id = $1 AND kind = $2 AND file_hash = $3 AND status = 'committed'`, [orgId, rec.kind, rec.file_hash]);
  if (done) throw new AppError('CONFLICT', '同じ内容のファイルはすでに取り込まれています');
  let created = 0;
  let skipped = 0;
  for (const r of rec.rows) {
    const skip = r.duplicate && (r.duplicate.kind === 'file' || input.duplicates === 'skip');
    if (skip) {
      skipped++;
      continue;
    }
    const v = r.values as Record<string, any>;
    if (rec.kind === 'customers') {
      await insertCustomer(q, orgId, { name: v.name, nameKana: v.nameKana, email: v.email, phone: v.phone, tags: v.tags, memo: v.memo, preferredLocationId: v.preferredLocationId ?? null }, 'import', input.createdBy);
    } else if (rec.kind === 'services') {
      const s = await q.one<{ id: string }>(
        `INSERT INTO services (organization_id, name, category, description, duration_min, buffer_before_min, buffer_after_min, capacity, max_party_size, price_label,
                               is_public, pass_eligible, plan_eligible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [orgId, v.name, v.category, v.description, v.durationMin, v.bufferBeforeMin ?? 0, v.bufferAfterMin ?? 0, v.capacity ?? 1, v.maxPartySize ?? 1, v.priceLabel, v.isPublic, v.passEligible, v.planEligible],
      );
      for (const l of v.locationIds as string[]) await q.exec('INSERT INTO service_locations (organization_id, service_id, location_id) VALUES ($1,$2,$3)', [orgId, s.id, l]);
    } else {
      const s = await q.one<{ id: string }>(
        `INSERT INTO staff (organization_id, display_name, internal_name, email, phone, accepts_bookings, public_profile) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, v.displayName, v.internalName, v.email, v.phone, v.acceptsBookings, v.publicProfile],
      );
      for (const l of v.locationIds as string[]) await q.exec('INSERT INTO staff_locations (organization_id, staff_id, location_id) VALUES ($1,$2,$3)', [orgId, s.id, l]);
    }
    created++;
  }
  const result = { created, skipped, duplicates: input.duplicates };
  await q.exec(`UPDATE csv_imports SET status = 'committed', committed_at = now(), result = $3 WHERE organization_id = $1 AND id = $2`, [orgId, rec.id, JSON.stringify(result)]);
  await writeAudit(q, orgId, a, { action: 'csv.imported', targetType: 'csv_import', targetId: rec.id, metadata: { kind: rec.kind, fileName: rec.file_name, ...result }, requestId: input.requestId });
  return result;
}
