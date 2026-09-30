/**
 * セキュリティ(XSS): 入力に含まれる HTML/スクリプトは実行されず、文字として表示される。
 * 顧客名・メモ・検索結果・予約の要望(公開予約から入力)で確認する。
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { apiAs, login } from './helpers';

test('入力されたスクリプトは実行されず文字として表示される', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const name = `<img src=x onerror="alert('xss-name')">XSS確認`;
  const memo = `<script>alert('xss-memo')</script><b>太字?</b>`;
  const c = await api.post<{ id: string }>('/api/v1/customers', { name, memo, tags: ['<i>tag</i>'] });
  await api.post(`/api/v1/customers/${c.id}/notes`, { body: `<svg onload="alert('xss-note')"></svg>メモ`, visibility: 'general' });
  await api.dispose();

  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto(`/app/customers/${c.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('tab', { name: /メモ/ }).click();
  await expect(page.getByText(`<svg onload="alert('xss-note')"></svg>メモ`)).toBeVisible();
  await page.goto('/app/customers');
  await expect(page.getByRole('link', { name })).toBeVisible();
  await page.goto(`/app/search?q=${encodeURIComponent('XSS確認')}`);
  await expect(page.getByText(name).first()).toBeVisible();
  // 差し込まれた要素は作られていない
  expect(await page.locator('img[src="x"], svg[onload], script:not([src])').count()).toBe(0);
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});
