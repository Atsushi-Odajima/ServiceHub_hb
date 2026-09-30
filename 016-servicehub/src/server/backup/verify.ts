import { createHash } from 'node:crypto';
import type pg from 'pg';
import { currentSchemaVersion, loadCatalog } from './catalog.js';
import {
  BackupFormatError,
  openBackup,
  secretFingerprint,
  type BackupFooter,
  type BackupHeader,
  type TableEndLine,
  type TableStartLine,
} from './format.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, tableIndex, tableSpec, type TableSpec } from './spec.js';

export type Row = (string | null)[];

export type BackupEvent =
  | { kind: 'header'; header: BackupHeader }
  | { kind: 'table'; spec: TableSpec; start: TableStartLine }
  | { kind: 'rows'; spec: TableSpec; start: TableStartLine; rows: Row[] }
  | { kind: 'end'; spec: TableSpec; end: TableEndLine }
  | { kind: 'footer'; footer: BackupFooter };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseJson(line: string, lineNo: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new BackupFormatError(`${lineNo}行目: JSON として読めません`);
  }
}

function isHeader(v: unknown): v is BackupHeader {
  const h = v as BackupHeader;
  return (
    !!h &&
    h.type === 'header' &&
    typeof h.format === 'string' &&
    typeof h.formatVersion === 'number' &&
    typeof h.schemaVersion === 'string' &&
    typeof h.appVersion === 'string' &&
    typeof h.createdAt === 'string' &&
    !!h.organization &&
    typeof h.organization.id === 'string' &&
    typeof h.organization.slug === 'string' &&
    typeof h.organization.name === 'string' &&
    typeof h.organization.timezone === 'string' &&
    Array.isArray(h.tables)
  );
}

/**
 * バックアップの行を構造検査しながらイベントとして返す。
 * 検査: 先頭がヘッダー / 表の順序と名前 / 行の列数と型 / 全行の organization_id がヘッダーの組織と一致 /
 *       表ごとの件数とハッシュ / 全体ハッシュ / フッター以降に何もない
 */
