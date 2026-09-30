// 第三者ソフトウェアのライセンス表示 manual/THIRD_PARTY_NOTICES.txt を生成する(pnpm notices)。
// 対象は「実際に配布・実行されるもの」:
//   - サーバー: 本番の依存パッケージ(dependencies とその依存。pnpm licenses list --prod)
//   - 画面: ブラウザ用の JavaScript に同梱されるライブラリ(Vite でビルドし、取り込まれたモジュールから特定)
//   - Service Worker: Workbox の実行時モジュール(生成された sw の目印 "workbox:<名前>:" から特定)
// 開発・テスト専用のツール(devDependencies のうち同梱されないもの)は一覧だけを載せる。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'manual', 'THIRD_PARTY_NOTICES.txt');
const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** name@version → { name, version, license, homepage, dir, usedIn:Set } */
const packages = new Map();
function add(name, version, dir, usedIn, license, homepage) {
  const key = `${name}@${version}`;
  const cur = packages.get(key) ?? { name, version, dir, license, homepage, usedIn: new Set() };
  cur.usedIn.add(usedIn);
  cur.license ??= license;
  cur.homepage ??= homepage;
  packages.set(key, cur);
}

function readPkg(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}
function homepageOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return pkg.homepage ?? repo;
}

// ---- サーバー(本番の依存) ----
const prod = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
for (const [license, list] of Object.entries(prod)) {
  for (const p of list) {
    p.versions.forEach((v, i) => add(p.name, v, p.paths[i] ?? p.paths[0], 'サーバー', license, p.homepage));
  }
}

// ---- 画面(ブラウザに同梱) と Service Worker ----
/** モジュールのパスから、そのパッケージのフォルダ(最後の node_modules/<名前>)を求める */
function packageDirOf(id) {
  const clean = id.replace(/^\0/, '').split('?')[0];
  const marker = `${path.sep}node_modules${path.sep}`;
  const i = clean.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = clean.slice(i + marker.length).split(path.sep);
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { name, dir: clean.slice(0, i + marker.length) + name };
}

const { build } = await import('vite');
const outDir = mkdtempSync(path.join(os.tmpdir(), 'sh-notices-'));
const moduleIds = new Set();
try {
  await build({
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [
      {
        name: 'servicehub-collect-modules',
        generateBundle(_opts, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue;
            for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) moduleIds.add(id);
          }
        },
      },
    ],
  });
  for (const id of moduleIds) {
    const p = packageDirOf(id);
    if (!p || !existsSync(path.join(p.dir, 'package.json'))) continue;
    const pkg = readPkg(p.dir);
    add(pkg.name, pkg.version, p.dir, '画面', licenseOf(pkg), homepageOf(pkg));
  }
  // Service Worker(vite-plugin-pwa が Workbox の実行時モジュールを同梱する)
  const swModules = new Set();
  for (const f of readdirSync(outDir)) {
    const file = path.join(outDir, f);
    if (!f.endsWith('.js') || !statSync(file).isFile()) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/workbox:([a-z-]+):/g)) swModules.add(`workbox-${m[1]}`);
  }
  // vite-plugin-pwa → workbox-build → 各モジュール の順に依存をたどって場所を求める
  const fromRoot = createRequire(path.join(root, 'package.json'));
  const fromPwa = createRequire(fromRoot.resolve('vite-plugin-pwa/package.json'));
  const fromBuild = createRequire(fromPwa.resolve('workbox-build/package.json'));
  for (const name of swModules) {
    let pkgFile;
    for (const req of [fromRoot, fromBuild]) {
      try {
        pkgFile = req.resolve(`${name}/package.json`);
        break;
      } catch {
        // 次の場所を探す
      }
    }
    if (!pkgFile) throw new Error(`Service Worker のモジュール ${name} が見つかりません`);
    const dir = path.dirname(pkgFile);
    const pkg = readPkg(dir);
    add(pkg.name, pkg.version, dir, 'Service Worker', licenseOf(pkg), homepageOf(pkg));
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ---- ライセンス本文 ----
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function authorOf(dir) {
  try {
    const a = readPkg(dir).author;
    return typeof a === 'string' ? a : a?.name;
  } catch {
    return undefined;
  }
}

function licenseTexts(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.\-_].*)?$/i.test(f) && statSync(path.join(dir, f)).isFile());
  } catch {
    return [];
  }
  return files.sort().map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
}

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
const shipped = new Set(list.map((p) => p.name));
const devOnly = Object.keys(pkgJson.devDependencies ?? {})
  .filter((n) => !shipped.has(n))
  .sort()
  .map((n) => {
    const dir = path.join(root, 'node_modules', n);
    const pkg = existsSync(path.join(dir, 'package.json')) ? readPkg(dir) : { version: pkgJson.devDependencies[n], license: 'UNKNOWN' };
    return { name: n, version: pkg.version, license: licenseOf(pkg) };
  });

