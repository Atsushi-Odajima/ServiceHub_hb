/**
 * E2E-6: iPad 受付で来店済み → iPhone の Staff 画面に反映 → Staff が完了 → PC の Owner 画面に反映
 * (再読み込みなし。サーバー送信イベントで反映される)
 */
import { devices, expect, test } from '@playwright/test';
import { E2E } from './env';
import { apiAs, expectToast, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-6 iPad受付 → iPhone Staff → PC Owner にリアルタイム反映', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const cust = await api.post('/api/v1/customers', { name: 'E2E 同期顧客', email: `sync-${Date.now()}@example.invalid`, phone: '090-3333-4444' });
  const booking = await api.post('/api/v1/bookings', {
    locationId: refs.ikebukuro,
    serviceId: refs.personal60,
    staffId: refs.aki,
    startsAt: jstIso(todayJst(), '06:00'),
    customer: { customerId: cust.id },
    force: true,
    forceReason: 'E2E の前提データ',
    idempotencyKey: idem('b'),
  });
  await api.dispose();
  const ctxOpts = { baseURL: E2E.baseUrl, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };

  // PC: Owner が予約一覧(池袋・今日)を開いておく
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/bookings');
  await page.getByLabel('拠点').selectOption({ label: '池袋店' });
  const pcRow = page.getByRole('row', { name: /E2E 同期顧客/ });
  await expect(pcRow).toContainText('来店待ち');

  // iPhone: Staff(Aki)の今日の担当
  const phone = await browser.newContext({ ...devices['iPhone 13'], ...ctxOpts });
  const sp = await phone.newPage();
  await login(sp, E2E.sample.aki, E2E.sample.password);
  const staffItem = sp.getByRole('link', { name: /E2E 同期顧客/ });
  await expect(staffItem).toContainText('来店待ち');

  // iPad: 受付モードで来店
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'], ...ctxOpts });
  const rp = await ipad.newPage();
  await login(rp, E2E.sample.reception, E2E.sample.password);
  await rp.goto('/app/reception');
  const card = rp.getByRole('article', { name: /E2E 同期顧客/ });
  await card.getByRole('button', { name: '● 来店' }).click();
  await expect(card).toContainText('来店済み');

  // iPhone に反映(再読み込みなし)
  await expect(staffItem).toContainText('来店済み', { timeout: 15_000 });
  await expect(pcRow).toContainText('来店済み', { timeout: 15_000 });

  // Staff が完了・実施記録
  await staffItem.click();
  await sp.getByRole('button', { name: /完了・実施記録/ }).click();
  await sp.getByLabel('内部メモ(スタッフのみ)').fill('E2E: スマホから記録');
  await sp.getByRole('button', { name: '✓ 完了にする' }).click();
  await sp.getByRole('dialog').getByRole('button', { name: '完了にする' }).click();
  await expectToast(sp, '完了しました');

  // PC と iPad に反映
  await expect(pcRow).toContainText('完了', { timeout: 15_000 });
  await expect(card).toBeHidden({ timeout: 15_000 }); // 受付の「未完了」一覧から外れる
  await rp.getByRole('tab', { name: '終了' }).click();
  await expect(rp.getByRole('article', { name: /E2E 同期顧客/ })).toContainText('完了');
  expect(booking.id).toBeTruthy();
  await phone.close();
  await ipad.close();
});
