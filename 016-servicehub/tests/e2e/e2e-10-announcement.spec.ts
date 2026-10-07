/**
 * ServiceHub 空き枠お知らせ画像(#005 の統合): 実際の空き枠からプレビューを作り、PNG を保存できること。
 * サンプル組織のオーナーで、メニューから開いて確認する。
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { login } from './helpers';

test('空き枠お知らせ画像: プレビューと PNG 保存', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/announcement');
  await expect(page.getByRole('heading', { name: 'ServiceHub 空き枠お知らせ画像' })).toBeVisible();
  await page.getByLabel('店舗名').fill('サンプルウェルネス');
  await page.getByLabel('予約方法の案内文').fill('ご予約はWebからどうぞ');
  await page.getByLabel('空きの基準').selectOption('staff');
  const canvas = page.getByTestId('announcement-canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.spinner')).toHaveCount(0, { timeout: 15_000 });
  // 日ごとの枠の編集欄が7日分ある
  await expect(page.locator('fieldset[data-testid^="ann-day-"]')).toHaveCount(7);
  // 1日目を休業に上書きしても保存できる
  await page.locator('fieldset[data-testid^="ann-day-"]').first().getByLabel('この日の表示').selectOption('closed');
  const size = await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(size).toEqual([1080, 1080]);
  page.once('dialog', (d) => void d.accept());
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '画像を保存(PNG)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^空き枠_週間_\d{4}-\d{2}-\d{2}_正方形\.png$/);
  const file = await download.path();
  const head = readFileSync(file!).subarray(0, 8);
  expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 縦長にするとサイズが変わる
  await page.getByLabel('画像サイズ').selectOption('story');
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.height)).toBe(1920);
  expect(errors).toEqual([]);
});
