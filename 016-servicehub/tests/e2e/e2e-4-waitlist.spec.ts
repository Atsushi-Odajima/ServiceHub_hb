/**
 * E2E-4: キャンセル → 待機候補 → 通知 → 別の顧客が予約確定 → 待機顧客が古い空き表示から確定を試みて競合で拒否
 * サンプル組織の満席ヨガ(翌日19:00・新宿)と「待機 誠」の待機を使う。運営者は PC、待機顧客は iPhone。
 */
import { devices, expect, test } from '@playwright/test';
import { E2E } from './env';
import { addDaysIso, apiAs, expectToast, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

test('E2E-4 待機は自動確定せず、先着順で古い空き表示からの確定は競合', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const tomorrow = addDaysIso(todayJst(), 1);
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const yoga = ((await api.get('/api/v1/services')).items as { id: string; name: string }[]).find((s) => s.name === '6名ヨガ')!;

  // 運営者(PC): 満席ヨガの1件をキャンセル
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/bookings');
  await page.getByLabel('拠点').selectOption({ label: '新宿店' });
  await page.getByRole('row', { name: /ヨガ 一/ }).click();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセルする' }).click();
  await expectToast(page, /キャンセルしました/);

  // 待機リストに候補が出る(予約は自動で作られない)
  await page.goto('/app/waitlist'); // 複数拠点の担当者は全拠点の一覧が既定
  const card = page.locator('.card').filter({ hasText: '待機 誠' });
  await expect(card.getByText('待機中')).toBeVisible();
  const candidate = card.getByRole('listitem').filter({ hasText: /19:00/ });
  await expect(candidate).toContainText('未案内');
  const before = (await api.get(`/api/v1/bookings?customerId=${((await api.get('/api/v1/waitlist')).items as any[]).find((e) => e.customerName === '待機 誠').customerId}`)).items;
  expect(before).toHaveLength(0);
  await candidate.getByRole('button', { name: 'メールで案内' }).click();
  await expectToast(page, '案内メールを送信キューに登録しました');
  await expect(candidate).toContainText('案内済み');

  // 待機顧客(iPhone): 案内リンク(サービス・日付・時刻が入った状態)を開き、確認画面まで進む
  const phone = await browser.newContext({ ...devices['iPhone 13'], baseURL: E2E.baseUrl, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const cp = await phone.newPage();
  await cp.goto(`/p/${E2E.sample.slug}/shinjuku?${new URLSearchParams({ service: yoga.id, date: tomorrow, time: '19:00' })}`);
  await expect(cp.getByRole('heading', { name: '日時を選んでください' })).toBeVisible();
  await expect(cp.getByRole('group', { name: '開始時刻' }).getByRole('button', { name: /^19:00/ })).toHaveAttribute('aria-pressed', 'true');
  await cp.getByRole('button', { name: '次へ' }).click();
  await cp.getByLabel('お名前').fill('待機 誠');
  await cp.getByLabel('メールアドレス').fill('makoto@sample-wellness.example');
  await cp.getByLabel('電話番号').fill('090-0000-0007');
  await cp.getByRole('button', { name: '確認へ' }).click();
  await cp.getByLabel(/上記の内容/).check();
  await cp.waitForTimeout(3200);

  // その間に別の顧客が同じ枠を予約(先着)
  const other = await api.post('/api/v1/customers', { name: 'E2E 先着顧客', email: `first-${Date.now()}@example.invalid`, phone: '090-6666-7777' });
  await api.post('/api/v1/bookings', {
    locationId: refs.shinjuku,
    serviceId: yoga.id,
    staffId: refs.ken,
    startsAt: jstIso(tomorrow, '19:00'),
    customer: { customerId: other.id },
    idempotencyKey: idem('first'),
  });

  // 待機顧客の確定は競合で拒否され、日時選択に戻って最新の空きが表示される
  await cp.getByRole('button', { name: '予約する' }).click();
  await expect(cp.getByText('この日時はたった今埋まったか、予約できなくなりました')).toBeVisible();
  await expect(cp.getByRole('heading', { name: '日時を選んでください' })).toBeVisible();
  await expect(cp.getByRole('group', { name: '開始時刻' }).getByRole('button', { name: /^19:00/ })).toHaveCount(0);
  await phone.close();

  // 待機は「案内済み」のまま。埋まった候補は一覧から消える
  await page.reload();
  await expect(card.getByText('案内済み').first()).toBeVisible();
  await expect(card.getByRole('button', { name: 'メールで案内' })).toHaveCount(0);
  await api.dispose();
});
