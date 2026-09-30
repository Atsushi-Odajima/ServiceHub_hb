/**
 * 組織バックアップの復元(1トランザクション。途中で失敗したら何も変わらない)
 *
 *  1. ファイル全体を検証(構造・件数・ハッシュ・組織ID・復元先DBとの列の互換性)
 *  2. 復元先の確認: new=同じ組織が存在しないこと / replace=置き換える組織を削除(台帳・監査も含め1トランザクション内)
 *  3. 表を親→子の順に投入。テナント文脈(RLS)で書くため、別組織の行は投入できない
 *     - ログインユーザーは既存(同じID/メール)があれば上書きせずに紐付け、なければ作成
 *     - 自己参照/循環参照の列は NULL で投入して最後に更新
 *     - 回数券/利用プランの残数は 0 で投入し、台帳を元の順序で再生してDBのトリガーで再計算する
 *  4. 照合: 表ごとの件数と内容ハッシュ(復元後に読み直して計算)、台帳の残数(各エントリの balance_after と
 *     回数券/期間ごとの remaining)がバックアップと一致すること
 *  5. 復元時点で未送信だった通知は送らない(skipped)。監査ログに復元を記録
 *  6. dryRun なら最後に取り消す(復元テスト)
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Actor } from '../audit.js';
import { lockKey } from '../db/tx.js';
import { AppError } from '../errors.js';
import { dumpColumns, fixTextFormat, loadCatalog, quoteIdent, selectRowsSql, type ColumnInfo } from './catalog.js';
import { BackupFormatError, openBackup, type BackupOrganizationInfo, type TableStartLine } from './format.js';
import { BACKUP_TABLES, TABLE_LABELS, type TableSpec } from './spec.js';
import { parseBackup, verifyBackup, type Row, type VerifyReport } from './verify.js';

export interface RestoreOptions {
  /** new: 同じ組織が存在しない環境へ / replace: replaceOrgId の組織を置き換える */
  mode: 'new' | 'replace';
  replaceOrgId?: string | null;
  encryptionKey?: string | null;
  /** 監査ログに記録する操作者 */
  actor: Actor;
  /** 画面からの復元: この利用者がバックアップ内で有効なオーナーであること(締め出し防止) */
  requireOwnerUserId?: string | null;
  /**
   * 既存ユーザー(同じメール)の扱い
   *  link: そのまま所属させる(CLI・新しい環境への復元)
   *  restrict: 置き換え前にこの組織の有効なメンバーでなかった既存ユーザーは「無効」で復元(画面からの復元)
   */
  existingUserPolicy: 'link' | 'restrict';
  dryRun?: boolean;
  /** 復元先の SESSION_SECRET(作成元と異なる場合に警告) */
  sessionSecret?: string | null;
  /** 展開後サイズの上限 */
  maxBytes?: number;
  requestId?: string | null;
  now?: Date;
}

export interface RestoreTableResult {
  name: string;
  label: string;
  expected: number;
  restored: number;
  digest: 'match' | 'skipped';
  note?: string;
}

export interface RestoreReport {
  dryRun: boolean;
  mode: 'new' | 'replace';
  organization: BackupOrganizationInfo;
  backupCreatedAt: string;
  schemaVersion: string;
  appVersion: string;
  tables: RestoreTableResult[];
  ledger: { passes: number; passEntries: number; periods: number; planEntries: number };
  users: { created: number; linked: number; membershipsDisabled: number };
  notificationsSkipped: number;
  replaced: { orgId: string; slug: string; name: string; counts: Record<string, number> } | null;
  warnings: string[];
  durationMs: number;
}

const INSERT_BATCH_ROWS = 1000;
const INSERT_BATCH_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function restoreError(message: string, details?: unknown): AppError {
  return new AppError('VALIDATION_ERROR', message, details);
}

