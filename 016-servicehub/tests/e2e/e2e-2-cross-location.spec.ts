/**
 * E2E-2: Aki が池袋で予約中 → 新宿の公開ページで同時間が候補から除外 → 管理者の手動予約も拒否
 * 顧客側は Android(Pixel 7 エミュレーション)、管理者は PC 相当の画面で確認する。
 */
import { devices, expect, test } from '@playwright/test';
import { E2E } from './env';
import { addDaysIso, apiAs, idem, isoWeekday, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-2 他拠点の予約で同時間を除外し、手動予約も拒否', async ({ page, browser }) => {
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  // Aki が新宿に勤務する日(火・木・土)
  let day = addDaysIso(todayJst(), 2);
  while (![2, 4, 6].includes(isoWeekday(day))) day = addDaysIso(day, 1);
  const cust = await api.post('/api/v1/customers', { name: 'E2E 池袋顧客', email: `cross-${Date.now()}@example.invalid`, phone: '090-4444-5555' });
  // 新宿勤務日の 15:00 に池袋で Aki の予約(シフト外のため理由付き強制)
  await api.post('/api/v1/bookings', {
    locationId: refs.ikebukuro,
    serviceId: refs.personal60,
    staffId: refs.aki,
    startsAt: jstIso(day, '15:00'),
    customer: { customerId: cust.id },
    force: true,
    forceReason: 'E2E: 池袋での特別対応',
    idempotencyKey: idem('b'),
  });

  // 顧客(Android): 新宿の公開ページで Aki を指名 → 15:00 台が出ない
  await page.goto(`/p/${E2E.sample.slug}/shinjuku`);
  await page.getByRole('button', { name: /60分パーソナル/ }).click();
  await page.getByRole('button', { name: /^Aki/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${day}`) }).click();
  const slots = page.getByRole('group', { name: '開始時刻' });
  await expect(slots.getByRole('button', { name: /^11:00/ })).toHaveCount(1);
  await expect(slots.getByRole('button', { name: /^15:00/ })).toHaveCount(0);
  await expect(slots.getByRole('button', { name: /^15:30/ })).toHaveCount(0);

  // 管理者: 新宿 15:00 に Aki を直接指定 → 強制でも不可の理由が表示され、確定できない
  const pc = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: E2E.baseUrl, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const op = await pc.newPage();
  await login(op, E2E.sample.owner, E2E.sample.password);
  await op.goto('/app/bookings');
  await op.getByRole('button', { name: '予約を作成' }).click();
  const dlg = op.getByRole('dialog');
  await dlg.getByLabel('顧客を検索').fill('E2E 池袋顧客');
  await dlg.getByRole('button', { name: /E2E 池袋顧客/ }).click();
  await dlg.getByLabel('拠点').selectOption({ label: '新宿店' });
  await dlg.getByLabel('サービス').selectOption({ label: '60分パーソナル(60分)' });
  await dlg.getByLabel('担当').selectOption({ label: 'Aki' });
  await dlg.getByLabel('日付').fill(day);
  await dlg.getByLabel(/時刻を直接指定する/).check();
  await dlg.getByLabel(/開始時刻/).fill('15:00');
  await expect(dlg.getByText('この時刻は予約できません(強制でも不可)')).toBeVisible();
  await expect(dlg.getByText(/スタッフはこの時間に他の予約があります/).first()).toBeVisible();
  await expect(dlg.getByRole('button', { name: /予約を確定|強制予約する/ })).toBeDisabled();

  // サーバー側でも拒否(画面を経由しない強制予約)
  const res = await op.request.post('/api/v1/bookings', {
    headers: { origin: E2E.baseUrl, 'x-csrf-token': await op.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken) },
    data: {
      locationId: refs.shinjuku,
      serviceId: refs.personal60,
      staffId: refs.aki,
      startsAt: jstIso(day, '15:00'),
      customer: { customerId: cust.id },
      force: true,
      forceReason: '強制でも不可の確認',
      idempotencyKey: idem('b'),
    },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe('SLOT_UNAVAILABLE');
  expect(body.error.details.violations.map((v: { code: string }) => v.code)).toContain('STAFF_BUSY');
  await api.dispose();
  await pc.close();
});
