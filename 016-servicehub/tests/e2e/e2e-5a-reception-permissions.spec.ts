/**
 * E2E-5(受付): Reception でログイン → 来店処理ができる → オーナー専用の設定・経営KPIは使えない(画面・API とも)
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { apiAs, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-5 受付: 来店処理は可、オーナー専用設定・KPIは不可', async ({ page }) => {
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const cust = await api.post('/api/v1/customers', { name: 'E2E 受付顧客', email: `recv-${Date.now()}@example.invalid`, phone: '090-5151-5151' });
  await api.post('/api/v1/bookings', {
    locationId: refs.ikebukuro,
    serviceId: refs.personal60,
    staffId: refs.mika,
    startsAt: jstIso(todayJst(), '07:00'),
    customer: { customerId: cust.id },
    force: true,
    forceReason: 'E2E の前提データ',
    idempotencyKey: idem('r'),
  });
  await api.dispose();

  await login(page, E2E.sample.reception, E2E.sample.password);
  // 来店処理(受付モード)
  await page.goto('/app/reception');
  const card = page.getByRole('article', { name: /E2E 受付顧客/ });
  await card.getByRole('button', { name: '● 来店' }).click();
  await expect(card).toContainText('来店済み');

  // オーナー専用の設定・経営KPI・監査ログは画面に出ず、直接開いても表示できない
  for (const path of ['/app/settings/org', '/app/settings/members', '/app/kpi', '/app/audit', '/app/csv']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '表示できません' }), path).toBeVisible();
  }
  // API でも拒否(画面を経由しない操作)
  const csrf = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken as string);
  const patch = await page.request.patch('/api/v1/org', { headers: { origin: E2E.baseUrl, 'x-csrf-token': csrf }, data: { name: '乗っ取り' } });
  expect(patch.status()).toBe(403);
  const kpi = await page.request.get(`/api/v1/kpi?from=${todayJst()}&to=${todayJst()}`);
  expect(kpi.status()).toBe(403);
  const members = await page.request.get('/api/v1/members');
  expect(members.status()).toBe(403);
});