/** 投入時のDBエラーを、表名付きの分かる言葉にする(値そのものは出さない) */
function insertError(err: unknown, table: string): unknown {
  const e = err as { code?: string; message?: string };
  if (!e || typeof e.code !== 'string') return err;
  const label = TABLE_LABELS[table] ?? table;
  if (e.message?.includes('BALANCE_NEGATIVE')) {
    return restoreError(`${label}を再生すると残数がマイナスになります(ファイルが改ざん・破損している可能性があります)`);
  }
  switch (e.code) {
    case '23505':
      return restoreError(`${label}: 復元先の既存データとIDなどが重複しています`);
    case '23503':
      return restoreError(`${label}: 参照先のデータがバックアップに含まれていません`);
    case '23514':
    case '23502':
      return restoreError(`${label}: 値がDBの制約に違反しています`);
    case '23P01':
      return restoreError(`${label}: 時間が重なるデータがあります`);
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return restoreError(`${label}: 値の形式が正しくありません`);
    case '42501':
      return restoreError(`${label}: 別の組織のデータは復元できません`);
    default:
      return err;
  }
}

interface Ctx {
  client: pg.PoolClient;
  orgId: string;
  catalog: Map<string, ColumnInfo[]>;
  opts: RestoreOptions;
  now: Date;
  userMap: Map<string, string>;
  restrictedUsers: Set<string>;
  replacedMembers: Set<string>;
  deferred: Map<string, { table: string; column: string; ids: string[]; values: string[] }>;
  expectedBalances: Map<string, Map<string, { remaining: number; updatedAt: string | null }>>;
  modified: Map<string, string>;
  restoredCounts: Map<string, number>;
  users: { created: number; linked: number; membershipsDisabled: number };
  ledger: { passEntries: number; planEntries: number };
  warnings: string[];
}

async function setCtx(client: pg.PoolClient, orgId: string, system: boolean): Promise<void> {
  await client.query(`SELECT set_config('app.org_id', $1, true), set_config('app.system', $2, true)`, [orgId, system ? 'on' : 'off']);
}

function typesFor(ctx: Ctx, table: string, columns: readonly string[]): string[] {
  const cols = ctx.catalog.get(table);
  if (!cols) throw restoreError(`復元先に表 ${table} がありません`);
  const byName = new Map(cols.map((c) => [c.name, c]));
  return columns.map((c) => {
    const col = byName.get(c);
    if (!col || col.generated) throw restoreError(`復元先の表 ${table} に列 ${c} がありません`);
    return col.type;
  });
}

/** unnest(text[] × 列数) による一括投入。行の順序(ORDINALITY)どおりにトリガーが実行される */
function insertSql(table: string, columns: readonly string[], types: readonly string[], returning?: string): string {
  const params = columns.map((_, i) => `$${i + 1}::text[]`).join(', ');
  const aliases = columns.map((_, i) => `c${i}`).join(', ');
  const select = columns.map((_, i) => `CAST(u.c${i} AS ${types[i]})`).join(', ');
  return (
    `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) ` +
    `SELECT ${select} FROM unnest(${params}) WITH ORDINALITY AS u(${aliases}, ord) ORDER BY u.ord` +
    (returning ? ` RETURNING ${returning}` : '')
  );
}

function transpose(rows: Row[], width: number): (string | null)[][] {
  const out: (string | null)[][] = Array.from({ length: width }, () => new Array(rows.length));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < width; c++) out[c][r] = row[c];
  }
  return out;
}

function rowBytes(row: Row): number {
  let n = 0;
  for (const v of row) n += v ? v.length : 1;
  return n;
}

interface Loader {
  add(rows: Row[]): Promise<void>;
  finish(): Promise<void>;
}

