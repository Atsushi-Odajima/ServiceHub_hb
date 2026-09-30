// 開発用: 画面のスクリーンショット確認(SHOTS='[{"name":"x","path":"/login","device":"iPhone 13"}]' node scripts/screenshot.mjs)
import { chromium, devices } from '@playwright/test';
const base = process.env.BASE || 'http://localhost:3100';
const out = process.env.OUT || '/tmp/claude-0/-home-user-hanbai16/5f34bf9a-e8bd-5fbe-bb83-a0a7a27b8698/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--disable-background-networking', '--disable-component-update'] });
const shots = JSON.parse(process.env.SHOTS || '[]');
const login = process.env.LOGIN ? JSON.parse(process.env.LOGIN) : null;
for (const s of shots) {
  const ctx = await browser.newContext(s.device ? { ...devices[s.device], defaultBrowserType: undefined } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  if (login) {
    await page.goto(base + '/login');
    await page.getByLabel('メールアドレス').fill(login.email);
    await page.locator('input[type=password]').fill(login.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/app/);
  }
  await page.goto(base + s.path);
  await page.waitForTimeout(s.wait ?? 800);
  await page.screenshot({ path: `${out}/${s.name}.png`, fullPage: s.full ?? false });
  console.log('shot', s.name);
  await ctx.close();
}
await browser.close();
