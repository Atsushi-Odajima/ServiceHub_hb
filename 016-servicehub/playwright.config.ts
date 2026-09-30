import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E(PC / iPhone / Android / iPad)。
 * この環境では Chromium のみのため、iPhone/iPad は Chromium での端末エミュレーション(画面サイズ・タッチ・UA)。
 * 実機の Safari/WebKit での確認は RELEASE_CHECKLIST.md の「人が行う確認」に含める。
 * サーバーとDB(servicehub_e2e)は tests/e2e/global-setup.ts が作り直して起動する。
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  outputDir: 'test-results/e2e-artifacts',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  // e2e-0(主要画面)は全端末。複数端末を1本で扱うシナリオは担当端末のプロジェクトでだけ実行する
  projects: [
    { name: 'desktop', testIgnore: /e2e-(2|3|5a|5b)-/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'iphone', testIgnore: /e2e-(1|2|4|5a|6|7)-/, use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'android', testIgnore: /e2e-(1|3|4|5a|5b|6|7)-/, use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'ipad', testIgnore: /e2e-(1|2|3|4|5b|6|7)-/, use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
  ],
});
