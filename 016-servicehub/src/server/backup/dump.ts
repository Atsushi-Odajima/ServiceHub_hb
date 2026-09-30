import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import type pg from 'pg';
import { appVersion as readAppVersion, currentSchemaVersion, dumpColumns, fixTextFormat, loadCatalog, selectRowsSql } from './catalog.js';
import {
  BackupFormatError,
  BackupWriter,
  createEncryptStream,
  secretFingerprint,
  validateEncryptionKey,
  type BackupFooter,
  type BackupHeader,
  type TableEndLine,
  type TableStartLine,
} from './format.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_TABLES, EXCLUDED_TABLES } from './spec.js';

export interface CreateBackupOptions {
  /** 指定すると AES-256-GCM で暗号化する */
  encryptionKey?: string | null;
  /** 復元先で SESSION_SECRET の違いを警告するための指紋に使う */
  sessionSecret?: string | null;
  appVersion?: string;
  now?: Date;
  /** 1回の FETCH 件数 */
  fetchSize?: number;
}

export interface BackupResult {
  header: BackupHeader;
  counts: Record<string, number>;
  /** NDJSON(footer を除く全行)の SHA-256 */
  sha256: string;
  encrypted: boolean;
}

const FETCH_SIZE = 2000;

/**
 * 組織1つ分のバックアップを書き出す。
 * - REPEATABLE READ READ ONLY の1トランザクション(全表が同じ時点の内容になる)
 * - テナント文脈(RLS)で読むため、他組織の行は含まれ得ない
 * - カーソルで分割して読み、gzip(+暗号化)しながら out へ書く(全体をメモリに載せない)
 */
export async function createBackup(pool: pg.Pool, orgId: string, out: Writable, opts: CreateBackupOptions = {}): Promise<BackupResult> {
  const key = validateEncryptionKey(opts.encryptionKey);
  const client = await pool.connect();
  let writer: BackupWriter | null = null;
  let released = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', '', true), set_config('app.system', 'off', true),
              set_config('statement_timeout', '0', true), set_config('idle_in_transaction_session_timeout', '1800000', true)`,
      [orgId],
    );
    await fixTextFormat(client);
    const catalog = await loadCatalog(client);
    const schemaVersion = await currentSchemaVersion(client);
    const org = (
      await client.query<{ id: string; slug: string; name: string; timezone: string; is_sample: boolean }>(
        'SELECT id, slug, name, timezone, is_sample FROM organizations WHERE id = $1',
        [orgId],
      )
    ).rows[0];
    if (!org) throw new BackupFormatError('組織が見つかりません');

    writer = new BackupWriter(out, key ? await createEncryptStream(key) : null);
    const header: BackupHeader = {
      type: 'header',
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion,
      appVersion: opts.appVersion ?? readAppVersion(),
      createdAt: (opts.now ?? new Date()).toISOString(),
      organization: { id: org.id, slug: org.slug, name: org.name, timezone: org.timezone, isSample: org.is_sample },
      tables: BACKUP_TABLES.map((t) => t.name),
      excludedTables: Object.keys(EXCLUDED_TABLES),
      secretFingerprint: secretFingerprint(opts.sessionSecret),
    };
    await writer.line(JSON.stringify(header));

    const counts: Record<string, number> = {};
    const fetchSize = opts.fetchSize ?? FETCH_SIZE;
    for (const spec of BACKUP_TABLES) {
      const cols = dumpColumns(catalog, spec);
      const start: TableStartLine = { type: 'table', name: spec.name, columns: cols.map((c) => c.name), types: cols.map((c) => c.type) };
      await writer.line(JSON.stringify(start));
      const digest = createHash('sha256');
      let count = 0;
      await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR ${selectRowsSql(spec, start.columns)}`, [orgId]);
      for (;;) {
        const r = await client.query<unknown[]>({ text: `FETCH ${fetchSize} FROM backup_rows`, rowMode: 'array' });
        if (r.rows.length === 0) break;
        const text = r.rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        digest.update(text);
        await writer.batch(text, r.rows.length);
        count += r.rows.length;
      }
      await client.query('CLOSE backup_rows');
      counts[spec.name] = count;
      const end: TableEndLine = { type: 'end', name: spec.name, count, sha256: digest.digest('hex') };
      await writer.line(JSON.stringify(end));
    }
    const sha256 = writer.digest();
    const footer: BackupFooter = { type: 'footer', counts, lines: writer.lines, sha256 };
    await writer.raw(JSON.stringify(footer) + '\n');
    await writer.finish();
    await client.query('COMMIT');
    return { header, counts, sha256, encrypted: Boolean(key) };
  } catch (err) {
    writer?.abort(err as Error);
    try {
      await client.query('ROLLBACK');
    } catch {
      client.release(true);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}
