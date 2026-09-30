import pg from 'pg';

// date(1082) は文字列のまま扱う(JS Date への変換でタイムゾーンがずれるのを防ぐ)
pg.types.setTypeParser(1082, (v: string) => v);
// int8(20): count(*) 等。件数用途のため Number に変換(2^53 を超える値は扱わない)
pg.types.setTypeParser(20, (v: string) => Number(v));
// numeric(1700): 集計の平均値など
pg.types.setTypeParser(1700, (v: string) => Number(v));

export interface PoolOptions {
  connectionString: string;
  max?: number;
  ssl?: 'disable' | 'require' | 'no-verify';
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const ssl =
    opts.ssl === 'require' ? { rejectUnauthorized: true } : opts.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl,
    application_name: opts.applicationName ?? 'servicehub',
    statement_timeout: opts.statementTimeoutMs ?? 20000,
    idle_in_transaction_session_timeout: 60000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => {
    // アイドル接続のエラーでプロセスを落とさない
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

export type Pool = pg.Pool;