/** 通常の表: 列の検査・置換をして一括投入 */
class TableLoader implements Loader {
  private batch: Row[] = [];
  private bytes = 0;
  private readonly types: string[];
  private readonly idIdx: number;
  private readonly deferredIdx: { idx: number; column: string }[];
  private readonly balanceIdx: number;
  private readonly updatedIdx: number;
  private readonly userIdx: number;
  private readonly statusIdx: number;
  private readonly disabledIdx: number;
  private remapped = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly spec: TableSpec,
    private readonly start: TableStartLine,
  ) {
    this.types = typesFor(ctx, spec.name, start.columns);
    const col = (name: string) => start.columns.indexOf(name);
    this.idIdx = col('id');
    this.deferredIdx = (spec.deferred ?? []).map((c) => ({ idx: col(c), column: c })).filter((d) => d.idx >= 0);
    if (this.deferredIdx.length && this.idIdx < 0) throw restoreError(`表 ${spec.name} に id 列がありません`);
    this.balanceIdx = spec.balanceColumn ? col(spec.balanceColumn) : -1;
    this.updatedIdx = col('updated_at');
    this.userIdx = spec.name === 'memberships' ? col('user_id') : -1;
    this.statusIdx = spec.name === 'memberships' ? col('status') : -1;
    this.disabledIdx = spec.name === 'memberships' ? col('disabled_at') : -1;
    if (spec.balanceColumn && (this.balanceIdx < 0 || this.idIdx < 0)) throw restoreError(`表 ${spec.name} に残数の列がありません`);
  }

  async add(rows: Row[]): Promise<void> {
    for (const row of rows) {
      for (const d of this.deferredIdx) {
        const v = row[d.idx];
        if (v !== null) {
          const key = `${this.spec.name}.${d.column}`;
          const list = this.ctx.deferred.get(key) ?? { table: this.spec.name, column: d.column, ids: [], values: [] };
          list.ids.push(row[this.idIdx]!);
          list.values.push(v);
          this.ctx.deferred.set(key, list);
          row[d.idx] = null;
        }
      }
      if (this.balanceIdx >= 0) {
        const map = this.ctx.expectedBalances.get(this.spec.name) ?? new Map();
        const remaining = Number(row[this.balanceIdx]);
        if (!Number.isInteger(remaining) || remaining < 0) throw restoreError(`${TABLE_LABELS[this.spec.name]}の残数が不正です`);
        map.set(row[this.idIdx]!, { remaining, updatedAt: this.updatedIdx >= 0 ? row[this.updatedIdx] : null });
        this.ctx.expectedBalances.set(this.spec.name, map);
        row[this.balanceIdx] = '0';
      }
      if (this.userIdx >= 0) {
        const backupUser = row[this.userIdx];
        const mapped = backupUser ? this.ctx.userMap.get(backupUser) : undefined;
        if (!mapped) throw restoreError('メンバーのログインユーザーがバックアップに含まれていません');
        if (mapped !== backupUser) this.remapped++;
        row[this.userIdx] = mapped;
        if (this.ctx.restrictedUsers.has(mapped) && row[this.statusIdx] === 'active') {
          row[this.statusIdx] = 'disabled';
          if (this.disabledIdx >= 0) row[this.disabledIdx] = this.ctx.now.toISOString();
          this.ctx.users.membershipsDisabled++;
          this.remapped++;
        }
      }
      this.batch.push(row);
      this.bytes += rowBytes(row);
      if (this.batch.length >= INSERT_BATCH_ROWS || this.bytes >= INSERT_BATCH_BYTES) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    try {
      await this.ctx.client.query(insertSql(this.spec.name, this.start.columns, this.types), transpose(this.batch, this.start.columns.length));
    } catch (err) {
      throw insertError(err, this.spec.name);
    }
    this.ctx.restoredCounts.set(this.spec.name, (this.ctx.restoredCounts.get(this.spec.name) ?? 0) + this.batch.length);
    this.batch = [];
    this.bytes = 0;
  }

  async finish(): Promise<void> {
    await this.flush();
    if (this.remapped > 0) this.ctx.modified.set(this.spec.name, '既存のログインユーザーへの紐付け・無効化を含む');
  }
}

/**
 * ログインユーザー: 既存の行は上書きしない(他の組織にも所属している可能性・パスワード変更後の可能性)。
 * 同じ ID か同じメールの既存ユーザーがあれば紐付け、なければ作成する。
 */
class UserLoader implements Loader {
  private readonly types: string[];
  private readonly idIdx: number;
  private readonly emailIdx: number;

