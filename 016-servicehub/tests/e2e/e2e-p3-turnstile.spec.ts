/**
 * 公開予約の bot 対策(Cloudflare Turnstile。任意の設定)— iPhone で実行
 * Turnstile のサイトキー/シークレットキーを設定したサーバーを別に起動し、
 * - 確認が済むまで「予約する」を押せない
 * - 確認後に予約でき、サーバーは受け取ったトークンを検証している
 * ことを確かめる。Cloudflare のスクリプトと検証サーバーはテスト用のものに差し替える
 * (この環境から Cloudflare には接続できないため。実際のキーでの確認は RELEASE_CHECKLIST.md 4.2)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { addDaysIso, todayJst } from './helpers';

const PORT_C = E2E.port + 2;
const BASE_C = `http://localhost:${PORT_C}`;
let server: ChildProcess | null = null;
let verify: Server | null = null;
let log = '';

test.afterAll(async () => {
  server?.kill('SIGTERM');
  verify?.close();
  await new Promise((r) => setTimeout(r, 300));
});

// Turnstile の代わり: 「確認(テスト用)」を押すとトークンを渡す
const FAKE_TURNSTILE = `window.turnstile = {
  render: function (el, o) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '確認(テスト用)';
    b.onclick = function () { b.textContent = '確認済み(テスト用)'; o.callback('e2e-turnstile-ok'); };
    el.appendChild(b);
    return 'w1';
  },
  reset: function () {},
  remove: function () {}
};`;

async function waitForHealth(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not start\n${log.slice(-3000)}`);
}

test('Turnstile を設定すると、公開予約は確認が済むまで送信できず、確認後に予約できる', async ({ page }) => {
  test.setTimeout(120_000);
  const tokens: string[] = [];
  verify = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      tokens.push(p.get('response') ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: p.get('secret') === 'e2e-secret' && p.get('response') === 'e2e-turnstile-ok' }));
    });
  });
  await new Promise<void>((r) => verify!.listen(0, '127.0.0.1', () => r()));
  const vport = (verify.address() as AddressInfo).port;
  server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: E2E.databaseUrl,
      DATABASE_SSL: 'disable',
      SESSION_SECRET: E2E.sessionSecret,
      APP_BASE_URL: BASE_C,
      PORT: String(PORT_C),
      EMAIL_PROVIDER: 'log',
      RUN_WORKER: 'false',
      MIGRATE_ON_START: 'false',
      LOG_LEVEL: 'warn',
      PUBLIC_RATE_LIMIT_PER_MIN: '1000',
      TURNSTILE_SITE_KEY: 'e2e-site-key',
      TURNSTILE_SECRET_KEY: 'e2e-secret',
      TURNSTILE_VERIFY_URL: `http://127.0.0.1:${vport}/siteverify`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (log += d));
  server.stderr?.on('data', (d) => (log += d));
  await waitForHealth(`${BASE_C}/healthz`);
  await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TURNSTILE }));

  const tomorrow = addDaysIso(todayJst(), 1);
  await page.goto(`${BASE_C}/p/${E2E.sample.slug}/ikebukuro`);
  await page.getByRole('button', { name: /30分体験/ }).click();
  const staffStep = page.getByRole('heading', { name: '担当者を選んでください' });
  if (await staffStep.isVisible().catch(() => false)) await page.getByRole('button', { name: /おまかせ/ }).click();
  await expect(page.getByRole('heading', { name: '日時を選んでください' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${tomorrow}`) }).click();
  await page.getByRole('group', { name: '開始時刻' }).getByRole('button').first().click();
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByLabel('お名前').fill('確認 テスト');
  await page.getByLabel('メールアドレス').fill(`turnstile-${Date.now()}@example.invalid`);
  await page.getByLabel('電話番号').fill('090-5656-7878');
  await page.getByRole('button', { name: '確認へ' }).click();
  await page.getByLabel(/上記の内容/).check();

  // 確認が済むまで「予約する」は押せない
  const submit = page.getByRole('button', { name: '予約する' });
  await expect(page.getByRole('button', { name: '確認(テスト用)' })).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.getByRole('button', { name: '確認(テスト用)' }).click();
  await expect(submit).toBeEnabled();
  await page.waitForTimeout(3200); // bot 対策(表示からの最短時間)
  await submit.click();
  await expect(page.getByRole('heading', { name: /ご予約が確定しました/ })).toBeVisible();
  // サーバーは受け取ったトークンを検証した
  expect(tokens).toEqual(['e2e-turnstile-ok']);
});
