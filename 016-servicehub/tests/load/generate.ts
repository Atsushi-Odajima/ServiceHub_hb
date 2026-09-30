/**
 * 負荷試験用データの生成(販売保証値ではなく、負荷試験目標の規模で性能を測るためのもの)
 *
 *   pnpm load:generate -- [--scale 0.1] [--database-url postgres://.../servicehub_load]
 *
 * 目標規模(scale=1): 組織100 / 拠点500 / スタッフ5,000 / 顧客50万 / 予約200万 / 回数券台帳200万 / 通知500万
 * 組織・拠点・スタッフ・サービスは常に目標どおり作り、件数の多い表だけを scale 倍する(段階的に増やして測る)。
 * - 専用DB(名前が _load で終わるもの)を作り直してから生成する(他のDBには触れない)
 * - 予約はスタッフごとに1日4枠(10/12/14/16時, 60分)を今日の前後に並べ、同じスタッフの時間重複はない(排他制約を満たす)
 * - 回数券台帳はDBのトリガーを通して投入する(残数は台帳から計算される。10回券を付与して9回利用 → 残1)
 */
import pg from 'pg';
import { hashPassword } from '../../src/server/auth/crypto.js';
import { argValue } from '../../src/server/cli/cli-config.js';
import { migrate } from '../../src/server/db/migrate.js';

export const LOAD_DB_URL = argValue('database-url') ?? process.env.LOAD_DATABASE_URL ?? 'postgres://servicehub:servicehub_dev_pw@127.0.0.1:5432/servicehub_load';
export const LOAD_PASSWORD = 'load-test-pass-2026';
const scale = Number(argValue('scale') ?? '0.1');
if (!(scale > 0 && scale <= 1)) throw new Error('--scale は 0 より大きく 1 以下');

const ORGS = 100;
const LOCS = 5; // 組織あたり
const STAFF = 50; // 組織あたり
const CUSTOMERS = Math.max(50, Math.round(5000 * scale)); // 組織あたり
const BOOKINGS_PER_STAFF = Math.max(8, Math.round(400 / 4 * scale) * 4); // 1日4枠
const PASSES = Math.max(10, Math.round(2000 * scale)); // 組織あたり(1枚につき台帳10件)
const NOTIFICATIONS = Math.max(100, Math.round(50000 * scale)); // 組織あたり
const DAYS = BOOKINGS_PER_STAFF / 4;
const DAY_FROM = -Math.floor(DAYS / 2);

const FAMILY = [
  ['佐藤', 'サトウ', 'さとう'], ['鈴木', 'スズキ', 'すずき'], ['高橋', 'タカハシ', 'たかはし'], ['田中', 'タナカ', 'たなか'], ['伊藤', 'イトウ', 'いとう'],
  ['渡辺', 'ワタナベ', 'わたなべ'], ['山本', 'ヤマモト', 'やまもと'], ['中村', 'ナカムラ', 'なかむら'], ['小林', 'コバヤシ', 'こばやし'], ['加藤', 'カトウ', 'かとう'],
  ['吉田', 'ヨシダ', 'よしだ'], ['山田', 'ヤマダ', 'やまだ'], ['佐々木', 'ササキ', 'ささき'], ['山口', 'ヤマグチ', 'やまぐち'], ['松本', 'マツモト', 'まつもと'],
  ['井上', 'イノウエ', 'いのうえ'], ['木村', 'キムラ', 'きむら'], ['林', 'ハヤシ', 'はやし'], ['斎藤', 'サイトウ', 'さいとう'], ['清水', 'シミズ', 'しみず'],
];
const GIVEN = [
  ['花子', 'ハナコ', 'はなこ'], ['太郎', 'タロウ', 'たろう'], ['美咲', 'ミサキ', 'みさき'], ['翔', 'ショウ', 'しょう'], ['陽菜', 'ヒナ', 'ひな'],
  ['蓮', 'レン', 'れん'], ['結衣', 'ユイ', 'ゆい'], ['大翔', 'ヒロト', 'ひろと'], ['さくら', 'サクラ', 'さくら'], ['悠真', 'ユウマ', 'ゆうま'],
  ['葵', 'アオイ', 'あおい'], ['湊', 'ミナト', 'みなと'], ['凛', 'リン', 'りん'], ['颯太', 'ソウタ', 'そうた'], ['芽依', 'メイ', 'めい'],
  ['樹', 'イツキ', 'いつき'], ['美月', 'ミツキ', 'みつき'], ['陸', 'リク', 'りく'], ['彩', 'アヤ', 'あや'], ['健', 'ケン', 'けん'],
];

