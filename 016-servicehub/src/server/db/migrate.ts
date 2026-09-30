import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** プロジェクトルート(db/migrations を含むディレクトリ)を探す */
export function findAppRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'db', 'migrations'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function defaultMigrationsDir(): string {
  return path.join(findAppRoot(), 'db', 'migrations');
}

export function listMigrations(dir: string): { version: string; name: string; file: string; sql: string; checksum: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(dir, f), 'utf8');
      return {
        version: f.slice(0, 4),
        name: f.replace(/\.sql$/, ''),
        file: f,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/**
 * 未適用の移行を順番に適用する。
 * - 同時起動した複数インスタンスが同時に適用しないよう advisory lock を取得する
 * - 適用済み移行の内容が変わっていたら停止する(checksum 不一致)
 */
export async function migrate(pool: pg.Pool, dir = defaultMigrationsDir()): Promise<MigrationResult> {
  const migrations = listMigrations(dir);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended('servicehub:migrations', 0))`);
    const exists = await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`);
    const applied = new Map<string, string>();
    if (exists.rows[0].ok) {
      const r = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
      for (const row of r.rows) applied.set(row.version, row.checksum);
    }
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) {
          throw new Error(`Migration ${m.file} was modified after being applied (checksum mismatch)`);
        }
        result.skipped.push(m.file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.system', 'on', true)`);
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(m.file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.file} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended('servicehub:migrations', 0))`);
    } finally {
      client.release();
    }
  }
}

export async function currentSchemaVersion(pool: pg.Pool): Promise<string | null> {
  const r = await pool.query<{ v: string | null }>(
    `SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN NULL
            ELSE (SELECT max(version) FROM schema_migrations) END AS v`,
  );
  return r.rows[0]?.v ?? null;
}

/**
 * 接続ロールが RLS を回避できないことを確認する(superuser / BYPASSRLS では RLS が効かない)。
 */
export async function checkRlsEffective(pool: pg.Pool): Promise<{ ok: boolean; role: string; reason?: string }> {
  const r = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const row = r.rows[0];
  if (!row) return { ok: false, role: 'unknown', reason: 'role not found' };
  if (row.rolsuper) return { ok: false, role: row.rolname, reason: 'connected role is SUPERUSER (RLS is bypassed)' };
  if (row.rolbypassrls) return { ok: false, role: row.rolname, reason: 'connected role has BYPASSRLS' };
  return { ok: true, role: row.rolname };
}
