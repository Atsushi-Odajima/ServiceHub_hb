/**
 * アクセシビリティ(WCAG 2.1 A/AA を axe-core で自動点検)。PC / iPhone / Android / iPad の各端末で実行する。
 * 自動点検で分かる範囲(ラベル・名前・コントラスト・見出し・ランドマーク・ARIA の誤用など)を対象とし、
 * 重大(critical / serious)な違反が0件であることを確認する。キーボード操作は別のテストで確認する。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './env';
import { login } from './helpers';

const APP_PAGES = [
  '/app',
  '/app/schedule',
  '/app/bookings',
  '/app/customers',
  '/app/passes',
  '/app/plans',
  '/app/shifts',
  '/app/waitlist',
  '/app/announcement',
  '/app/name-badges',
  '/app/kpi',
  '/app/search?q=%E5%B8%B8%E9%80%A3',
  '/app/csv',
  '/app/audit',
  '/app/notifications',
  '/app/settings',
  '/app/settings/locations',
  '/app/settings/services',
  '/app/settings/staff',
  '/app/settings/members',
  '/app/settings/backup',
];

interface Finding {
  page: string;
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: number;
  targets: string[];
}

async function scan(page: Page, path: string, out: Finding[]): Promise<void> {
  await page.goto(path);
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('.spinner')).toHaveCount(0, { timeout: 15_000 });
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  // 点検が実際に行われたこと(空のページを点検していない)
  expect(r.passes.length, `${path}: 点検されたルールが少なすぎる`).toBeGreaterThan(8);
  for (const v of r.violations) {
    out.push({ page: path, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) });
  }
}

test('アクセシビリティ: 主要画面・公開予約・受付モードに重大な違反がない(axe / WCAG 2.1 AA)', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const findings: Finding[] = [];
  // 公開ページ(ログイン不要)
  for (const path of ['/login', `/p/${E2E.sample.slug}`, `/p/${E2E.sample.slug}/ikebukuro`, `/p/${E2E.sample.slug}/ikebukuro/waitlist`]) await scan(page, path, findings);
  // 管理画面(Owner)
  await login(page, E2E.sample.owner, E2E.sample.password);
  for (const path of APP_PAGES) await scan(page, path, findings);
  // 受付モード(受付担当)
  const ctx = await browser.newContext({ ...testInfo.project.use });
  const rp = await ctx.newPage();
  await login(rp, E2E.sample.reception, E2E.sample.password);
  await scan(rp, '/app/reception', findings);
  await ctx.close();

  await testInfo.attach('axe-findings.json', { body: JSON.stringify(findings, null, 2), contentType: 'application/json' });
  for (const f of findings) console.log(`[axe ${testInfo.project.name}] ${f.impact} ${f.id} ${f.page} (${f.nodes}) ${f.targets.join(' | ')}`);
  console.log(`[axe ${testInfo.project.name}] 点検した画面 ${APP_PAGES.length + 5} / 指摘 ${findings.length} 件`);
  const serious = findings.filter((f) => f.impact === 'critical' || f.impact === 'serious');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('キーボードだけで操作できる: ログイン・スキップリンク・ダイアログ(フォーカスの閉じ込めと戻り)・フォーカス表示', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'キーボード操作は PC で確認する');
  const focused = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { tag: el?.tagName ?? '', type: (el as HTMLInputElement | null)?.type ?? '', text: el?.textContent?.trim() ?? '', inDialog: Boolean(el?.closest('[role="dialog"]')) };
  });
  const tabUntil = async (pred: (f: Awaited<ReturnType<typeof focused>>) => boolean, max = 15) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (pred(await focused())) return;
    }
    throw new Error('目的の要素にキーボードで移動できません');
  };
  // ログイン(マウスを使わない)
  await page.goto('/login');
  await tabUntil((f) => f.tag === 'INPUT' && f.type === 'email');
  await page.keyboard.type(E2E.sample.owner);
  await tabUntil((f) => f.tag === 'INPUT' && f.type === 'password');
  await page.keyboard.type(E2E.sample.password);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/app(\/|$)/);
  // 最初の Tab で「本文へ移動」
  await page.goto('/app/customers');
  await expect(page.getByRole('heading', { name: '顧客' })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.locator('.skip-link');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  // ダイアログ: Enter で開く → フォーカスは中に閉じ込められる → Esc で閉じて元のボタンへ戻る
  const opener = page.getByRole('button', { name: '顧客を登録' });
  await opener.focus();
  const outline = await opener.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '顧客を登録' });
  await expect(dialog).toBeVisible();
  expect((await focused()).inDialog).toBe(true);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect((await focused()).inDialog, `Tab ${i + 1} 回目でダイアログの外へ出た`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect((await focused()).inDialog).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // キーボードで移動したときはフォーカスの枠が見える
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const visible = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(visible.style).not.toBe('none');
  expect(visible.width).toBeGreaterThanOrEqual(2);
  expect(outline.style).toBeDefined();
});

test('入力エラーは項目に関連付けられ、読み上げられる(aria-invalid / aria-describedby / role=alert)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop' && testInfo.project.name !== 'iphone', 'PC とスマホで確認する');
  await login(page, E2E.sample.owner, E2E.sample.password);
  await page.goto('/app/customers');
  await page.getByRole('button', { name: '顧客を登録' }).click();
  const dialog = page.getByRole('dialog', { name: '顧客を登録' });
  await dialog.getByLabel('氏名').fill('アクセシビリティ 確認');
  await dialog.getByLabel('メール').fill('not-an-email');
  await dialog.getByRole('button', { name: '保存する' }).click();
  const email = dialog.getByLabel('メール');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await email.getAttribute('aria-describedby')) ?? '';
  expect(describedBy).not.toBe('');
  const messages = await Promise.all(describedBy.split(/\s+/).map((id) => page.locator(`[id="${id}"]`).innerText()));
  expect(messages.join(' ')).toMatch(/メール/);
  await expect(dialog.locator('[role="alert"]').first()).toBeVisible();
});

test('スマホ・タブレットではボタン・タブ・下部メニューの押せる大きさが44px以上', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'タッチ端末で確認する');
  await login(page, E2E.sample.owner, E2E.sample.password);
  const small: string[] = [];
  for (const path of ['/app', '/app/bookings', '/app/customers', '/app/passes', '/app/settings']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('.spinner')).toHaveCount(0, { timeout: 15_000 });
    const found = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a.btn, .bottom-nav a, [role="tab"], select, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        if (r.height < 44 - 0.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 12)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    for (const f of found) small.push(`${path}: ${f}`);
  }
  expect(small).toEqual([]);
});

test('状態は色だけでなく文字(とアイコン)でも示される', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ipad' && testInfo.project.name !== 'desktop', '受付モードは iPad・PC で確認する');
  await login(page, E2E.sample.reception, E2E.sample.password);
  await page.goto('/app/reception');
  await expect(page.locator('h1').first()).toBeVisible();
  const badges = page.locator('.badge');
  const n = await badges.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const text = (await badges.nth(i).innerText()).trim();
    expect(text.length, `状態表示 ${i + 1} に文字がない`).toBeGreaterThan(0);
  }
  // 受付モードの状態・時刻は離れても読める大きさ(16px 以上)
  const minFont = await page.evaluate(() =>
    Math.min(...Array.from(document.querySelectorAll<HTMLElement>('.rcard .badge, .rcard time, .rcard .rtime')).map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((x) => x > 0)),
  );
  expect(minFont).toBeGreaterThanOrEqual(16);
});
