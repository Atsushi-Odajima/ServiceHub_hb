/**
 * ServiceHub 名札・受付表(#010 の統合): サンプル組織の満席ヨガ(翌日19:00・6名)から
 * 名札と受付表を作り、同じ参加者番号が載ること・印刷時は A4 の印刷用ページだけになることを確認する。
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { addDaysIso, login, todayJst } from './helpers';

const MM_PX = 96 / 25.4;

test('名札・受付表: 回を選んで名札と受付表をプレビューし、印刷用の A4 ページを作れる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/name-badges');
  await expect(page.getByRole('heading', { name: 'ServiceHub 名札・受付表' })).toBeVisible();
  await page.getByLabel('拠点').selectOption({ label: '新宿店' });
  await page.getByLabel('日付').fill(addDaysIso(todayJst(), 1));
  const session = page.getByLabel('回(サービスと開始時刻)');
  await expect(session.locator('option', { hasText: '19:00' })).toHaveCount(1, { timeout: 15_000 });
  const value = await session.locator('option', { hasText: '19:00' }).getAttribute('value');
  await session.selectOption(value!);
  await expect(page.getByLabel('イベント名(名札の上部・受付表)')).toHaveValue('6名ヨガ');

  const preview = page.getByRole('region', { name: '印刷プレビュー' });
  await expect(preview.locator('.nb-badge')).toHaveCount(6);
  await expect(preview.locator('.nb-rs-data')).toHaveCount(6);
  await expect(page.getByTestId('nb-pages')).toContainText('名札 1ページ・受付表 1ページ');
  // 名札と受付表に同じ番号が同じ順で載る
  const badgeNos = await preview.locator('.nb-badge').evaluateAll((els) => els.map((e) => e.getAttribute('data-no')));
  const rowNos = await preview.locator('.nb-rs-data').evaluateAll((els) => els.map((e) => e.getAttribute('data-no')));
  // 番号は予約を受けた順。E2E の他のシナリオがこの回のキャンセル・再予約をすることがあるため、欠番は許容する
  expect(badgeNos.every((n) => /^P\d{3}$/.test(n ?? ''))).toBe(true);
  expect([...badgeNos].sort()).toEqual(badgeNos);
  expect(new Set(badgeNos).size).toBe(6);
  expect(rowNos).toEqual(badgeNos);

  // 1人を印刷対象から外すと両方から外れる(番号は振り直さない)
  const second = badgeNos[1]!;
  await page.getByRole('checkbox', { name: new RegExp(second) }).uncheck();
  await expect(preview.locator('.nb-badge')).toHaveCount(5);
  await expect(preview.locator(`.nb-rs-data[data-no="${second}"]`)).toHaveCount(0);
  await expect(preview.locator('.nb-rs-data').last()).toHaveAttribute('data-no', badgeNos[5]!);
  await expect(page.getByRole('button', { name: '印刷 / PDF保存' })).toBeEnabled();

  // 印刷: 画面の部品は消え、A4 の印刷用ページだけになる。名札は 91mm × 55mm
  await page.emulateMedia({ media: 'print' });
  const printRoot = page.locator('.nb-print-root');
  await expect(printRoot).toBeVisible();
  await expect(page.locator('.sidebar, .bottom-nav').first()).toBeHidden();
  const box = await printRoot.locator('.nb-badge').first().boundingBox();
  expect(Math.abs(box!.width - 91 * MM_PX)).toBeLessThan(1.5);
  expect(Math.abs(box!.height - 55 * MM_PX)).toBeLessThan(1.5);
  const sheet = await printRoot.locator('.nb-sheet').first().boundingBox();
  expect(Math.abs(sheet!.width - 210 * MM_PX)).toBeLessThan(1.5);
  await expect(printRoot.locator('.nb-sheet')).toHaveCount(2);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? [];
  expect(pages.length).toBe(2);
  // 目視確認用(任意): NB_PDF_OUT=/path/to.pdf で保存
  if (process.env.NB_PDF_OUT) writeFileSync(process.env.NB_PDF_OUT, pdf);
  await page.emulateMedia({ media: 'screen' });
  expect(errors).toEqual([]);
});
