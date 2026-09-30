import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { findAppRoot } from '../db/migrate.js';
import type { TableSpec } from './spec.js';

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

/** 現在のDBの表と列(列番号順) */
export async function loadCatalog(db: Queryable): Promise<Map<string, ColumnInfo[]>> {
  const r = await db.query<{ table_name: string; name: string; type: string; not_null: boolean; has_default: boolean; generated: boolean }>(
    `SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, a.atthasdef AS has_default, a.attgenerated <> '' AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const map = new Map<string, ColumnInfo[]>();
  for (const row of r.rows) {
    const list = map.get(row.table_name) ?? [];
    list.push({ name: row.name, type: row.type, notNull: row.not_null, hasDefault: row.has_default, generated: row.generated });
    map.set(row.table_name, list);
  }
  return map;
}

export async function currentSchemaVersion(db: Queryable): Promise<string> {
  const r = await db.query<{ v: string | null }>('SELECT max(version) AS v FROM schema_migrations');
  return r.rows[0]?.v ?? '0000';
}

/** バックアップに書き出す列(生成列・一時的な状態の列を除く) */
export function dumpColumns(catalog: Map<string, ColumnInfo[]>, spec: TableSpec): ColumnInfo[] {
  const cols = catalog.get(spec.name);
  if (!cols) throw new Error(`table not found: ${spec.name}`);
  const omit = new Set(spec.omit ?? []);
  return cols.filter((c) => !c.generated && !omit.has(c.name));
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 行の抽出SQL(出力と復元後の照合で同じものを使う) */
export function selectRowsSql(spec: TableSpec, columns: readonly string[]): string {
  const list = columns.map((c) => `${quoteIdent(c)}::text`).join(', ');
  return `SELECT ${list} FROM ${quoteIdent(spec.name)} WHERE ${spec.where ?? 'organization_id = $1'} ORDER BY ${spec.orderBy}`;
}

/** 出力/照合のトランザクションで値のテキスト表現を固定する(UTC・ISO 形式) */
export async function fixTextFormat(db: Queryable): Promise<void> {
  await db.query(`SELECT set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, MDY', true), set_config('IntervalStyle', 'postgres', true)`);
}

let cachedVersion: string | null = null;
/** package.json の version */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(findAppRoot(), 'package.json'), 'utf8')) as { version?: string };
    cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
