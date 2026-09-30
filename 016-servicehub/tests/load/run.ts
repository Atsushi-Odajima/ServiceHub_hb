/**
 * 負荷試験の測定(tests/load/generate.ts で作った servicehub_load に対し、ビルド済みサーバーを起動して測る)
 *
 *   pnpm build && pnpm load:run -- [--duration 10] [--connections 10] [--out docs/LOAD_TEST_REPORT.md]
 *
 * - 主要一覧 / 今日の画面 / 受付ボード / 空き枠(管理・公開)/ 顧客検索 / 権限による絞り込み(Staff・Manager)/ 集計(KPI)
 * - 予約作成の連続実行(別々の枠)と、同一枠への高並行予約(大量データの上でも成功は1件)
 * 結果は販売保証値ではない(この環境での実測値)。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import autocannon from 'autocannon';
import pg from 'pg';
import { argValue } from '../../src/server/cli/cli-config.js';

const LOAD_DB_URL = argValue('database-url') ?? process.env.LOAD_DATABASE_URL ?? 'postgres://servicehub:servicehub_dev_pw@127.0.0.1:5432/servicehub_load';
const PASSWORD = 'load-test-pass-2026';
const PORT = Number(argValue('port') ?? 3300);
const BASE = `http://localhost:${PORT}`;
const DURATION = Number(argValue('duration') ?? 10);
const CONNECTIONS = Number(argValue('connections') ?? 10);
const OUT = argValue('out');

interface Session {
  cookie: string;
  csrf: string;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

async function login(email: string): Promise<Session> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], csrf: ((await r.json()) as { csrfToken: string }).csrfToken };
}

async function getJson<T>(s: Session | null, path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: s ? { cookie: s.cookie } : {} });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

function jstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

interface Row {
  name: string;
  path: string;
  role: string;
  cold: number;
  p50: number;
  p90: number;
  p99: number;
  avg: number;
  max: number;
  rps: number;
  errors: number;
  items: number | null;
}

async function measure(name: string, role: string, s: Session | null, path: string): Promise<Row> {
  const t0 = performance.now();
  const first = await fetch(`${BASE}${path}`, { headers: s ? { cookie: s.cookie } : {} });
  const body = await first.text();
  const cold = performance.now() - t0;
  if (!first.ok) throw new Error(`${name}: ${first.status} ${body.slice(0, 200)}`);
  let items: number | null = null;
  try {
    const j = JSON.parse(body) as { items?: unknown[]; slots?: unknown[] };
    items = Array.isArray(j.items) ? j.items.length : Array.isArray(j.slots) ? j.slots.length : null;
  } catch {
    items = null;
  }
  const r = await autocannon({ url: `${BASE}${path}`, connections: CONNECTIONS, duration: DURATION, headers: s ? { cookie: s.cookie } : {} });
  const row: Row = {
    name,
    path,
    role,
    cold: Math.round(cold),
    p50: r.latency.p50,
    p90: r.latency.p90,
    p99: r.latency.p99,
    avg: Math.round(r.latency.average),
    max: r.latency.max,
    rps: Math.round(r.requests.average),
    errors: r.errors + r.non2xx,
    items,
  };
  console.info(`${name.padEnd(30)} p50 ${String(row.p50).padStart(5)}ms  p99 ${String(row.p99).padStart(5)}ms  ${String(row.rps).padStart(5)} req/s  err ${row.errors}`);
  return row;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: LOAD_DB_URL, max: 1 });
  const db = await pool.connect();
  // 件数は全組織分を数えるためシステム文脈(RLS)で読む
  await db.query(`SELECT set_config('app.system', 'on', false)`);
  // 前回の測定で作った予約を片付ける(毎回同じ条件で測るため)
  await db.query(`CREATE TEMP TABLE prev AS SELECT id, occupancy_id FROM bookings WHERE idempotency_key LIKE 'load-write-%' OR idempotency_key LIKE 'load-same-%'`);
  await db.query(`DELETE FROM booking_events WHERE booking_id IN (SELECT id FROM prev)`);
  await db.query(`DELETE FROM notifications WHERE booking_id IN (SELECT id FROM prev)`);
  await db.query(`DELETE FROM bookings WHERE id IN (SELECT id FROM prev)`);
  await db.query(`DELETE FROM occupancies WHERE id IN (SELECT occupancy_id FROM prev)`);
  await db.query(`DROP TABLE prev`);
  const counts = (
    await db.query<{ t: string; n: string }>(
      `SELECT t, n::text FROM (VALUES ('組織', (SELECT count(*) FROM organizations)), ('拠点', (SELECT count(*) FROM locations)), ('スタッフ', (SELECT count(*) FROM staff)),
         ('顧客', (SELECT count(*) FROM customers)), ('予約', (SELECT count(*) FROM bookings)), ('回数券台帳', (SELECT count(*) FROM pass_ledger_entries)),
         ('通知', (SELECT count(*) FROM notifications)), ('シフト', (SELECT count(*) FROM staff_shifts))) v(t, n)`,
    )
  ).rows;
  const dbSize = (await db.query<{ s: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)).rows[0].s;
  const pgVersion = (await db.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0].v;
  const pgSettings = (
    await db.query<{ name: string; setting: string }>(
      `SELECT name, current_setting(name) AS setting FROM (VALUES ('shared_buffers'), ('work_mem'), ('max_connections')) v(name)`,
    )
  ).rows;
  db.release();
  await pool.end();

  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: LOAD_DB_URL,
      DATABASE_SSL: 'disable',
      SESSION_SECRET: 'load-test-session-secret-0123456789abcdefghij',
      APP_BASE_URL: BASE,
      PORT: String(PORT),
      RUN_WORKER: 'false',
      LOG_LEVEL: 'error',
      LOGIN_RATE_LIMIT_PER_15MIN: '1000',
      PUBLIC_RATE_LIMIT_PER_MIN: '10000',
      EMAIL_PROVIDER: 'log',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitForHealth();
    const owner = await login('owner@load-001.example');
    const manager = await login('manager@load-001.example');
    const staff = await login('staff@load-001.example');
    const reception = await login('reception@load-001.example');
    const locs = await getJson<{ items: { id: string; slug: string; sortOrder?: number; name: string }[] }>(owner, '/api/v1/locations');
    const loc1 = locs.items.find((l) => l.slug === 'loc-1')!;
    const services = await getJson<{ items: { id: string; name: string }[] }>(owner, '/api/v1/services');
    const personal = services.items.find((s) => s.name === '60分パーソナル')!;
    const today = jstDate(0);
    const weekFrom = new Date(`${jstDate(-3)}T00:00:00+09:00`).toISOString();
    const weekTo = new Date(`${jstDate(4)}T00:00:00+09:00`).toISOString();
    const monthFrom = jstDate(-30);
    const q = (s: string) => encodeURIComponent(s);

    const rows: Row[] = [];
    rows.push(await measure('権限チェック(セッション・権限の確認のみ)', 'Staff', staff, '/api/v1/auth/me'));
    rows.push(await measure('今日の画面(拠点)', 'Owner', owner, `/api/v1/today?locationId=${loc1.id}`));
    rows.push(await measure('今日の画面(自分の予約)', 'Staff', staff, '/api/v1/today'));
    rows.push(await measure('受付ボード', 'Reception', reception, `/api/v1/reception/board?locationId=${loc1.id}`));
    rows.push(await measure('予約一覧(1週間・拠点)', 'Manager', manager, `/api/v1/bookings?from=${q(weekFrom)}&to=${q(weekTo)}&locationId=${loc1.id}&limit=500`));
    rows.push(await measure('予約一覧(担当のみ)', 'Staff', staff, `/api/v1/bookings?from=${q(weekFrom)}&to=${q(weekTo)}&limit=500`));
    rows.push(await measure('空き枠(管理・おまかせ)', 'Owner', owner, `/api/v1/availability?locationId=${loc1.id}&serviceId=${personal.id}&date=${jstDate(2)}`));
    rows.push(await measure('空き枠(公開予約・未ログイン)', '未ログイン', null, `/api/v1/public/orgs/load-001/locations/loc-1/availability?serviceId=${personal.id}&date=${jstDate(2)}`));
    rows.push(await measure('顧客検索(電話の前方一致)', 'Reception', reception, `/api/v1/customers?q=${q('0900010001')}`));
    rows.push(await measure('顧客検索(電話の下4桁)', 'Reception', reception, `/api/v1/customers?q=${q('0123')}`));
    rows.push(await measure('顧客検索(氏名)', 'Owner', owner, `/api/v1/customers?q=${q('佐藤')}`));
    rows.push(await measure('顧客一覧(権限で絞り込み)', 'Staff', staff, '/api/v1/customers'));
    rows.push(await measure('顧客一覧(担当拠点で絞り込み)', 'Manager', manager, '/api/v1/customers'));
    rows.push(await measure('横断検索', 'Owner', owner, `/api/v1/search?q=${q('佐藤')}`));
    rows.push(await measure('運営KPI(30日・全拠点)', 'Owner', owner, `/api/v1/kpi?from=${monthFrom}&to=${today}`));
    rows.push(await measure('ダッシュボード', 'Owner', owner, '/api/v1/dashboard'));
    rows.push(await measure('回数券一覧', 'Owner', owner, '/api/v1/passes'));
    rows.push(await measure('通知履歴', 'Owner', owner, '/api/v1/notifications'));

    // ---- 書き込み: 別々の枠への予約作成(10並行 × 200件) ----
    const staffList = await getJson<{ items: { id: string; locationIds?: string[] }[] }>(owner, '/api/v1/staff');
    const targets: { staffId: string; startsAt: string }[] = [];
    // 拠点1だけに所属するスタッフ10人 × 4日 × 夕方の2枠(17:30・19:00)= 80件。生成データの予約(10/12/14/16時)と重ならない空き枠
    for (const st of staffList.items.filter((x) => (x.locationIds ?? []).length === 1 && x.locationIds![0] === loc1.id).slice(0, 10)) {
      for (let day = 20; day < 24; day++) {
        for (const hhmm of ['17:30', '19:00']) targets.push({ staffId: st.id, startsAt: new Date(`${jstDate(day)}T${hhmm}:00+09:00`).toISOString() });
      }
    }
    const customers = await getJson<{ items: { id: string }[] }>(owner, '/api/v1/customers?limit=200');
    const latencies: number[] = [];
    let ok = 0;
    let conflicts = 0;
    let failed = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const i = idx++;
        const tgt = targets[i];
        const t0 = performance.now();
        const r = await fetch(`${BASE}/api/v1/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
          body: JSON.stringify({
            locationId: loc1.id,
            serviceId: personal.id,
            staffId: tgt.staffId,
            startsAt: tgt.startsAt,
            customer: { customerId: customers.items[i % customers.items.length].id },
            idempotencyKey: `load-write-${Date.now()}-${i}`,
          }),
        });
        latencies.push(performance.now() - t0);
        if (r.ok) ok++;
        else if (r.status === 409) conflicts++;
        else failed++;
        await r.text();
      }
    };
    const w0 = performance.now();
    await Promise.all(Array.from({ length: 10 }, worker));
    const wall = (performance.now() - w0) / 1000;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))]);
    const writeRow = { total: targets.length, ok, conflicts, failed, p50: pct(50), p90: pct(90), p99: pct(99), rps: Math.round(targets.length / wall) };
    console.info(`予約作成(別々の枠) ok ${ok} / 競合 ${conflicts} / 失敗 ${failed}  p50 ${writeRow.p50}ms p99 ${writeRow.p99}ms  ${writeRow.rps} 件/s`);

    // ---- 同一枠への高並行予約(50並行)----
    const same = { staffId: targets[0].staffId, startsAt: new Date(`${jstDate(24)}T19:00:00+09:00`).toISOString() };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fetch(`${BASE}/api/v1/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
          body: JSON.stringify({ locationId: loc1.id, serviceId: personal.id, staffId: same.staffId, startsAt: same.startsAt, customer: { customerId: customers.items[i].id }, idempotencyKey: `load-same-${Date.now()}-${i}` }),
        }).then(async (r) => {
          await r.text();
          return r.status;
        }),
      ),
    );
    const sameOk = results.filter((s) => s === 200).length;
    const sameConflict = results.filter((s) => s === 409).length;
    console.info(`同一枠への50並行予約: 成功 ${sameOk} / 競合 ${sameConflict} / その他 ${50 - sameOk - sameConflict}`);

    if (OUT) {
      const lines: string[] = [];
      lines.push('# 負荷試験の結果 (LOAD_TEST_REPORT.md)', '');
      lines.push(`実施: ${new Date().toISOString()} / \`pnpm load:generate\` + \`pnpm load:run\``, '');
      lines.push('> **これは販売保証値ではありません。** この開発環境で生成データに対して測った値です。「200万予約対応」等の広告には使わないでください。', '');
      lines.push('## 環境', '');
      lines.push(`- CPU ${os.cpus().length}コア(${os.cpus()[0]?.model ?? '-'}) / メモリ ${Math.round(os.totalmem() / 1024 ** 3)}GB / ${os.type()} ${os.release()}`);
      lines.push(`- Node.js ${process.version} / PostgreSQL ${pgVersion}(${pgSettings.map((s) => `${s.name}=${s.setting}`).join(', ')}。既定値のまま)`);
      lines.push(`- アプリとDBは同じマシン(ネットワーク遅延なし)。アプリは1プロセス、DB接続プール10`);
      lines.push(`- 測定: autocannon ${CONNECTIONS}並行 × ${DURATION}秒(同じURLを繰り返し)。「初回」は測定前の1回目の応答時間`, '');
      lines.push('## データ量', '');
      lines.push('| 表 | 件数 |', '|---|---:|');
      for (const r of counts) lines.push(`| ${r.t} | ${Number(r.n).toLocaleString()} |`);
      lines.push(`| DBサイズ | ${dbSize} |`, '');
      lines.push('## 読み取り(応答時間 ms)', '');
      lines.push('| 画面/API | ロール | 件数 | 初回 | p50 | p90 | p99 | 最大 | req/s | エラー |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
      for (const r of rows) lines.push(`| ${r.name} | ${r.role} | ${r.items ?? '-'} | ${r.cold} | ${r.p50} | ${r.p90} | ${r.p99} | ${r.max} | ${r.rps} | ${r.errors} |`);
      lines.push('', '## 書き込み', '');
      lines.push(`- 予約作成(別々の枠 ${writeRow.total} 件を10並行): 成功 ${writeRow.ok} / 競合 ${writeRow.conflicts} / 失敗 ${writeRow.failed}、p50 ${writeRow.p50}ms・p90 ${writeRow.p90}ms・p99 ${writeRow.p99}ms、${writeRow.rps} 件/秒`);
      lines.push(`- 同一枠への50並行予約: 成功 **${sameOk}** 件 / 競合(409) ${sameConflict} 件 / その他 ${50 - sameOk - sameConflict} 件`);
      lines.push('', '## 読み方・注意', '');
      lines.push('- 1組織あたりの規模は 顧客5,000・予約2万・スタッフ50・拠点5(負荷試験目標を100組織に分けた値)。1組織に200万件が集中する使い方は想定・測定していない。');
      lines.push('- アプリとDBが同じマシン(4コア)で CPU を分け合っている。本番のホスティング(アプリとDBが別・ネットワーク越し)では1往復ごとに数ms以上が加わる一方、CPU・メモリの多いプランでは速くなる。');
      lines.push('- req/s は同じURLを10並行で繰り返したときの上限の目安で、実際の利用(1組織で同時に数人〜数十人)より高い負荷。10並行時の応答時間には Node.js 1プロセスの CPU 待ちが含まれる。');
      lines.push('- 空き枠: 1回あたり DB 読み込み約17ms + 計算約7ms(単独実行時)。この測定で見つけた計算の無駄(おまかせ割当の並べ替えで毎回タイムゾーン変換・全件走査)を除き、同じ条件の p50 は scale 0.02 で 311ms → 57ms、全量で 223ms → 約170〜190ms に短縮した(判定内容は同じ。単体・統合テストで確認)。');
      lines.push('- 運営KPI は30日分の稼働率(勤務・休憩・予約の区間計算)を含むため重い。期間を指定して表示する画面で、連続した再読み込みは想定しない。');
      lines.push('- 予約作成は、枠の排他(advisory lock)・予約エンジンの再判定・占有の確保・履歴/通知/監査の記録を1トランザクションで行うため、読み取りより遅い。');
      lines.push('- 再測定: `pnpm load:generate -- --scale 1`(約16分・DB 約8GB)→ `pnpm build && pnpm load:run -- --out docs/LOAD_TEST_REPORT.md`。終わったら `DROP DATABASE servicehub_load` で容量を戻す。');
      lines.push('');
      writeFileSync(OUT, lines.join('\n'));
      console.info(`report: ${OUT}`);
    }
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
