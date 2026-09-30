/**
 * 組織単位のバックアップ / 検証 / 復元
 *
 *   開発環境:  pnpm backup:create -- --org <slug> [--out <ファイル>] [--no-encrypt]
 *              pnpm backup:verify -- --file <ファイル>
 *              pnpm backup:restore -- --file <ファイル> [--replace <slug>] [--dry-run] [--yes] [--database-url <URL>] [--migrate]
 *   本番(ビルド済み): node dist/server/cli/backup.js create --org <slug>  … 以下同様
 *
 * - BACKUP_ENCRYPTION_KEY が設定されていれば作成時に暗号化し、検証/復元時に復号する(キーを失うと復元できない)
 * - restore は既定で「その組織が存在しない環境」への復元(new)。--replace <slug> でその組織を置き換える
 * - --dry-run: 復元とすべての照合を行ったうえで最後に取り消す(復元テスト)
 * - --database-url: 復元先を別のDBにする(空のテスト環境への復元テスト)。--migrate でDB構造を先に作成する
 */
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { argValue, hasFlag, loadConfigForCli } from './cli-config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { withSystem } from '../db/tx.js';
import { createBackup } from '../backup/dump.js';
import { restoreBackup, type RestoreReport } from '../backup/restore.js';
import { verifyBackup, type VerifyReport } from '../backup/verify.js';
import { BACKUP_FILE_EXT, TABLE_LABELS } from '../backup/spec.js';
import { AppError } from '../errors.js';

const command = process.argv[2];
const config = loadConfigForCli();
const databaseUrl = argValue('database-url') ?? config.DATABASE_URL;
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY || null;
const sessionSecret = process.env.SESSION_SECRET || null;
const OPERATOR = { type: 'operator' as const, label: 'backup-cli' };