export async function* parseBackup(lines: AsyncIterable<string>, opts: { batchSize?: number } = {}): AsyncGenerator<BackupEvent> {
  const batchSize = opts.batchSize ?? 500;
  const total = createHash('sha256');
  let lineNo = 0;
  let header: BackupHeader | null = null;
  let current: { spec: TableSpec; start: TableStartLine; orgCol: number; digest: ReturnType<typeof createHash>; count: number } | null = null;
  let lastIndex = -1;
  let batch: Row[] = [];
  let footer: BackupFooter | null = null;
  const counts: Record<string, number> = {};
  let totalLines = 0;

  for await (const line of lines) {
    lineNo++;
    if (footer) {
      if (line.trim() === '') continue;
      throw new BackupFormatError('フッターの後ろに余分なデータがあります');
    }
    if (line.length === 0) throw new BackupFormatError(`${lineNo}行目: 空行があります`);
    if (lineNo === 1) {
      const h = parseJson(line, lineNo);
      if (!isHeader(h)) throw new BackupFormatError('ヘッダーがありません(ServiceHub のバックアップファイルではありません)');
      if (h.format !== BACKUP_FORMAT) throw new BackupFormatError('ServiceHub の組織バックアップではありません');
      if (h.formatVersion > BACKUP_FORMAT_VERSION) throw new BackupFormatError('新しい版のアプリで作成されたバックアップです。アプリを更新してから復元してください');
      if (!UUID_RE.test(h.organization.id)) throw new BackupFormatError('ヘッダーの組織IDが不正です');
      header = h;
      total.update(line + '\n');
      totalLines++;
      yield { kind: 'header', header: h };
      continue;
    }
    if (line.charCodeAt(0) === 0x5b /* [ */) {
      if (!current) throw new BackupFormatError(`${lineNo}行目: 表の開始より前に行データがあります`);
      const row = parseJson(line, lineNo);
      if (!Array.isArray(row) || row.length !== current.start.columns.length) {
        throw new BackupFormatError(`${lineNo}行目: ${current.spec.name} の列数が一致しません`);
      }
      for (const v of row) {
        if (v !== null && typeof v !== 'string') throw new BackupFormatError(`${lineNo}行目: ${current.spec.name} の値の形式が不正です`);
      }
      if (current.orgCol >= 0 && row[current.orgCol] !== header!.organization.id) {
        throw new BackupFormatError(`${lineNo}行目: ${current.spec.name} に別の組織のデータが含まれています`);
      }
      total.update(line + '\n');
      current.digest.update(line + '\n');
      current.count++;
      totalLines++;
      batch.push(row as Row);
      if (batch.length >= batchSize) {
        yield { kind: 'rows', spec: current.spec, start: current.start, rows: batch };
        batch = [];
      }
      continue;
    }
    const obj = parseJson(line, lineNo) as { type?: string };
    if (obj?.type === 'table') {
      const start = obj as TableStartLine;
      if (current) throw new BackupFormatError(`${lineNo}行目: 表 ${current.spec.name} が閉じられていません`);
      const spec = typeof start.name === 'string' ? tableSpec(start.name) : undefined;
      if (!spec) throw new BackupFormatError(`${lineNo}行目: 不明な表 ${String(start.name)}(新しい版のバックアップの可能性があります)`);
      const idx = tableIndex(spec.name);
      if (idx <= lastIndex) throw new BackupFormatError(`${lineNo}行目: 表の順序が正しくありません(${spec.name})`);
      if (
        !Array.isArray(start.columns) ||
        !Array.isArray(start.types) ||
        start.columns.length !== start.types.length ||
        start.columns.length === 0 ||
        !start.columns.every((c) => typeof c === 'string' && /^[a-z_][a-z0-9_]*$/.test(c)) ||
        !start.types.every((t) => typeof t === 'string') ||
        new Set(start.columns).size !== start.columns.length
      ) {
        throw new BackupFormatError(`${lineNo}行目: 表 ${spec.name} の列定義が不正です`);
      }
      lastIndex = idx;
      const orgCol = spec.name === 'organizations' ? start.columns.indexOf('id') : start.columns.indexOf('organization_id');
      if (spec.name !== 'users' && orgCol < 0) throw new BackupFormatError(`${lineNo}行目: 表 ${spec.name} に組織IDの列がありません`);
      current = { spec, start, orgCol, digest: createHash('sha256'), count: 0 };
      total.update(line + '\n');
      totalLines++;
      yield { kind: 'table', spec, start };
      continue;
    }
    if (obj?.type === 'end') {
      const end = obj as TableEndLine;
      if (!current || end.name !== current.spec.name) throw new BackupFormatError(`${lineNo}行目: 表の終了が一致しません`);
      if (batch.length) {
        yield { kind: 'rows', spec: current.spec, start: current.start, rows: batch };
        batch = [];
      }
      if (end.count !== current.count) throw new BackupFormatError(`表 ${current.spec.name} の件数が一致しません(記録 ${end.count} / 実際 ${current.count})`);
      if (end.sha256 !== current.digest.digest('hex')) throw new BackupFormatError(`表 ${current.spec.name} の内容が改ざん・破損しています(ハッシュ不一致)`);
      if (current.spec.name === 'organizations' && current.count !== 1) throw new BackupFormatError('組織の行がちょうど1件ではありません');
      counts[current.spec.name] = current.count;
      total.update(line + '\n');
      totalLines++;
      const spec = current.spec;
      current = null;
      yield { kind: 'end', spec, end };
      continue;
    }
    if (obj?.type === 'footer') {
      const f = obj as BackupFooter;
      if (current) throw new BackupFormatError(`表 ${current.spec.name} が閉じられていません`);
      if (!f.counts || typeof f.sha256 !== 'string') throw new BackupFormatError('フッターの形式が不正です');
      if (f.sha256 !== total.digest('hex')) throw new BackupFormatError('バックアップ全体のハッシュが一致しません(改ざん・破損の可能性)');
      if (f.lines !== totalLines) throw new BackupFormatError('バックアップの行数が一致しません');
      for (const [name, n] of Object.entries(f.counts)) {
        if (counts[name] !== n) throw new BackupFormatError(`フッターの件数が一致しません(${name})`);
      }
      for (const name of Object.keys(counts)) {
        if (!(name in f.counts)) throw new BackupFormatError(`フッターに件数がありません(${name})`);
      }
      if (!('organizations' in counts)) throw new BackupFormatError('組織の行がありません');
      footer = f;
      yield { kind: 'footer', footer: f };
      continue;
    }
    throw new BackupFormatError(`${lineNo}行目: 不明な行です`);
  }
  if (!header) throw new BackupFormatError('空のファイルです');
  if (!footer) throw new BackupFormatError('バックアップが途中で切れています(フッターがありません)');
}

