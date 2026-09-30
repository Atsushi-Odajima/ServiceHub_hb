/**
 * E2E-7: バックアップ → 空環境へ復元 → 拠点/スタッフ/予約/顧客/回数券残/利用プラン/実施履歴/監査が一致
 *
 * 1. 環境A(E2E サーバー)で Owner が 設定 > バックアップ からファイルをダウンロード
 * 2. 空のDBを作り、購入者向け手順と同じコマンド(backup.js restore --migrate)で復元
 * 3. 復元したDBで2台目のサーバー(環境B)を起動し、同じパスワードでログイン
 * 4. 同じ画面を環境A/Bで開き、表示内容が一致することを確認(IDも同じため同じURLで開ける)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E } from './env';
import { addDaysIso, login, todayJst } from './helpers';

const PORT_B = E2E.port + 1;
const BASE_B = `http://localhost:${PORT_B}`;
const RESTORE_DB_URL = E2E.databaseUrl.replace(/\/[a-z0-9_]+$/, '/servicehub_restore_e2e');

let serverB: ChildProcess | null = null;
let logB = '';

test.afterAll(async () => {
  serverB?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
});

async function recreateRestoreDb(): Promise<void> {
  const admin = new URL(RESTORE_DB_URL);
  const name = admin.pathname.slice(1);
  if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new Error(`refusing to reset ${name}`);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

function envFor(databaseUrl: string, port: number) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'disable',
    SESSION_SECRET: E2E.sessionSecret,
    APP_BASE_URL: `http://localhost:${port}`,
    PORT: String(port),
    EMAIL_PROVIDER: 'log',
    RUN_WORKER: 'false',
    MIGRATE_ON_START: 'false',
    LOG_LEVEL: 'warn',
    LOGIN_RATE_LIMIT_PER_15MIN: '1000',
  };
}

async function waitForHealth(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server B did not start\n${logB.slice(-3000)}`);
}

/** 表の行(見出しを除く)の表示テキスト */
async function tableRows(page: Page): Promise<string[]> {
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();
  return (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

test('E2E-7 バックアップ → 空環境へ復元 → 拠点/スタッフ/予約/顧客/回数券残/利用プラン/実施履歴/監査が一致', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  // ---- 1. 環境Aでバックアップを作成してダウンロード ----
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/settings/backup');
  await expect(page.getByRole('heading', { name: 'バックアップと復元', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'バックアップを作成してダウンロード' }).click();
  const file = testInfo.outputPath('sample.shbak');
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^servicehub-backup_sample-wellness_\d{8}-\d{4}\.shbak$/);
  await d.saveAs(file);

  // ---- 2. 空のDBへ復元(購入者向け手順のコマンド) ----
  await recreateRestoreDb();
  const out = execFileSync('node', ['dist/server/cli/backup.js', 'restore', '--file', file, '--migrate'], {
    env: envFor(RESTORE_DB_URL, PORT_B),
    encoding: 'utf8',
  });
  expect(out).toContain('検証結果: OK');
  expect(out).toContain('=== 復元しました ===');
  expect(out).toContain('すべて残数一致');
  expect(out).not.toContain('SESSION_SECRET');

  // ---- 3. 復元したDBで環境Bを起動 ----
  serverB = spawn('node', ['dist/server/index.js'], { env: envFor(RESTORE_DB_URL, PORT_B), stdio: ['ignore', 'pipe', 'pipe'] });
  serverB.stdout?.on('data', (x) => (logB += x));
  serverB.stderr?.on('data', (x) => (logB += x));
  await waitForHealth(`${BASE_B}/healthz`);
  const ctxB = await browser.newContext({ baseURL: BASE_B, viewport: { width: 1366, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const pageB = await ctxB.newPage();
  await login(pageB, E2E.sample.owner, E2E.sample.password);

  const same = async (path: string, prepare?: (p: Page) => Promise<void>) => {
    const read = async (p: Page) => {
      await p.goto(path);
      if (prepare) await prepare(p);
      return tableRows(p);
    };
    const a = await read(page);
    const b = await read(pageB);
    expect(b, path).toEqual(a);
    return a;
  };

  // 拠点・スタッフ
  const locations = await same('/app/settings/locations');
  expect(locations.join()).toContain('池袋店');
  expect(locations.join()).toContain('新宿店');
  const staff = await same('/app/settings/staff');
  expect(staff.join()).toMatch(/Aki.*|Mika|Ken/);
  // 予約(過去70日〜30日先)
  const today = todayJst();
  const fromIso = new Date(`${addDaysIso(today, -70)}T00:00:00+09:00`).toISOString();
  const toIso = new Date(`${addDaysIso(today, 31)}T00:00:00+09:00`).toISOString();
  const bookings = await same('/app/bookings', async (p) => {
    await expect(p.locator('table tbody tr').first()).toBeVisible();
    const loaded = p.waitForResponse((r) => r.url().includes('/api/v1/bookings?') && r.url().includes(encodeURIComponent(fromIso)) && r.url().includes(encodeURIComponent(toIso)));
    await p.getByLabel('開始日').fill(addDaysIso(today, -70));
    await p.getByLabel('終了日').fill(addDaysIso(today, 30));
    await loaded;
    await p.waitForTimeout(500);
  });
  expect(bookings.length).toBeGreaterThanOrEqual(8);
  // 顧客
  const customers = await same('/app/customers');
  expect(customers.join()).toContain('常連 太郎');
  // 回数券(残回数)
  const passes = await same('/app/passes', async (p) => {
    await expect(p.locator('table tbody tr').first()).toBeVisible();
    const loaded = p.waitForResponse((r) => r.url().includes('/api/v1/passes?') && r.url().includes('status=all'));
    await p.getByLabel('状態').selectOption('all');
    await loaded;
    await p.waitForTimeout(500);
  });
  expect(passes.join()).toContain('残一 次郎');
  // 回数券の台帳(同じIDで開ける)
  await page.goto('/app/passes');
  await page.getByRole('link', { name: /残一 次郎/ }).first().click();
  await page.waitForURL(/\/app\/passes\/[0-9a-f-]{36}$/);
  const passPath = new URL(page.url()).pathname;
  const ledger = await same(passPath);
  expect(ledger.length).toBeGreaterThanOrEqual(8);
  await expect(pageB.getByText('残り回数')).toBeVisible();
  // 利用プラン
  const plans = await same('/app/plans');
  expect(plans.join()).toContain('月4回');
  // 実施履歴(顧客の時系列に実施記録が並ぶ)
  await page.goto('/app/customers');
  await page.getByRole('link', { name: '常連 太郎' }).first().click();
  await page.waitForURL(/\/app\/customers\/[0-9a-f-]{36}$/);
  const customerPath = new URL(page.url()).pathname;
  const timeline = async (p: Page) => {
    await p.goto(customerPath);
    const items = p.locator('ul.timeline > li');
    await expect(items.first()).toBeVisible();
    return (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  };
  const tA = await timeline(page);
  const tB = await timeline(pageB);
  expect(tB).toEqual(tA);
  expect(tA.filter((x) => x.includes('実施')).length).toBeGreaterThanOrEqual(4);
  // 監査ログ(Aにはバックアップ作成、Bには復元の記録が1件ずつ増えている)
  const auditA = (await (async () => {
    await page.goto('/app/audit');
    return tableRows(page);
  })()).filter((r) => !r.includes('バックアップ作成'));
  await pageB.goto('/app/audit');
  const auditRowsB = await tableRows(pageB);
  expect(auditRowsB[0]).toContain('バックアップ復元');
  const auditB = auditRowsB.filter((r) => !r.includes('バックアップ復元'));
  expect(auditB.slice(0, 80)).toEqual(auditA.slice(0, 80));
  await ctxB.close();
});
