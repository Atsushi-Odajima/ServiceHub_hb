import { createHash } from 'node:crypto';
import type pg from 'pg';
import { mapPgError } from '../errors.js';

/** トランザクション内のクエリ実行インターフェース(常にパラメータ化クエリ) */
export interface Q {
  /** 複数行を返す */
  many<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 1行必須。0行なら例外 */
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T>;
  /** 0 または 1 行 */
  maybeOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** 影響行数を返す */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  readonly orgId: string | null;
  readonly isSystem: boolean;
}

export interface TxOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

function makeQ(client: pg.PoolClient, orgId: string | null, isSystem: boolean): Q {
  const run = async (sql: string, params?: readonly unknown[]) => {
    try {
      return await client.query(sql, params as unknown[] | undefined);
    } catch (err) {
      throw mapPgError(err);
    }
  };
  return {
    orgId,
    isSystem,
    async many<T>(sql: string, params?: readonly unknown[]) {
      return (await run(sql, params)).rows as T[];
    },
    async one<T>(sql: string, params?: readonly unknown[]) {
      const r = await run(sql, params);
      if (r.rows.length === 0) throw new Error(`Expected one row, got 0: ${sql.slice(0, 80)}`);
      return r.rows[0] as T;
    },
    async maybeOne<T>(sql: string, params?: readonly unknown[]) {
      const r = await run(sql, params);
      return (r.rows[0] as T | undefined) ?? null;
    },
    async exec(sql: string, params?: readonly unknown[]) {
      return (await run(sql, params)).rowCount ?? 0;
    },
  };
}

async function runTx<T>(
  pool: pg.Pool,
  settings: { orgId: string | null; userId?: string | null; system: boolean },
  fn: (q: Q) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  try {
    const mode = [
      opts.isolation ? `ISOLATION LEVEL ${opts.isolation.toUpperCase()}` : '',
      opts.readOnly ? 'READ ONLY' : '',
    ]
      .filter(Boolean)
      .join(' ');
    await client.query(`BEGIN ${mode}`);
    // set_config(..., true) はトランザクション終了で自動的に消える(プール再利用時に漏れない)
    await client.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.system', $3, true)`,
      [settings.orgId ?? '', settings.userId ?? '', settings.system ? 'on' : 'off'],
    );
    if (opts.lockTimeoutMs) {
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${opts.lockTimeoutMs}ms`]);
    }
    if (opts.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${opts.statementTimeoutMs}ms`]);
    }
    const q = makeQ(client, settings.orgId, settings.system);
    const result = await fn(q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 接続自体が壊れている場合は破棄する
      client.release(true);
      released = true;
    }
    throw mapPgError(err);
  } finally {
    if (!released) client.release();
  }
}

/** テナント文脈でトランザクションを実行(RLS により他組織の行は見えない/書けない) */
export function withTenant<T>(
  pool: pg.Pool,
  ctx: { orgId: string; userId?: string | null },
  fn: (q: Q) => Promise<T>,
  opts?: TxOptions,
): Promise<T> {
  if (!ctx.orgId) throw new Error('withTenant requires orgId');
  return runTx(pool, { orgId: ctx.orgId, userId: ctx.userId ?? null, system: false }, fn, opts);
}

/**
 * システム文脈(RLSの組織制限を越える)。ログイン照合・公開ページの組織解決・ジョブ・移行・バックアップに限定して使う。
 * 通常のAPIハンドラでは使用しないこと。
 */
export function withSystem<T>(pool: pg.Pool, fn: (q: Q) => Promise<T>, opts?: TxOptions): Promise<T> {
  return runTx(pool, { orgId: null, system: true }, fn, opts);
}

/** システム文脈だが組織IDも設定(ジョブが特定組織の処理をする場合) */
export function withSystemForOrg<T>(
  pool: pg.Pool,
  orgId: string,
  fn: (q: Q) => Promise<T>,
  opts?: TxOptions,
): Promise<T> {
  return runTx(pool, { orgId, system: true }, fn, opts);
}

/** 名前空間付き文字列("staff:<uuid>" 等) → 64bit advisory lock key */
export function lockKey(name: string): bigint {
  const digest = createHash('sha256').update(name).digest();
  return digest.readBigInt64BE(0);
}

/**
 * 複数の advisory lock をトランザクション終了まで保持する。
 * 全トランザクションが同じ(数値昇順)順序で取得するためデッドロックしない。
 */
export async function advisoryLockAll(q: Q, names: string[]): Promise<void> {
  const keys = [...new Set(names.map(lockKey))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return;
  for (const k of keys) {
    await q.many('SELECT pg_advisory_xact_lock($1::bigint)', [k.toString()]);
  }
}
