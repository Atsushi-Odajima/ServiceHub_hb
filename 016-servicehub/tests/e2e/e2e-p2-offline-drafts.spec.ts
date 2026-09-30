/**
 * オフライン入力は下書き(PC・iPhone で実行)
 * - 実施記録の入力は端末に下書きとして保存され、通信が切れても失われない。オフライン中は「未送信」と表示し送信できない
 * - 再接続すると最新の状態を読み直し、その後に送信できる。送信できたら下書きは消える
 * - 下書きを送る前に別の端末で完了された場合は、送れなかった内容を表示する(自動では送らない)
 * - 顧客メモの書きかけも下書きとして残る。ログアウト時は下書きの件数を確認してから消す(共有端末)
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './env';
import { apiAs, expectToast, idem, jstIso, login, sampleRefs, todayJst } from './helpers';

// 当日の池袋・Aki・個室(Room A)を使う。他の E2E(E2E-3 は 01:00〜06:00、E2E-6 は 06:00、E2E-5 は 07:00・08:00)と重ならない時刻: 00:00 / 09:00 / 20:00 / 21:00
async function arrivedBooking(name: string, time: string) {
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const refs = await sampleRefs(api);
  const cust = await api.post('/api/v1/customers', { name, email: `draft-${Date.now()}-${time.replace(':', '')}@example.invalid` });
  const b = await api.post('/api/v1/bookings', {
    locationId: refs.ikebukuro,
    serviceId: refs.personal60,
    staffId: refs.aki,
    startsAt: jstIso(todayJst(), time),
    customer: { customerId: cust.id },
    force: true,
    forceReason: 'E2E の前提データ',
    idempotencyKey: idem('b'),
  });
  const arrived = await api.post(`/api/v1/bookings/${b.id}/status`, { to: 'arrived', expectedVersion: b.version });
  return { api, booking: b as { id: string }, customerId: cust.id as string, version: (arrived.version ?? b.version + 1) as number };
}

const draftKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sh.draft.')));

test('オフラインの入力は下書きとして端末に残り、再接続後に最新の状態で送信する', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const { api, booking } = await arrivedBooking(`E2E 下書き顧客 ${testInfo.project.name}`, testInfo.project.name === 'desktop' ? '00:00' : '09:00');
  await api.dispose();
  await login(page, E2E.sample.aki, E2E.sample.password);
  await page.goto(`/app/bookings/${booking.id}/complete`);
  const memo = page.getByLabel('内部メモ(スタッフのみ)');
  await expect(memo).toBeVisible();

  // 入力 → 通信が切れる: 「未送信の下書き」と表示され、完了にできない
  await memo.fill('オフライン中に書いた記録');
  await expect(page.getByText(/下書きを端末に保存しました\(未送信/)).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/入力した内容はこの端末に下書きとして保存/)).toBeVisible();
  await expect(page.getByRole('button', { name: /完了にする/ })).toBeDisabled();
  await page.getByLabel('お客様向けメモ').fill('ご自宅でのストレッチ');

  // 再接続: 最新の状態を読み直し、入力は残ったまま送信できる
  const refetched = page.waitForResponse((r) => r.url().includes(`/api/v1/bookings/${booking.id}/completion`) && r.request().method() === 'GET');
  await context.setOffline(false);
  await refetched;
  await expect(page.getByText(/入力した内容はこの端末に下書きとして保存/)).toHaveCount(0);
  await expect(memo).toHaveValue('オフライン中に書いた記録');

  // 画面を開き直しても下書きが復元される(未送信である旨を表示)
  await page.reload();
  await expect(page.getByText(/未送信の下書き/)).toBeVisible();
  await expect(page.getByLabel('内部メモ(スタッフのみ)')).toHaveValue('オフライン中に書いた記録');
  await expect(page.getByLabel('お客様向けメモ')).toHaveValue('ご自宅でのストレッチ');
  expect(await draftKeys(page)).toHaveLength(1);

  // 送信できたら下書きは消え、記録はサーバーに保存されている
  await page.getByRole('button', { name: '✓ 完了にする' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '完了にする' }).click();
  await expectToast(page, '完了しました');
  await expect(page.getByText('オフライン中に書いた記録')).toBeVisible();
  expect(await draftKeys(page)).toHaveLength(0);
  await expect(page.getByText(/送信されていない下書き/)).toHaveCount(0);
});

test('送る前に別の端末で完了された場合は下書きを送らず、送れなかった内容を表示する', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const { api, booking, version } = await arrivedBooking(`E2E 下書き競合 ${testInfo.project.name}`, testInfo.project.name === 'desktop' ? '20:00' : '21:00');
  await login(page, E2E.sample.aki, E2E.sample.password);
  await page.goto(`/app/bookings/${booking.id}/complete`);
  await page.getByLabel('内部メモ(スタッフのみ)').fill('送れなかった記録');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: /完了にする/ })).toBeDisabled();
  // その間に別の端末(オーナー)が完了にする
  await api.post(`/api/v1/bookings/${booking.id}/complete`, { expectedVersion: version });
  await api.dispose();
  await context.setOffline(false);
  // 最新の状態(完了済み)を読み直し、送れなかった下書きを表示する。自動では送らない
  await expect(page.getByText(/送信されていない下書き/)).toBeVisible();
  await expect(page.getByText('送れなかった記録')).toBeVisible();
  await expect(page.getByRole('button', { name: /完了にする/ })).toHaveCount(0);
  await page.getByRole('button', { name: '下書きを破棄' }).click();
  await expect(page.getByText(/送信されていない下書き/)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
});

test('顧客メモの書きかけは下書きとして残り、ログアウト時は件数を確認してから消す', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = await apiAs(E2E.sample.owner, E2E.sample.password);
  const customerId = (await api.post('/api/v1/customers', { name: `E2E 下書きメモ ${testInfo.project.name}` })).id as string;
  await api.dispose();
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto(`/app/customers/${customerId}`);
  await page.getByRole('tab', { name: '対応メモ' }).click();
  await page.getByLabel('内容').fill('次回はストレッチ多め');
  await expect(page.getByText(/下書きを端末に保存しました\(未送信/)).toBeVisible();
  // 別の画面へ移って戻っても残っている
  await page.goto('/app/customers');
  await page.goto(`/app/customers/${customerId}`);
  await page.getByRole('tab', { name: '対応メモ' }).click();
  await expect(page.getByLabel('内容')).toHaveValue('次回はストレッチ多め');
  await expect(page.getByText(/未送信の下書き/)).toBeVisible();

  // ログアウト: 確認でやめると残る → 確認して進むと消える
  await page.goto('/app');
  const messages: string[] = [];
  page.once('dialog', (d) => {
    messages.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toMatch(/未送信の下書きが 1 件/);
  await expect(page).toHaveURL(/\/app/);
  expect(await draftKeys(page)).toHaveLength(1);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await page.waitForURL(/\/login/);
  expect(await draftKeys(page)).toHaveLength(0);
});
