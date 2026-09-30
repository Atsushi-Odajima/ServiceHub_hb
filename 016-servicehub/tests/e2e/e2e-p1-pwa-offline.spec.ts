/**
 * PWA とオフライン(iPhone・iPad で実行)
 * - ホーム画面に追加できる情報(manifest: standalone・アイコン、apple-touch-icon、theme-color)と Service Worker
 * - 通信が切れたら「オフライン」を表示し、来店・完了などの操作はできない(確定したように見せない)
 * - 通信が切れた状態で開き直しても、最後に取得した受付ボードを「オフライン表示」として見られる
 * - 再接続で操作できるようになる。ログアウトで閲覧キャッシュ(個人情報)を消す
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { login } from './helpers';

test('PWA: ホーム画面に追加でき、オフラインでは閲覧のみ・操作はできない', async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({ name: 'ServiceHub', display: 'standalone', start_url: '/app', lang: 'ja' });
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);

  // 受付担当で受付ボードを開く(Service Worker が有効になってから読み直し、閲覧キャッシュを作る)
  await login(page, E2E.sample.reception, E2E.sample.password);
  await page.goto('/app/reception');
  await expect
    .poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)), { timeout: 30_000 })
    .toBe(true);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 30_000 });
  const cards = page.locator('.rcard');
  await expect(cards.first()).toBeVisible();
  const namesOnline = await cards.locator('.rname').allInnerTexts();
  expect(namesOnline.length).toBeGreaterThan(0);

  // 通信が切れる → オフライン表示、操作ボタンは押せない
  await context.setOffline(true);
  await expect(page.getByText(/オフラインです/)).toBeVisible();
  const actionButtons = page.locator('.rcard button');
  const count = await actionButtons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(actionButtons.nth(i)).toBeDisabled();

  // オフラインのまま開き直しても、最後に取得した内容を表示(操作は不可のまま)
  await page.reload();
  await expect(page.getByText(/オフラインです/)).toBeVisible();
  await expect(cards.first()).toBeVisible();
  expect(await cards.locator('.rname').allInnerTexts()).toEqual(namesOnline);
  for (let i = 0; i < (await actionButtons.count()); i++) await expect(actionButtons.nth(i)).toBeDisabled();

  // 再接続で操作できる
  await context.setOffline(false);
  await expect(page.getByText(/オフラインです/)).toHaveCount(0);
  await expect(page.locator('.rcard button:not([disabled])').first()).toBeVisible();

  // ログアウトで閲覧キャッシュを消す(共有の iPad で次の人に前の人の情報を出さない)
  expect(await page.evaluate(async () => (await caches.keys()).includes('sh-offline-read'))).toBe(true);
  await page.goto('/app');
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await page.waitForURL(/\/login/);
  expect(await page.evaluate(async () => (await caches.keys()).includes('sh-offline-read'))).toBe(false);
});