const byLicense = {};
for (const p of list) byLicense[p.license] = (byLicense[p.license] ?? 0) + 1;

const lines = [];
const hr = '='.repeat(72);
lines.push('ServiceHub — 第三者ソフトウェアのライセンス表示 (THIRD_PARTY_NOTICES)');
lines.push(hr);
lines.push('');
lines.push('ServiceHub には、以下のオープンソースソフトウェアが含まれています。');
lines.push('各ソフトウェアの著作権は、それぞれの著作権者に帰属します。各ソフトウェアは');
lines.push('それぞれのライセンスの条件に従って利用・再配布されます(ライセンス本文は後半に掲載)。');
lines.push('');
lines.push(`対象: ServiceHub ${pkgJson.version} の実行時に使われるもの`);
lines.push('  [サーバー]        サーバーの実行に必要なパッケージ(本番の依存パッケージとその依存)');
lines.push('  [画面]            ブラウザで動く画面の JavaScript に同梱されるライブラリ');
lines.push('  [Service Worker]  スマホ・タブレットのホーム画面アプリ(PWA)用に同梱されるライブラリ');
lines.push('');
lines.push('※ Node.js と PostgreSQL は本製品に含まれません(利用するホスティング・サーバーが提供するもの)。');
lines.push('※ Docker でイメージを作る場合、元にする公式イメージ(Node.js / PostgreSQL / Debian)に含まれる');
lines.push('  ソフトウェアのライセンスは、それぞれのイメージの配布元の表示に従います。');
lines.push(`※ このファイルは scripts/third-party-notices.mjs(pnpm notices)で依存パッケージから生成しています。`);
lines.push(`  生成日: ${new Date().toISOString().slice(0, 10)}  /  パッケージ数: ${list.length}`);
lines.push(`  ライセンス別: ${Object.entries(byLicense).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}`);
lines.push('');
lines.push('■ 1. 一覧(名前 / バージョン / ライセンス / 使われる場所)');
lines.push('');
for (const p of list) lines.push(`- ${p.name} ${p.version}  (${p.license})  [${[...p.usedIn].join('・')}]`);
lines.push('');
lines.push('■ 2. 開発・テスト専用のツール(配布される実行物には含まれません。参考として一覧のみ)');
lines.push('');
for (const p of devOnly) lines.push(`- ${p.name} ${p.version}  (${p.license})`);
lines.push('');
lines.push('■ 3. ライセンス本文');
lines.push('');
let missing = 0;
for (const p of list) {
  lines.push('-'.repeat(72));
  lines.push(`${p.name} ${p.version}  (${p.license})`);
  if (p.homepage) lines.push(String(p.homepage).replace(/^git\+/, ''));
  lines.push('-'.repeat(72));
  const texts = licenseTexts(p.dir);
  if (texts.length === 0) {
    missing++;
    const author = authorOf(p.dir);
    if (p.license === 'MIT') {
      lines.push('(このパッケージにはライセンス本文のファイルが含まれていないため、MIT License の標準の本文を掲載します)');
      lines.push('');
      lines.push(`Copyright (c) ${author ?? `${p.name} contributors`}`);
      lines.push('');
      lines.push(MIT_TEXT);
    } else {
      lines.push(`(このパッケージにはライセンス本文のファイルが含まれていません。ライセンス: ${p.license}${author ? ` / 作者: ${author}` : ''})`);
    }
  }
  for (const t of texts) {
    if (texts.length > 1) lines.push(`[${t.file}]`);
    lines.push(t.text);
    lines.push('');
  }
  lines.push('');
}

// Windows のメモ帳でも文字化けしないよう UTF-8(BOM付き)・CRLF で保存する(manual/ の他の説明書と同じ)
const body = '﻿' + lines.join('\n').replace(/\n+$/, '\n').replace(/\n/g, '\r\n');
writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${path.relative(root, OUT)}: ${list.length} packages (server ${list.filter((p) => p.usedIn.has('サーバー')).length}, web ${list.filter((p) => p.usedIn.has('画面')).length}, sw ${list.filter((p) => p.usedIn.has('Service Worker')).length}), dev-only ${devOnly.length}, without license file ${missing}`);
for (const p of list.filter((x) => x.license === 'UNKNOWN')) console.warn(`license unknown: ${p.name}@${p.version}`);
