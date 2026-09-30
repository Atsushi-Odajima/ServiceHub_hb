/**
 * 主要画面が PC / iPhone / Android / iPad で表示でき、横スクロール(はみ出し)やスクリプトエラーがないこと。
 * サンプル組織のオーナーで確認する。
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { login } from './helpers';

const PAGES: { path: string; heading: RegExp }[] = [
  { path: '/app', heading: /今日|ダッシュボード/ },
  { path: '/app/schedule', heading: /予定表/ },
  { path: '/app/bookings', heading: /^予約$/ },
  { path: '/app/customers', heading: /顧客/ },
  { path: '/app/passes', heading: /回数券/ },
  { path: '/app/plans', heading: /利用プラン/ },
  { path: '/app/shifts', heading: /シフト/ },
  { path: '/app/notifications', heading: /通知/ },
  { path: '/app/settings', heading: /設定/ },
  { path: '/app/settings/pass-products', heading: /回数券の種類/ },
  { path: '/app/settings/plan-products', heading: /利用プランの種類/ },
  { path: '/app/settings/backup', heading: /^バックアップと復元$/ },
  { path: '/app/reception', heading: /受付モード/ },
  { path: '/app/waitlist', heading: /待機リスト/ },
  { path: '/app/kpi', heading: /運営KPI/ },
  { path: '/app/search?q=%E5%B8%B8%E9%80%A3', heading: /検索/ },
  { path: '/app/csv', heading: /CSV入出力/ },
  { path: '/app/audit', heading: /監査ログ/ },
];

test('主要画面の表示(はみ出し・エラーなし)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, E2E.sample.owner, E2E.sample.password);
  for (const p of PAGES) {
    await page.goto(p.path);
    await expect(page.getByRole('heading', { name: p.heading }).first(), p.path).toBeVisible();
    // 読み込み完了(スピナーが消える)を待つ
    await expect(page.locator('.spinner')).toHaveCount(0, { timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${p.path} が横にはみ出しています(${overflow}px)`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('公開予約ページの表示(ログイン不要)', async ({ page }) => {
  await page.goto(`/p/${E2E.sample.slug}`);
  await expect(page.getByRole('link', { name: /池袋店/ })).toBeVisible();
  await page.getByRole('link', { name: /新宿店/ }).click();
  await expect(page.getByRole('heading', { name: 'サービスを選んでください' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('キャンセル待ちの登録(公開・ログイン不要)', async ({ page }) => {
  await page.goto(`/p/${E2E.sample.slug}/shinjuku`);
  await page.getByRole('button', { name: /6名ヨガ/ }).click();
  // 公開予約の画面から待機登録ページへ(満席でない日でも登録ページは開ける)
  await page.goto(`/p/${E2E.sample.slug}/shinjuku/waitlist`);
  await expect(page.getByRole('heading', { name: 'キャンセル待ちに登録' })).toBeVisible();
  await page.getByLabel('サービス').selectOption({ label: '6名ヨガ' });
  await page.getByLabel('お名前').fill('公開 待機テスト');
  await page.getByLabel('メールアドレス').fill(`wait-${test.info().project.name}-${Date.now()}@example.invalid`);
  await page.getByLabel('電話番号').fill('090-1212-3434');
  await page.getByLabel(/自動では予約されないこと/).check();
  await page.waitForTimeout(3200); // bot 対策(表示からの最短時間)
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('heading', { name: /キャンセル待ちを受け付けました/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
