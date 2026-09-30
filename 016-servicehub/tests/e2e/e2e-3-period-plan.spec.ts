/**
 * E2E-3: 顧客が月4回プラン → 3回利用 → 4回目予約/実施 → 残0 → 5回目は利用枠候補なし
 * スマホ(iPhone エミュレーション)で完了・消化を行う。前提の予約と3回分の利用は API で準備する。
 */
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { apiAs, expectToast, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-3 月4回プラン: 4回目で残0、5回目は候補なし', async ({ page }) => {
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const today = todayJst();
  const product = ((await api.get('/api/v1/plan-products')).items as { id: string; name: string }[]).find((p) => p.name === '月4回')!;
  const cust = await api.post('/api/v1/customers', { name: 'E2E プラン顧客', email: `plan-${Date.now()}@example.invalid`, phone: '090-2222-3333' });
  const plan = await api.post(`/api/v1/customers/${cust.id}/plans`, { planProductId: product.id, startsOn: `${today.slice(0, 8)}01`, idempotencyKey: idem('plan') });
  // 当日の予約(営業時間外・過去の時刻は理由付きの強制予約で作成)
  const book = (time: string) =>
    api.post('/api/v1/bookings', {
      locationId: refs.ikebukuro,
      serviceId: refs.personal60,
      staffId: refs.mika,
      startsAt: jstIso(today, time),
      customer: { customerId: cust.id },
      force: true,
      forceReason: 'E2E の前提データ',
      idempotencyKey: idem('b'),
    });
  for (const time of ['01:00', '02:00', '03:00']) {
    const b = await book(time);
    await api.post(`/api/v1/bookings/${b.id}/complete`, { consume: { kind: 'plan', entitlementId: plan.id, idempotencyKey: idem('use') } });
  }
  const b4 = await book('04:00');
  const b5 = await book('05:00');
  await api.dispose();

  await login(page, E2E.sample.owner, E2E.sample.password);
  // 4回目: 残1 → 消化して残0
  await page.goto(`/app/bookings/${b4.id}/complete`);
  await expect(page.getByText('残り 1回 → 消化後 0回')).toBeVisible();
  await page.getByRole('radio', { name: /月4回/ }).check();
  await page.getByRole('button', { name: '✓ 完了して1回消化' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '完了して1回消化' }).click();
  await expectToast(page, '完了しました(残り 0回)');
  await expect(page.getByText('消化済み')).toBeVisible();

  // 5回目: 利用枠の候補が出ない(完了だけはできる)
  await page.goto(`/app/bookings/${b5.id}/complete`);
  await expect(page.getByText('この予約に使える回数券・利用プランはありません。')).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '✓ 完了にする' })).toBeEnabled();

  // プラン詳細: 当期の残り 0 / 4、台帳と一致
  await page.goto(`/app/plans/${plan.id}`);
  await expect(page.locator('.stat-value').first()).toHaveText(/^0/);
  await expect(page.getByText('✓ 一致').first()).toBeVisible();
});