  constructor(
    private readonly ctx: Ctx,
    private readonly start: TableStartLine,
  ) {
    this.types = typesFor(ctx, 'users', start.columns);
    this.idIdx = start.columns.indexOf('id');
    this.emailIdx = start.columns.indexOf('email_normalized');
    if (this.idIdx < 0 || this.emailIdx < 0) throw restoreError('ログインユーザーの列が不足しています');
  }

  async add(rows: Row[]): Promise<void> {
    const { client } = this.ctx;
    await setCtx(client, this.ctx.orgId, true);
    try {
      for (const row of rows) {
        const id = row[this.idIdx];
        const email = row[this.emailIdx];
        if (!id || !UUID_RE.test(id) || !email) throw restoreError('ログインユーザーの行が不正です');
        const existing = (
          await client.query<{ id: string; email_normalized: string }>(
            'SELECT id::text AS id, email_normalized FROM users WHERE id = $1::uuid OR email_normalized = $2',
            [id, email],
          )
        ).rows;
        const sameId = existing.find((u) => u.id === id);
        const sameEmail = existing.find((u) => u.email_normalized === email);
        if (sameId && sameId.email_normalized !== email) {
          throw restoreError(`ログインユーザー(${email})のIDが復元先の別のユーザーと重複しています`);
        }
        if (sameEmail && sameId && sameEmail.id !== sameId.id) {
          throw restoreError(`ログインユーザー(${email})が復元先の別のユーザーと重複しています`);
        }
        const target = sameId ?? sameEmail;
        if (target) {
          this.ctx.userMap.set(id, target.id);
          this.ctx.users.linked++;
          if (this.ctx.opts.existingUserPolicy === 'restrict' && !this.ctx.replacedMembers.has(target.id)) {
            this.ctx.restrictedUsers.add(target.id);
          }
        } else {
          try {
            await client.query(insertSql('users', this.start.columns, this.types), transpose([row], this.start.columns.length));
          } catch (err) {
            throw insertError(err, 'users');
          }
          this.ctx.userMap.set(id, id);
          this.ctx.users.created++;
        }
      }
      this.ctx.restoredCounts.set('users', (this.ctx.restoredCounts.get('users') ?? 0) + rows.length);
    } finally {
      await setCtx(client, this.ctx.orgId, false);
    }
  }

  async finish(): Promise<void> {
    if (this.ctx.users.linked > 0) this.ctx.modified.set('users', '既存のログインユーザーに紐付け(上書きしない)');
  }
}

/**
 * 台帳: 作成日時順に投入し、同じ日時(同一トランザクション)の中では残数のつながり
 * (直前の残数 + 増減 = balance_after)が成り立つ順に並べ直す。残数はトリガーが再計算し、
 * RETURNING の balance_after がバックアップと1件でも違えば復元を中止する。
 */
