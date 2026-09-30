// PWA アイコン(PNG)を SVG から生成する。Chromium(Playwright)でレンダリング。
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const targets = [
  ['icon.svg', 'pwa-192x192.png', 192],
  ['icon.svg', 'pwa-512x512.png', 512],
  ['icon-maskable.svg', 'maskable-512x512.png', 512],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180],
  ['icon.svg', 'favicon-32.png', 32],
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const [src, out, size] of targets) {
  const svg = readFileSync(path.join(root, 'public', src), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(root, 'public', out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('generated', out);
}
await browser.close();
