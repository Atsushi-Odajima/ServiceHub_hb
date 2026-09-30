/**
 * E2E-5(スタッフ): Staff でログイン → 自分の予約の実施記録ができる → 経営KPIは使えない(他拠点を含め画面・API とも)
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { apiAs, expectToast, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-5 スタッフ: 実施記録は可、経営KPIは不可', async ({ page }) => {
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const cust = await api.post('/api/v1/customers', { name: 'E2E 記録顧客', email: `rec-${Date.now()}@example.invalid`, phone: '090-5252-5252' });
  await api.post('/api/v1/bookings', {
    locationId: refs.ikebukuro,
    serviceId: refs.personal60,
    staffId: refs.aki,
    startsAt: jstIso(todayJst(), '08:00'),
    customer: { customerId: cust.id },
    force: true,
    forceReason: 'E2E の前提データ',
    idempotencyKey: idem('s'),
  });
  await api.dispose();

  await login(page, E2E.sample.aki, E2E.sample.password);
  await page.getByRole('link', { name: /E2E 記録顧客/ }).click();
  await page.getByRole('button', { name: /完了・実施記録/ }).click();
  await page.getByLabel('内部メモ(スタッフのみ)').fill('E2E: 姿勢改善のメニュー');
  await page.getByLabel('お客様向けメモ').fill('ストレッチを毎日5分');
  await page.getByRole('button', { name: '✓ 完了にする' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '完了にする' }).click();
  await expectToast(page, '完了しました');
  await expect(page.getByText('E2E: 姿勢改善のメニュー')).toBeVisible();

  // 経営KPI: 画面・API とも不可(拠点指定でも不可)
  await page.goto('/app/kpi');
  await expect(page.getByRole('heading', { name: '表示できません' })).toBeVisible();
  const today = todayJst();
  expect((await page.request.get(`/api/v1/kpi?from=${today}&to=${today}`)).status()).toBe(403);
  const locs = (await (await page.request.get('/api/v1/locations')).json()).items as { id: string; slug: string }[];
  const shinjuku = locs.find((l) => l.slug === 'shinjuku')!;
  expect((await page.request.get(`/api/v1/kpi?from=${today}&to=${today}&locationId=${shinjuku.id}`)).status()).toBe(403);
  expect((await page.request.get('/api/v1/audit')).status()).toBe(403);
});