class LedgerLoader implements Loader {
  private readonly types: string[];
  private readonly idx: { id: number; created: number; group: number; delta: number; balance: number; reverses: number };
  private tieKey: string | null = null;
  private tie: Row[] = [];
  private pending: Row[] = [];
  private readonly balances = new Map<string, number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly spec: TableSpec,
    private readonly start: TableStartLine,
  ) {
    this.types = typesFor(ctx, spec.name, start.columns);
    const col = (n: string) => start.columns.indexOf(n);
    this.idx = {
      id: col('id'),
      created: col('created_at'),
      group: col(spec.ledger!.group),
      delta: col('delta'),
      balance: col('balance_after'),
      reverses: col('reverses_entry_id'),
    };
    if (Object.values(this.idx).some((i) => i < 0)) throw restoreError(`${TABLE_LABELS[spec.name]}の列が不足しています`);
  }

  async add(rows: Row[]): Promise<void> {
    for (const row of rows) {
      if (row[this.idx.created] !== this.tieKey) {
        this.resolveTie();
        this.tieKey = row[this.idx.created];
      }
      this.tie.push(row);
    }
    if (this.pending.length >= INSERT_BATCH_ROWS) await this.flush();
  }

  private resolveTie(): void {
    if (this.tie.length === 0) return;
    const { id, group, delta, balance, reverses } = this.idx;
    const byGroup = new Map<string, Row[]>();
    for (const r of this.tie) {
      const g = r[group]!;
      const list = byGroup.get(g);
      if (list) list.push(r);
      else byGroup.set(g, [r]);
    }
    const tieIds = new Set(this.tie.map((r) => r[id]!));
    const emitted = new Set<string>();
    for (const [g, rows] of byGroup) {
      let cur = this.balances.get(g) ?? 0;
      const rest = rows.slice();
      while (rest.length) {
        let k = rest.findIndex((r) => {
          const rev = r[reverses];
          return cur + Number(r[delta]) === Number(r[balance]) && (!rev || !tieIds.has(rev) || emitted.has(rev));
        });
        if (k < 0) k = 0; // つながりが見つからない場合もそのまま投入し、再計算結果の照合で検出する
        const [r] = rest.splice(k, 1);
        this.pending.push(r);
        emitted.add(r[id]!);
        cur += Number(r[delta]);
      }
      this.balances.set(g, cur);
    }
    this.tie = [];
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    let res: pg.QueryResult<{ id: string; balance_after: number }>;
    try {
      res = await this.ctx.client.query<{ id: string; balance_after: number }>(
        insertSql(this.spec.name, this.start.columns, this.types, 'id::text AS id, balance_after'),
        transpose(rows, this.start.columns.length),
      );
    } catch (err) {
      throw insertError(err, this.spec.name);
    }
    const got = new Map(res.rows.map((r) => [r.id, r.balance_after]));
    for (const r of rows) {
      if (got.get(r[this.idx.id]!) !== Number(r[this.idx.balance])) {
        throw restoreError(`${TABLE_LABELS[this.spec.name]}から再計算した残数がバックアップと一致しません(対象 ${r[this.idx.group]}。ファイルが改ざん・破損している可能性があります)`);
      }
    }
    this.ctx.restoredCounts.set(this.spec.name, (this.ctx.restoredCounts.get(this.spec.name) ?? 0) + rows.length);
    if (this.spec.name === 'pass_ledger_entries') this.ctx.ledger.passEntries += rows.length;
    else this.ctx.ledger.planEntries += rows.length;
  }

  async finish(): Promise<void> {
    this.resolveTie();
    await this.flush();
  }
}

function makeLoader(ctx: Ctx, spec: TableSpec, start: TableStartLine): Loader {
  if (spec.name === 'users') return new UserLoader(ctx, start);
  if (spec.ledger) return new LedgerLoader(ctx, spec, start);
  return new TableLoader(ctx, spec, start);
}

async function applyDeferred(ctx: Ctx): Promise<void> {
  for (const d of ctx.deferred.values()) {
    for (let i = 0; i < d.ids.length; i += 5000) {
      await ctx.client.query(
        `UPDATE ${quoteIdent(d.table)} AS t SET ${quoteIdent(d.column)} = CAST(u.v AS uuid)
           FROM unnest($1::text[], $2::text[]) AS u(id, v)
          WHERE t.id = CAST(u.id AS uuid) AND t.organization_id = $3`,
        [d.ids.slice(i, i + 5000), d.values.slice(i, i + 5000), ctx.orgId],
      );
    }
  }
}

