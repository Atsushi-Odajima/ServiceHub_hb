import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findAppRoot } from '../db/migrate.js';

/** CLI 用: .env を読み込み(既存の環境変数を優先)、必要最小限の設定を返す */
export function loadEnvFile(): void {
  const file = path.join(findAppRoot(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}

export function loadConfigForCli(): {
  DATABASE_URL: string;
  DATABASE_SSL: 'disable' | 'require' | 'no-verify';
  MIGRATIONS_DIR?: string;
  APP_BASE_URL: string;
} {
  loadEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (set it in .env or environment)');
    process.exit(1);
  }
  const ssl = (process.env.DATABASE_SSL ?? 'disable') as 'disable' | 'require' | 'no-verify';
  return { DATABASE_URL: url, DATABASE_SSL: ssl, MIGRATIONS_DIR: process.env.MIGRATIONS_DIR, APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:3000' };
}

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