export interface VerifyReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  encrypted: boolean;
  header: BackupHeader | null;
  counts: Record<string, number>;
  /** 表ごとの列(復元先の型との照合に使う) */
  columns: Record<string, { columns: string[]; types: string[] }>;
  tableDigests: Record<string, string>;
  sha256: string | null;
  currentSchemaVersion: string | null;
}

export interface VerifyOptions {
  /** 指定すると復元先DBの構造と照合する */
  pool?: pg.Pool;
  encryptionKey?: string | null;
  maxBytes?: number;
  /** 復元先の SESSION_SECRET(異なる場合に警告) */
  sessionSecret?: string | null;
}

/** 復元前の検証(ファイル全体を読み、DBへは書かない) */
export async function verifyBackup(file: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const report: VerifyReport = {
    ok: false,
    errors: [],
    warnings: [],
    encrypted: false,
    header: null,
    counts: {},
    columns: {},
    tableDigests: {},
    sha256: null,
    currentSchemaVersion: null,
  };
  try {
    const opened = await openBackup(file, { encryptionKey: opts.encryptionKey, maxBytes: opts.maxBytes });
    report.encrypted = opened.encrypted;
    for await (const ev of parseBackup(opened.lines)) {
      if (ev.kind === 'header') report.header = ev.header;
      else if (ev.kind === 'table') report.columns[ev.spec.name] = { columns: ev.start.columns, types: ev.start.types };
      else if (ev.kind === 'end') {
        report.counts[ev.spec.name] = ev.end.count;
        report.tableDigests[ev.spec.name] = ev.end.sha256;
      } else if (ev.kind === 'footer') report.sha256 = ev.footer.sha256;
    }
  } catch (e) {
    if (e instanceof BackupFormatError) {
      report.errors.push(e.message);
      return report;
    }
    throw e;
  }

  const header = report.header!;
  if (opts.sessionSecret !== undefined && header.secretFingerprint && header.secretFingerprint !== secretFingerprint(opts.sessionSecret)) {
    report.warnings.push(
      'SESSION_SECRET が作成元の環境と異なります。復元後に送信されるリマインダー等のメール内の「予約の確認・変更」リンクが無効になります。作成元と同じ値を設定してください。',
    );
  }
  if (opts.pool) {
    const client = await opts.pool.connect();
    try {
      const catalog = await loadCatalog(client);
      const dbVersion = await currentSchemaVersion(client);
      report.currentSchemaVersion = dbVersion;
      if (header.schemaVersion > dbVersion) {
        report.errors.push(`新しいDB構造(${header.schemaVersion})のバックアップです。アプリを更新してから復元してください(現在 ${dbVersion})`);
      } else if (header.schemaVersion < dbVersion) {
        report.warnings.push(`古いDB構造(${header.schemaVersion})のバックアップです。現在(${dbVersion})の構造との互換性を確認しました。`);
      }
      for (const [name, def] of Object.entries(report.columns)) {
        const cols = catalog.get(name);
        if (!cols) {
          report.errors.push(`復元先に表 ${name} がありません`);
          continue;
        }
        const byName = new Map(cols.map((c) => [c.name, c]));
        def.columns.forEach((c, i) => {
          const target = byName.get(c);
          if (!target || target.generated) report.errors.push(`復元先の表 ${name} に列 ${c} がありません`);
          else if (target.type !== def.types[i]) report.errors.push(`表 ${name} の列 ${c} の型が異なります(${def.types[i]} → ${target.type})`);
        });
        const present = new Set(def.columns);
        const omitted = new Set(tableSpec(name)?.omit ?? []);
        for (const c of cols) {
          if (!present.has(c.name) && !c.generated && c.notNull && !c.hasDefault && !omitted.has(c.name)) {
            report.errors.push(`表 ${name} の必須列 ${c.name} がバックアップにありません`);
          }
        }
      }
    } finally {
      client.release();
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}