async function recreateDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[a-z0-9_]+_load$/.test(name)) throw new Error(`負荷試験用DB(名前が _load で終わる)以外は作り直しません: ${name}`);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

async function main(): Promise<void> {
  const started = Date.now();
  console.info(`scale=${scale}: 組織 ${ORGS} / 拠点 ${ORGS * LOCS} / スタッフ ${ORGS * STAFF} / 顧客 ${ORGS * CUSTOMERS} / 予約 ${ORGS * STAFF * BOOKINGS_PER_STAFF} / 回数券台帳 ${ORGS * PASSES * 10} / 通知 ${ORGS * NOTIFICATIONS}`);
  await recreateDatabase(LOAD_DB_URL);
  const pool = new pg.Pool({ connectionString: LOAD_DB_URL, max: 2 });
  await migrate(pool);
  const c = await pool.connect();
  const step = async (label: string, sql: string, params: unknown[] = []) => {
    const t0 = Date.now();
    const r = await c.query(sql, params);
    console.info(`  ${label.padEnd(28)} ${String(r.rowCount ?? '').padStart(9)} 行  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };
  try {
    await c.query(`SELECT set_config('app.system', 'on', false), set_config('synchronous_commit', 'off', false), set_config('statement_timeout', '0', false),
                          set_config('maintenance_work_mem', '256MB', false), set_config('work_mem', '64MB', false)`);
    const hash = await hashPassword(LOAD_PASSWORD);
    const fam = JSON.stringify(FAMILY);
    const giv = JSON.stringify(GIVEN);

    await step('organizations', `INSERT INTO organizations (slug, name, timezone, is_sample) SELECT 'load-' || lpad(g::text, 3, '0'), '負荷試験 ' || g, 'Asia/Tokyo', false FROM generate_series(1, $1) g`, [ORGS]);
    await c.query(`CREATE TEMP TABLE o AS SELECT id, row_number() OVER (ORDER BY slug) AS n, slug FROM organizations WHERE slug LIKE 'load-%'`);
    await step(
      'locations',
      `INSERT INTO locations (organization_id, slug, name, timezone, is_public, min_notice_min, max_advance_days, sort_order, allow_public_waitlist)
       SELECT o.id, 'loc-' || g, '拠点' || g, 'Asia/Tokyo', true, 60, 90, g, true FROM o CROSS JOIN generate_series(1, $1) g`,
      [LOCS],
    );
    await step('location_hours', `INSERT INTO location_hours (organization_id, location_id, weekday, open_time, close_time) SELECT l.organization_id, l.id, w, '09:00', '21:00' FROM locations l CROSS JOIN generate_series(1, 7) w`);
    await step('staff', `INSERT INTO staff (organization_id, display_name, internal_name, accepts_bookings, sort_order) SELECT o.id, 'スタッフ' || g, 'staff-' || g, true, g FROM o CROSS JOIN generate_series(1, $1) g`, [STAFF]);
    await step(
      'staff_locations',
      `INSERT INTO staff_locations (organization_id, staff_id, location_id)
       SELECT s.organization_id, s.id, l.id FROM staff s JOIN locations l ON l.organization_id = s.organization_id AND l.sort_order = ((s.sort_order - 1) % $1) + 1
       UNION ALL
       SELECT s.organization_id, s.id, l.id FROM staff s JOIN locations l ON l.organization_id = s.organization_id AND l.sort_order = (s.sort_order % $1) + 1 WHERE s.sort_order % 10 = 0`,
      [LOCS],
    );
    await step(
      'services',
      `INSERT INTO services (organization_id, name, category, duration_min, buffer_after_min, capacity, max_party_size, requires_staff, is_bookable, is_public, pass_eligible, plan_eligible, schedule_mode, sort_order)
       SELECT o.id, (ARRAY['60分パーソナル','30分体験','90分コース','45分ケア','少人数レッスン'])[g], 'メニュー', (ARRAY[60,30,90,45,60])[g], (ARRAY[10,0,10,5,0])[g],
              CASE WHEN g = 5 THEN 6 ELSE 1 END, 1, true, true, true, true, true, 'flexible', g
         FROM o CROSS JOIN generate_series(1, 5) g`,
    );
    await step('service_locations', `INSERT INTO service_locations (organization_id, service_id, location_id) SELECT s.organization_id, s.id, l.id FROM services s JOIN locations l ON l.organization_id = s.organization_id`);
    await step('service_staff', `INSERT INTO service_staff (organization_id, service_id, staff_id) SELECT s.organization_id, s.id, st.id FROM services s JOIN staff st ON st.organization_id = s.organization_id`);
    await step(
      'users',
      `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
       SELECT r || '@' || o.slug || '.example', r || '@' || o.slug || '.example', $1, r || ' ' || o.slug, now() FROM o CROSS JOIN unnest(ARRAY['owner','manager','reception','staff']) r`,
      [hash],
    );
    await step(
      'memberships',
      `INSERT INTO memberships (organization_id, user_id, role, all_locations, staff_id)
       SELECT o.id, u.id, split_part(u.email, '@', 1), split_part(u.email, '@', 1) = 'owner',
              CASE WHEN split_part(u.email, '@', 1) = 'staff' THEN (SELECT s.id FROM staff s WHERE s.organization_id = o.id AND s.sort_order = 1) END
         FROM o JOIN users u ON u.email LIKE '%@' || o.slug || '.example'`,
    );
    await step(
      'membership_locations',
      `INSERT INTO membership_locations (organization_id, membership_id, location_id)
       SELECT m.organization_id, m.id, l.id FROM memberships m JOIN locations l ON l.organization_id = m.organization_id AND l.sort_order = 1 WHERE m.role IN ('manager', 'reception', 'staff')`,
    );
    await step(
      'staff_shifts',
      `INSERT INTO staff_shifts (organization_id, staff_id, location_id, shift_type, starts_at, ends_at, source)
       SELECT s.organization_id, s.id, l.id, 'work',
              ((current_date + d)::timestamp + time '09:00') AT TIME ZONE 'Asia/Tokyo', ((current_date + d)::timestamp + time '21:00') AT TIME ZONE 'Asia/Tokyo', 'template'
         FROM staff s JOIN locations l ON l.organization_id = s.organization_id AND l.sort_order = ((s.sort_order - 1) % $1) + 1
        CROSS JOIN generate_series($2::int, $3::int) d`,
      [LOCS, Math.min(DAY_FROM, -14), Math.max(DAY_FROM + DAYS - 1, 30)],
    );
    await step(
      'customers',
      `INSERT INTO customers (organization_id, name, name_kana, email, email_normalized, phone, phone_normalized, name_norm, kana_norm, tags, source, created_at)
       SELECT o.id,
              (f->>0) || ' ' || (gv->>0), (f->>1) || ' ' || (gv->>1),
              'c' || g || '@' || o.slug || '.example', 'c' || g || '@' || o.slug || '.example',
              '090-' || substr(d, 1, 4) || '-' || substr(d, 5, 4), '090' || d,
              (f->>0) || (gv->>0), (f->>2) || (gv->>2),
              CASE WHEN g % 7 = 0 THEN ARRAY['リピーター'] WHEN g % 11 = 0 THEN ARRAY['回数券'] ELSE ARRAY[]::text[] END,
              CASE WHEN g % 3 = 0 THEN 'public' ELSE 'staff' END,
              now() - make_interval(days => (g % 400))
         FROM o CROSS JOIN generate_series(1, $1) g
         CROSS JOIN LATERAL (SELECT lpad((o.n * 100000 + g)::text, 8, '0') AS d, ($2::jsonb)->(g % 20) AS f, ($3::jsonb)->((g / 20) % 20) AS gv) x`,
      [CUSTOMERS, fam, giv],
    );
    await c.query(`CREATE TEMP TABLE ci AS SELECT id, organization_id, row_number() OVER (PARTITION BY organization_id ORDER BY id) AS idx, name, email, phone FROM customers`);
    await c.query(`CREATE INDEX ON ci (organization_id, idx)`);
    await c.query(`CREATE TEMP TABLE si AS SELECT s.id, s.organization_id, s.sort_order, s.display_name, l.id AS location_id, l.name AS location_name, l.slug AS location_slug
                     FROM staff s JOIN locations l ON l.organization_id = s.organization_id AND l.sort_order = ((s.sort_order - 1) % ${LOCS}) + 1`);
    // 予約の枠: スタッフ × n(1日4枠)。過去は完了/無断欠席/キャンセル、未来は確定/キャンセル
    await c.query(
      `CREATE TEMP TABLE slots AS
       SELECT si.organization_id, si.id AS staff_id, si.display_name, si.location_id, si.location_name, si.location_slug, sv.id AS service_id, sv.name AS service_name,
              n, gen_random_uuid() AS occupancy_id, gen_random_uuid() AS booking_id,
              ((current_date + ($2::int + n / 4))::timestamp + make_interval(hours => 10 + 2 * (n % 4))) AT TIME ZONE 'Asia/Tokyo' AS starts_at,
              ((si.sort_order * 7919 + n * 104729) % $3) + 1 AS cidx,
              abs(hashtext(si.id::text || n)) % 100 AS r
         FROM si JOIN services sv ON sv.organization_id = si.organization_id AND sv.sort_order = 1
        CROSS JOIN generate_series(0, $1::int - 1) n`,
      [BOOKINGS_PER_STAFF, DAY_FROM, CUSTOMERS],
    );
    await c.query(`ALTER TABLE slots ADD COLUMN status text`);
    await c.query(
      `UPDATE slots SET status = CASE WHEN starts_at < now() THEN CASE WHEN r < 80 THEN 'completed' WHEN r < 85 THEN 'no_show' WHEN r < 95 THEN 'canceled_customer' ELSE 'canceled_business' END
                                     ELSE CASE WHEN r < 90 THEN 'confirmed' ELSE 'canceled_customer' END END`,
    );
    await step(
      'occupancies',
      `INSERT INTO occupancies (id, organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken, status)
       SELECT occupancy_id, organization_id, location_id, service_id, staff_id, starts_at, starts_at + interval '60 minutes', starts_at, starts_at + interval '70 minutes', 1,
              CASE WHEN status LIKE 'canceled%' OR status = 'no_show' THEN 0 ELSE 1 END,
              CASE WHEN status LIKE 'canceled%' OR status = 'no_show' THEN 'released' ELSE 'active' END
         FROM slots ORDER BY organization_id, staff_id, starts_at`,
    );
    await step(
      'bookings',
      `INSERT INTO bookings (id, organization_id, code, location_id, customer_id, service_id, staff_id, occupancy_id, starts_at, ends_at, party_size, status, channel, staff_selection,
                             service_snapshot, location_snapshot, staff_snapshot, contact_snapshot, idempotency_key, canceled_at, cancel_late, arrived_at, completed_at, no_show_at, created_at)
       SELECT s.booking_id, s.organization_id, 'L' || lpad(to_hex(abs(hashtext(s.booking_id::text))), 8, '0') || substr(s.booking_id::text, 1, 4), s.location_id, ci.id, s.service_id, s.staff_id, s.occupancy_id,
              s.starts_at, s.starts_at + interval '60 minutes', 1, s.status, CASE WHEN s.r % 2 = 0 THEN 'public' ELSE 'staff' END, 'specified',
              jsonb_build_object('name', s.service_name, 'notice', null, 'capacity', 1, 'category', 'メニュー', 'priceLabel', null, 'durationMin', 60, 'bufferAfterMin', 10, 'bufferBeforeMin', 0),
              jsonb_build_object('name', s.location_name, 'slug', s.location_slug, 'timezone', 'Asia/Tokyo'),
              jsonb_build_object('displayName', s.display_name),
              jsonb_build_object('name', ci.name, 'email', ci.email, 'phone', ci.phone),
              'load-' || s.booking_id,
              CASE WHEN s.status LIKE 'canceled%' THEN s.starts_at - interval '2 days' END, CASE WHEN s.status LIKE 'canceled%' THEN false END,
              CASE WHEN s.status = 'completed' THEN s.starts_at - interval '5 minutes' END,
              CASE WHEN s.status = 'completed' THEN s.starts_at + interval '60 minutes' END,
              CASE WHEN s.status = 'no_show' THEN s.starts_at + interval '30 minutes' END,
              s.starts_at - interval '7 days'
         FROM slots s JOIN ci ON ci.organization_id = s.organization_id AND ci.idx = s.cidx`,
    );
    await step(
      'customers(来店日)',
      `UPDATE customers c SET first_visit_at = x.f, last_visit_at = x.l
         FROM (SELECT customer_id, min(starts_at) AS f, max(starts_at) AS l FROM bookings WHERE status = 'completed' GROUP BY customer_id) x
        WHERE c.id = x.customer_id`,
    );
    await step('pass_products', `INSERT INTO pass_products (organization_id, name, total_uses, validity_days, all_services) SELECT o.id, '10回券', 10, 180, true FROM o`);
    await step(
      'customer_passes',
      `INSERT INTO customer_passes (organization_id, customer_id, pass_product_id, product_snapshot, granted_at, starts_on, expires_on, initial_uses)
       SELECT ci.organization_id, ci.id, pp.id, jsonb_build_object('name', '10回券', 'totalUses', 10), now() - make_interval(days => (60 + ci.idx % 30)::int),
              current_date - (60 + ci.idx % 30)::int, current_date + (ci.idx % 150)::int, 10
         FROM ci JOIN pass_products pp ON pp.organization_id = ci.organization_id WHERE ci.idx <= $1`,
      [PASSES],
    );
    await step(
      'pass_ledger_entries(トリガー)',
      `INSERT INTO pass_ledger_entries (organization_id, customer_pass_id, entry_type, delta, reason, actor_type, actor_label, idempotency_key, created_at)
       SELECT p.organization_id, p.id, CASE WHEN k = 0 THEN 'grant' ELSE 'use' END, CASE WHEN k = 0 THEN 10 ELSE -1 END, NULL, 'system', 'load', 'load-pass-' || p.id || '-' || k,
              p.granted_at + make_interval(days => k * 5)
         FROM customer_passes p CROSS JOIN generate_series(0, 9) k
        ORDER BY p.id, k`,
    );
    await step(
      'notifications',
      `INSERT INTO notifications (organization_id, type, recipient, payload, idempotency_key, status, attempts, sent_at, skip_reason, created_at, next_attempt_at)
       SELECT o.id, (ARRAY['booking_confirmed','booking_reminder','booking_changed','booking_canceled','pass_expiring'])[1 + g % 5],
              'c' || (1 + g % $2) || '@' || o.slug || '.example', '{}'::jsonb, 'load-n-' || g,
              CASE WHEN g % 100 = 0 THEN 'failed' WHEN g % 25 = 0 THEN 'skipped' ELSE 'sent' END,
              CASE WHEN g % 100 = 0 THEN 5 ELSE 1 END,
              CASE WHEN g % 25 <> 0 THEN now() - make_interval(mins => g % 144000) END,
              CASE WHEN g % 25 = 0 AND g % 100 <> 0 THEN 'no_recipient' END,
              now() - make_interval(mins => g % 144000), now() - make_interval(mins => g % 144000)
         FROM o CROSS JOIN generate_series(1, $1) g`,
      [NOTIFICATIONS, CUSTOMERS],
    );
    const t0 = Date.now();
    await c.query('ANALYZE');
    console.info(`  ANALYZE ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const counts = await c.query<{ t: string; n: number }>(
      `SELECT t, n FROM (VALUES ('organizations', (SELECT count(*) FROM organizations)), ('locations', (SELECT count(*) FROM locations)), ('staff', (SELECT count(*) FROM staff)),
               ('customers', (SELECT count(*) FROM customers)), ('bookings', (SELECT count(*) FROM bookings)), ('pass_ledger_entries', (SELECT count(*) FROM pass_ledger_entries)),
               ('notifications', (SELECT count(*) FROM notifications)), ('staff_shifts', (SELECT count(*) FROM staff_shifts))) v(t, n)`,
    );
    const size = await c.query<{ s: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
    console.info('生成結果:');
    for (const r of counts.rows) console.info(`  ${r.t.padEnd(22)} ${Number(r.n).toLocaleString()}`);
    console.info(`  DBサイズ ${size.rows[0].s} / 所要 ${((Date.now() - started) / 1000).toFixed(0)}s`);
  } finally {
    c.release();
    await pool.end();
  }
}

await main();
