/**
 * E2E-1: Owner → 2拠点/スタッフ/サービス/リソース設定 → 公開予約(顧客は iPhone)→ 受付 → 対応中 → 完了
 *        → 8回券から1回消化 → 次回予約
 * PC(desktop プロジェクト)で実行し、顧客の予約だけ iPhone エミュレーションのブラウザで行う。
 */
import { devices, expect, test } from '@playwright/test';
import { E2E } from './env';
import { addDaysIso, expectToast, login, todayJst } from './helpers';

test.describe('E2E-1 Owner設定から次回予約まで', () => {
  test('設定 → 公開予約 → 受付 → 完了・8回券消化 → 次回予約', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await login(page, E2E.ownerEmail, E2E.password);

    // ---- 拠点(2つ) ----
    for (const [name, slug] of [
      ['池袋店', 'ikebukuro'],
      ['新宿店', 'shinjuku'],
    ]) {
      await page.goto('/app/settings/locations');
      await page.getByRole('button', { name: '拠点を追加' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('拠点名').fill(name);
      await dlg.getByLabel('URL名(スラッグ)').fill(slug);
      await dlg.getByRole('button', { name: '追加する' }).click();
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    }

    // ---- リソース ----
    await page.goto('/app/settings/resources');
    for (const [loc, name] of [
      ['池袋店', 'Room A'],
      ['新宿店', 'Room B'],
    ]) {
      await page.getByRole('button', { name: 'リソースを追加' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('拠点').selectOption({ label: loc });
      await dlg.getByLabel('名称').fill(name);
      await dlg.getByRole('button', { name: '保存する' }).click();
      await expect(dlg).toBeHidden();
    }

    // ---- スタッフ(両拠点に所属) ----
    await page.goto('/app/settings/staff');
    await page.getByRole('button', { name: 'スタッフを追加' }).click();
    {
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('表示名(お客様に表示)').fill('Aki');
      const locs = dlg.getByRole('group', { name: '所属拠点(複数可)' });
      await locs.getByLabel('池袋店').check();
      await locs.getByLabel('新宿店').check();
      await dlg.getByRole('button', { name: '保存する' }).click();
      await expect(dlg).toBeHidden();
    }

    // ---- サービス(両拠点・Aki・個室が必要) ----
    await page.goto('/app/settings/services');
    await page.getByRole('button', { name: 'サービスを追加' }).click();
    await page.getByLabel('名称').fill('60分パーソナル');
    await page.getByLabel('所要時間(分)').fill('60');
    await page.getByRole('tab', { name: '拠点・スタッフ・リソース' }).click();
    const svcLocs = page.getByRole('group', { name: '提供する拠点' });
    await svcLocs.getByLabel('池袋店').check();
    await svcLocs.getByLabel('新宿店').check();
    await page.getByRole('group', { name: '担当できるスタッフ' }).getByLabel('Aki').check();
    await page.getByRole('button', { name: '+ 必要なリソースを追加' }).click();
    const req = page.getByRole('group', { name: '必要条件 1' });
    await req.getByLabel('名称').fill('個室');
    await req.getByRole('group', { name: '候補リソース' }).getByLabel(/Room A/).check();
    await req.getByRole('group', { name: '候補リソース' }).getByLabel(/Room B/).check();
    await page.getByRole('button', { name: '保存する' }).click();
    await expectToast(page, '保存しました');

    // ---- シフト: 週テンプレート(毎日 池袋 10:00-19:00)→ 生成 ----
    await page.goto('/app/shifts');
    await page.getByRole('button', { name: '週テンプレート' }).click();
    {
      const dlg = page.getByRole('dialog');
      for (let wd = 1; wd <= 7; wd++) {
        await dlg.getByRole('button', { name: '+ 行を追加' }).click();
        await dlg.getByLabel('曜日').nth(wd - 1).selectOption(String(wd));
        await dlg.getByLabel('拠点').nth(wd - 1).selectOption({ label: '池袋店' });
      }
      await dlg.getByRole('button', { name: '保存する' }).click();
      await expect(dlg).toBeHidden();
    }
    await page.getByRole('button', { name: 'テンプレートから生成' }).click();
    {
      const dlg = page.getByRole('dialog');
      await dlg.getByRole('button', { name: '生成する' }).click();
      await expect(dlg.getByText(/作成 \d+件/)).toBeVisible();
      await dlg.getByRole('button', { name: '閉じる' }).click();
    }

    // ---- 回数券の種類(8回券) ----
    await page.goto('/app/settings/pass-products');
    await page.getByRole('button', { name: '追加' }).click();
    {
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('名前').fill('8回券');
      await dlg.getByRole('spinbutton', { name: '回数', exact: true }).fill('8');
      await dlg.getByRole('group', { name: '使えるサービス' }).getByLabel('60分パーソナル').check();
      await dlg.getByRole('button', { name: '保存', exact: true }).click();
      await expect(dlg).toBeHidden();
    }
    await expect(page.getByRole('cell', { name: '8回券' })).toBeVisible();

    // ---- 顧客が iPhone で公開予約(明日 10:00・Aki) ----
    const tomorrow = addDaysIso(todayJst(), 1);
    const phone = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const cp = await phone.newPage();
    await cp.goto(`${E2E.baseUrl}/p/${E2E.orgSlug}`);
    await cp.getByRole('link', { name: /池袋店/ }).click();
    await cp.getByRole('button', { name: /60分パーソナル/ }).click();
    const staffStep = cp.getByRole('heading', { name: '担当者を選んでください' });
    if (await staffStep.isVisible().catch(() => false)) await cp.getByRole('button', { name: /^Aki/ }).click();
    await expect(cp.getByRole('heading', { name: '日時を選んでください' })).toBeVisible();
    await cp.getByRole('button', { name: new RegExp(`^${tomorrow}`) }).click();
    await cp.getByRole('group', { name: '開始時刻' }).getByRole('button', { name: /^10:00/ }).click();
    await cp.getByRole('button', { name: '次へ' }).click();
    await cp.getByLabel('お名前').fill('E2E 顧客');
    await cp.getByLabel('メールアドレス').fill('e2e-customer@example.invalid');
    await cp.getByLabel('電話番号').fill('090-1234-5678');
    await cp.getByRole('button', { name: '確認へ' }).click();
    await cp.getByLabel(/上記の内容/).check();
    await cp.waitForTimeout(3200); // bot 対策(入力開始からの最短時間)
    await cp.getByRole('button', { name: '予約する' }).click();
    await expect(cp.getByRole('heading', { name: /ご予約が確定しました/ })).toBeVisible();
    const code = ((await cp.locator('dd.mono').first().textContent()) ?? '').trim();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await phone.close();

    // ---- 顧客台帳で 8回券 を付与 ----
    await page.goto('/app/customers');
    await page.getByLabel('検索', { exact: true }).fill('E2E 顧客');
    await page.getByRole('link', { name: 'E2E 顧客' }).click();
    await page.getByRole('tab', { name: '回数券・プラン' }).click();
    await page.getByRole('button', { name: '回数券を付与' }).click();
    {
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('回数券の種類').selectOption({ label: '8回券(8回・180日間)' });
      await dlg.getByRole('button', { name: '付与する' }).click();
      await expect(dlg).toBeHidden();
    }
    await expect(page.getByText('残8')).toBeVisible();

    // ---- 受付 → 対応中 → 完了(8回券から1回消化) ----
    await page.goto('/app/bookings');
    await page.getByLabel('拠点').selectOption({ label: '池袋店' });
    await page.getByRole('row', { name: new RegExp(code) }).click();
    await expect(page.getByRole('heading', { name: 'E2E 顧客 様' })).toBeVisible();
    await page.getByRole('button', { name: /来店済みにする/ }).click();
    await expect(page.locator('.page-header').getByText('来店済み')).toBeVisible();
    await page.getByRole('button', { name: /対応開始/ }).click();
    await expect(page.locator('.page-header').getByText('対応中')).toBeVisible();
    await page.getByRole('button', { name: /完了・実施記録/ }).click();
    await expect(page.getByRole('heading', { name: '完了・実施記録' })).toBeVisible();
    // 消化は選ぶまで行われない(完了ボタンは選択待ち)
    await expect(page.getByRole('button', { name: '✓ 完了にする' })).toBeDisabled();
    await page.getByLabel('内部メモ(スタッフのみ)').fill('初回。フォーム確認');
    await page.getByRole('radio', { name: /8回券/ }).check();
    await page.getByRole('button', { name: '✓ 完了して1回消化' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText('8回券から1回消化します(残り 8 → 7)')).toBeVisible();
    await confirm.getByRole('button', { name: '完了して1回消化' }).click();
    await expectToast(page, '完了しました(残り 7回)');
    await expect(page.getByText('消化済み')).toBeVisible();
    await expect(page.getByText(/消化後の残り 7回/)).toBeVisible();

    // ---- 次回予約(同じ顧客・サービス・担当が初期値) ----
    await page.getByRole('link', { name: '次回予約を取る' }).click();
    const modal = page.getByRole('dialog', { name: '次回予約を作成' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('E2E 顧客')).toBeVisible();
    await modal.locator('.slot-btn').first().click();
    await modal.getByRole('button', { name: '予約を確定' }).click();
    await expectToast(page, '次回予約を作成しました');
    await expect(page.getByRole('heading', { name: 'E2E 顧客 様' })).toBeVisible();
    const nextUrl = page.url();

    // 元の予約の実施記録に次回予約が紐付く
    await page.goto('/app/bookings');
    await page.getByRole('row', { name: new RegExp(code) }).click();
    await page.getByRole('link', { name: '実施記録を見る' }).click();
    const nextLink = page.getByRole('link', { name: '予約あり' });
    await expect(nextLink).toBeVisible();
    expect(new URL(nextUrl).pathname).toBe(await nextLink.getAttribute('href'));

    // 回数券の台帳: 付与 +8 → 利用 −1(残7)、台帳と一致
    await page.goto('/app/passes');
    await page.getByRole('link', { name: 'E2E 顧客' }).click();
    await expect(page.getByText('台帳の合計と一致 ✓')).toBeVisible();
    await expect(page.locator('.stat-value').first()).toContainText('7');
  });
});