function usage(): never {
  console.error(`使い方:
  backup create  --org <slug> [--out <ファイル>] [--no-encrypt]
  backup verify  --file <ファイル>
  backup restore --file <ファイル> [--replace <slug>] [--dry-run] [--yes] [--database-url <URL>] [--migrate]`);
  process.exit(1);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function printCounts(counts: Record<string, number>): void {
  for (const [name, n] of Object.entries(counts)) {
    if (n > 0) console.info(`  ${(TABLE_LABELS[name] ?? name).padEnd(12, '　')} ${String(n).padStart(8)}`);
  }
}

function printVerify(file: string, r: VerifyReport): void {
  console.info(`ファイル: ${file}`);
  if (r.header) {
    const o = r.header.organization;
    console.info(`組織: ${o.name} (${o.slug})${o.isSample ? ' [サンプル]' : ''}`);
    console.info(`作成日時: ${r.header.createdAt} / アプリ ${r.header.appVersion} / DB構造 ${r.header.schemaVersion}${r.currentSchemaVersion ? `(復元先 ${r.currentSchemaVersion})` : ''}`);
    console.info(`暗号化: ${r.encrypted ? 'あり' : 'なし'} / SHA-256: ${r.sha256 ?? '-'}`);
    console.info('件数:');
    printCounts(r.counts);
  }
  for (const w of r.warnings) console.warn(`注意: ${w}`);
  for (const e of r.errors) console.error(`エラー: ${e}`);
  console.info(r.ok ? '検証結果: OK(復元できます)' : '検証結果: NG');
}

function printRestore(r: RestoreReport): void {
  console.info(r.dryRun ? '=== 復元テスト(最後に取り消しました。データは変わっていません) ===' : '=== 復元しました ===');
  console.info(`組織: ${r.organization.name} (${r.organization.slug}) / バックアップ作成 ${r.backupCreatedAt}`);
  if (r.replaced) console.info(`置き換えた組織: ${r.replaced.name} (${r.replaced.slug}) 予約 ${r.replaced.counts.bookings ?? 0} 件 / 顧客 ${r.replaced.counts.customers ?? 0} 件`);
  console.info('表ごとの照合(件数 / 内容):');
  for (const t of r.tables) {
    if (t.expected === 0 && t.restored === 0) continue;
    console.info(`  ${t.label.padEnd(12, '　')} ${String(t.restored).padStart(8)} 件  ${t.digest === 'match' ? '一致' : `照合省略(${t.note ?? ''})`}`);
  }
  console.info(`台帳の再計算: 回数券 ${r.ledger.passes} 枚(台帳 ${r.ledger.passEntries} 件)・利用プラン期間 ${r.ledger.periods} 件(台帳 ${r.ledger.planEntries} 件) すべて残数一致`);
  console.info(`ログインユーザー: 作成 ${r.users.created} / 既存に紐付け ${r.users.linked} / 権限を無効で復元 ${r.users.membershipsDisabled}`);
  for (const w of r.warnings) console.warn(`注意: ${w}`);
  console.info(`所要時間: ${(r.durationMs / 1000).toFixed(1)} 秒`);
}

async function confirm(question: string, expected: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  if (!['create', 'verify', 'restore'].includes(command ?? '')) usage();
  const pool = createPool({ connectionString: databaseUrl, ssl: config.DATABASE_SSL, max: 3, applicationName: 'servicehub-backup', statementTimeoutMs: 0 });
  try {
    if (command === 'create') {
      const slug = argValue('org');
      if (!slug) usage();
      const org = await withSystem(pool, (q) => q.maybeOne<{ id: string; slug: string }>('SELECT id, slug FROM organizations WHERE slug = $1', [slug]));
      if (!org) {
        console.error(`組織 "${slug}" が見つかりません`);
        return 1;
      }
      const now = new Date();
      const out = path.resolve(argValue('out') ?? `servicehub-backup_${org.slug}_${stamp(now)}${BACKUP_FILE_EXT}`);
      const partial = `${out}.partial`;
      const key = hasFlag('no-encrypt') ? null : encryptionKey;
      try {
        const result = await createBackup(pool, org.id, createWriteStream(partial, { mode: 0o600 }), { encryptionKey: key, sessionSecret, now });
        await rename(partial, out);
        const size = (await stat(out)).size;
        await withSystem(pool, (q) =>
          q.exec(
            `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, metadata)
             VALUES ($1, 'operator', 'backup-cli', 'backup.created', 'organization', $1, $2)`,
            [org.id, JSON.stringify({ via: 'cli', sha256: result.sha256, bytes: size, encrypted: result.encrypted, counts: result.counts })],
          ),
        );
        console.info(`バックアップを作成しました: ${out}`);
        console.info(`サイズ ${(size / 1024).toFixed(1)} KB / 暗号化 ${result.encrypted ? 'あり' : 'なし(BACKUP_ENCRYPTION_KEY 未設定)'} / SHA-256 ${result.sha256}`);
        printCounts(result.counts);
        return 0;
      } catch (e) {
        await rm(partial, { force: true });
        throw e;
      }
    }

    const file = argValue('file');
    if (!file) usage();
    const abs = path.resolve(file);
    if (hasFlag('migrate')) {
      const r = await migrate(pool, config.MIGRATIONS_DIR);
      if (r.applied.length) console.info(`DB構造を作成/更新しました: ${r.applied.join(', ')}`);
    }
    const report = await verifyBackup(abs, { pool, encryptionKey, sessionSecret });
    printVerify(abs, report);
    if (!report.ok) return 1;
    if (command === 'verify') return 0;

    const replaceSlug = argValue('replace');
    let replaceOrgId: string | null = null;
    if (replaceSlug) {
      const target = await withSystem(pool, (q) => q.maybeOne<{ id: string; name: string }>('SELECT id, name FROM organizations WHERE slug = $1', [replaceSlug]));
      if (!target) {
        console.error(`置き換える組織 "${replaceSlug}" が見つかりません`);
        return 1;
      }
      replaceOrgId = target.id;
      if (!hasFlag('dry-run') && !hasFlag('yes')) {
        console.warn(`\n組織「${target.name}」(${replaceSlug}) の現在のデータをすべて削除し、バックアップの内容に置き換えます。`);
        console.warn('この操作は取り消せません。先に現在のデータのバックアップを作成してください。');
        const ok = await confirm(`続けるには組織のURL名 "${replaceSlug}" を入力してください: `, replaceSlug);
        if (!ok) {
          console.info('中止しました');
          return 1;
        }
      }
    }
    const result = await restoreBackup(pool, abs, {
      mode: replaceOrgId ? 'replace' : 'new',
      replaceOrgId,
      encryptionKey,
      actor: OPERATOR,
      existingUserPolicy: 'link',
      dryRun: hasFlag('dry-run'),
      sessionSecret,
    });
    printRestore(result);
    return 0;
  } catch (e) {
    if (e instanceof AppError) {
      console.error(`エラー: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