/** 台帳から再計算された残数がバックアップ時の値と一致するか照合し、更新日時を元に戻す */
async function checkBalances(ctx: Ctx): Promise<{ passes: number; periods: number }> {
  const result = { passes: 0, periods: 0 };
  for (const [table, expected] of ctx.expectedBalances) {
    const rows = (
      await ctx.client.query<{ id: string; remaining: number }>(
        `SELECT id::text AS id, remaining FROM ${quoteIdent(table)} WHERE organization_id = $1`,
        [ctx.orgId],
      )
    ).rows;
    if (rows.length !== expected.size) throw restoreError(`${TABLE_LABELS[table]}の件数が一致しません`);
    for (const r of rows) {
      const e = expected.get(r.id);
      if (!e || e.remaining !== r.remaining) {
        throw restoreError(`${TABLE_LABELS[table]}の残数が台帳の再計算結果と一致しません(ID ${r.id}: バックアップ ${e?.remaining ?? '-'} / 再計算 ${r.remaining})`);
      }
    }
    const ids: string[] = [];
    const values: string[] = [];
    for (const [id, e] of expected) {
      if (e.updatedAt) {
        ids.push(id);
        values.push(e.updatedAt);
      }
    }
    for (let i = 0; i < ids.length; i += 5000) {
      await ctx.client.query(
        `UPDATE ${quoteIdent(table)} AS t SET updated_at = CAST(u.v AS timestamptz)
           FROM unnest($1::text[], $2::text[]) AS u(id, v)
          WHERE t.id = CAST(u.id AS uuid) AND t.organization_id = $3`,
        [ids.slice(i, i + 5000), values.slice(i, i + 5000), ctx.orgId],
      );
    }
    if (table === 'customer_passes') result.passes = rows.length;
    else result.periods = rows.length;
  }
  return result;
}

/** 復元後の内容を出力時と同じ形式で読み直し、表ごとのハッシュを計算する */
async function digestTable(ctx: Ctx, spec: TableSpec, columns: string[]): Promise<{ count: number; sha256: string }> {
  const h = createHash('sha256');
  let count = 0;
  await ctx.client.query(`DECLARE restore_check NO SCROLL CURSOR FOR ${selectRowsSql(spec, columns)}`, [ctx.orgId]);
  try {
    for (;;) {
      const r = await ctx.client.query<unknown[]>({ text: 'FETCH 2000 FROM restore_check', rowMode: 'array' });
      if (r.rows.length === 0) break;
      h.update(r.rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      count += r.rows.length;
    }
  } finally {
    await ctx.client.query('CLOSE restore_check');
  }
  return { count, sha256: count === 0 ? createHash('sha256').digest('hex') : h.digest('hex') };
}

const REPLACED_COUNT_TABLES = ['locations', 'staff', 'customers', 'bookings', 'service_records', 'customer_passes', 'customer_plans', 'audit_logs'];

export async function restoreBackup(pool: pg.Pool, file: string, opts: RestoreOptions): Promise<RestoreReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const verify: VerifyReport = await verifyBackup(file, {
    pool,
    encryptionKey: opts.encryptionKey,
    maxBytes: opts.maxBytes,
    sessionSecret: opts.sessionSecret,
  });
  if (!verify.ok || !verify.header) {
    throw restoreError(`バックアップの検証に失敗しました: ${verify.errors.join(' / ')}`, { verify });
  }
  const header = verify.header;
  const orgId = header.organization.id;
  if (opts.mode === 'replace' && !opts.replaceOrgId) throw new Error('replaceOrgId is required for replace mode');

  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', '', true), set_config('statement_timeout', '0', true),
              set_config('lock_timeout', '30000', true), set_config('idle_in_transaction_session_timeout', '1800000', true)`,
    );
    await fixTextFormat(client);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('servicehub:backup-restore').toString()]);
    const catalog = await loadCatalog(client);

    const ctx: Ctx = {
      client,
      orgId,
      catalog,
      opts,
      now,
      userMap: new Map(),
      restrictedUsers: new Set(),
      replacedMembers: new Set(),
      deferred: new Map(),
      expectedBalances: new Map(),
      modified: new Map(),
      restoredCounts: new Map(),
      users: { created: 0, linked: 0, membershipsDisabled: 0 },
      ledger: { passEntries: 0, planEntries: 0 },
      warnings: [...verify.warnings],
    };

    // ---- 復元先の確認 ----
    await setCtx(client, orgId, true);
    const byId = (await client.query<{ id: string }>('SELECT id::text AS id FROM organizations WHERE id = $1', [orgId])).rows[0];
    const bySlug = (await client.query<{ id: string }>('SELECT id::text AS id FROM organizations WHERE slug = $1', [header.organization.slug])).rows[0];
    let replaced: RestoreReport['replaced'] = null;
    if (opts.mode === 'new') {
      if (byId) throw new AppError('CONFLICT', 'この組織は復元先に既に存在します。置き換える場合は置換復元を指定してください。');
      if (bySlug) throw new AppError('CONFLICT', `組織のURL名「${header.organization.slug}」は復元先で別の組織が使用しています。`);
    } else {
      const replaceOrgId = opts.replaceOrgId!;
      const target = (
        await client.query<{ id: string; slug: string; name: string }>('SELECT id::text AS id, slug, name FROM organizations WHERE id = $1 FOR UPDATE', [replaceOrgId])
      ).rows[0];
      if (!target) throw new AppError('NOT_FOUND', '置き換える組織が見つかりません');
      if (byId && byId.id !== replaceOrgId) throw new AppError('CONFLICT', 'バックアップの組織は復元先に別の組織として既に存在します。');
      if (bySlug && bySlug.id !== replaceOrgId) throw new AppError('CONFLICT', `組織のURL名「${header.organization.slug}」は復元先で別の組織が使用しています。`);
      await setCtx(client, replaceOrgId, false);
      const counts: Record<string, number> = {};
      for (const t of REPLACED_COUNT_TABLES) {
        counts[t] = Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoteIdent(t)} WHERE organization_id = $1`, [replaceOrgId])).rows[0].n);
      }
      replaced = { orgId: target.id, slug: target.slug, name: target.name, counts };
      const members = await client.query<{ user_id: string }>(
        `SELECT user_id::text AS user_id FROM memberships WHERE organization_id = $1 AND status = 'active'`,
        [replaceOrgId],
      );
      for (const m of members.rows) ctx.replacedMembers.add(m.user_id);
      // 台帳・監査ログは通常削除できない(追記専用)。置換復元のこのトランザクション内に限って削除を許可する
      await client.query(`SELECT set_config('app.allow_ledger_purge', 'on', true)`);
      await client.query('DELETE FROM organizations WHERE id = $1', [replaceOrgId]);
      await client.query(`SELECT set_config('app.allow_ledger_purge', 'off', true)`);
    }

    // ---- 投入(テナント文脈) ----
    await setCtx(client, orgId, false);
    await client.query(`SELECT set_config('app.restoring', 'on', true)`);
    const opened = await openBackup(file, { encryptionKey: opts.encryptionKey, maxBytes: opts.maxBytes });
    let loader: Loader | null = null;
    const sections: { spec: TableSpec; columns: string[] }[] = [];
    let footerSha: string | null = null;
    let ownerChecked = false;
    const checkOwner = async () => {
      if (ownerChecked || !opts.requireOwnerUserId) return;
      ownerChecked = true;
      const ok = await client.query(
        `SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'`,
        [orgId, opts.requireOwnerUserId],
      );
      if (ok.rowCount === 0) {
        throw new AppError('INVALID_STATE', 'このバックアップには、あなたの有効なオーナー権限が含まれていないため、画面からは復元できません(復元後にログインできなくなるため)。');
      }
    };
    for await (const ev of parseBackup(opened.lines)) {
      if (ev.kind === 'table') {
        loader = makeLoader(ctx, ev.spec, ev.start);
        sections.push({ spec: ev.spec, columns: ev.start.columns });
      } else if (ev.kind === 'rows') {
        await loader!.add(ev.rows);
      } else if (ev.kind === 'end') {
        await loader!.finish();
        loader = null;
        if (ev.spec.name === 'memberships') await checkOwner();
      } else if (ev.kind === 'footer') {
        footerSha = ev.footer.sha256;
      }
    }
    if (footerSha !== verify.sha256) throw restoreError('検証後にバックアップファイルが変更されました');
    await checkOwner();

    await applyDeferred(ctx);
    const balances = await checkBalances(ctx);

    // ---- 照合: 件数と内容ハッシュ ----
    const tables: RestoreTableResult[] = [];
    for (const spec of BACKUP_TABLES) {
      const section = sections.find((s) => s.spec.name === spec.name);
      const expected = verify.counts[spec.name] ?? 0;
      const label = TABLE_LABELS[spec.name] ?? spec.name;
      if (!section) {
        // 古い版のバックアップにない表は空で復元される
        const cols = dumpColumns(catalog, spec).map((c) => c.name);
        const d = await digestTable(ctx, spec, cols);
        if (d.count !== 0) throw restoreError(`${label}の件数が一致しません`);
        tables.push({ name: spec.name, label, expected: 0, restored: 0, digest: 'skipped', note: 'バックアップに含まれない表' });
        continue;
      }
      const d = await digestTable(ctx, spec, section.columns);
      if (d.count !== expected) throw restoreError(`${label}の件数が一致しません(バックアップ ${expected} / 復元 ${d.count})`);
      const skipReason = ctx.modified.get(spec.name);
      if (!skipReason && d.sha256 !== verify.tableDigests[spec.name]) {
        throw restoreError(`${label}の内容がバックアップと一致しません`);
      }
      tables.push({ name: spec.name, label, expected, restored: d.count, digest: skipReason ? 'skipped' : 'match', note: skipReason });
    }

    // ---- 復元後の調整(ここからは通常どおり updated_at を更新する) ----
    await client.query(`SELECT set_config('app.restoring', 'off', true)`);
    const skipped = await client.query(
      `UPDATE notifications SET status = 'skipped', skip_reason = 'restored_from_backup', locked_until = NULL
        WHERE organization_id = $1 AND status IN ('pending', 'sending')`,
      [orgId],
    );
    const notificationsSkipped = skipped.rowCount ?? 0;
    if (notificationsSkipped > 0) {
      ctx.warnings.push(`バックアップ時点で未送信だった通知 ${notificationsSkipped} 件は、古い内容を送らないよう「送信しない」にしました。`);
    }
    if (ctx.users.membershipsDisabled > 0) {
      ctx.warnings.push(`この組織のメンバーでなかった既存のログインユーザー ${ctx.users.membershipsDisabled} 人の権限は「無効」で復元しました。必要に応じて有効にしてください。`);
    }
    const report: RestoreReport = {
      dryRun: Boolean(opts.dryRun),
      mode: opts.mode,
      organization: header.organization,
      backupCreatedAt: header.createdAt,
      schemaVersion: header.schemaVersion,
      appVersion: header.appVersion,
      tables,
      ledger: { passes: balances.passes, passEntries: ctx.ledger.passEntries, periods: balances.periods, planEntries: ctx.ledger.planEntries },
      users: ctx.users,
      notificationsSkipped,
      replaced,
      warnings: ctx.warnings,
      durationMs: 0,
    };
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_user_id, actor_membership_id, actor_label, action, target_type, target_id, metadata, request_id)
       VALUES ($1, $2, $3, $4, $5, 'backup.restored', 'organization', $1, $6, $7)`,
      [
        orgId,
        opts.actor.type,
        opts.actor.userId ?? null,
        opts.actor.membershipId ?? null,
        opts.actor.label ?? null,
        JSON.stringify({
          mode: opts.mode,
          backupCreatedAt: header.createdAt,
          backupAppVersion: header.appVersion,
          schemaVersion: header.schemaVersion,
          sha256: verify.sha256,
          counts: Object.fromEntries(tables.filter((t) => t.expected > 0).map((t) => [t.name, t.restored])),
          replaced: replaced ? { orgId: replaced.orgId, slug: replaced.slug, counts: replaced.counts } : null,
          notificationsSkipped,
        }),
        opts.requestId ?? null,
      ],
    );
    if (opts.dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    report.durationMs = Date.now() - started;
    return report;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      client.release(true);
      released = true;
    }
    if (err instanceof BackupFormatError) throw restoreError(err.message);
    throw err;
  } finally {
    if (!released) client.release();
  }
}
