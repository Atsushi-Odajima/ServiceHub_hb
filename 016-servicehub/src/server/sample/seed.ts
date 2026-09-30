/**
 * サンプル組織 Sample Wellness の投入(サンプル組織説明.txt と対応)。
 * 本番データとは別の組織(is_sample = true)として作成し、メールは送信されない。
 */
import type pg from 'pg';
import { addDays, localToUtcLenient, todayIn } from '../../shared/time.js';
import { normalizeEmail } from '../../shared/normalize.js';
import { hashPassword } from '../auth/crypto.js';
import type { AppConfig } from '../config.js';
import { withSystem, withSystemForOrg, type Q } from '../db/tx.js';
import { systemClock, type Deps } from '../deps.js';
import { LogMailer } from '../email/mailer.js';
import { insertCustomer } from '../modules/customers/identity.js';
import { type BookingActor, changeStatus, createBooking } from '../modules/bookings/service.js';
import { generateShiftsFromTemplates } from '../modules/shifts/generate.js';
import { sampleExtras } from './extras.js';

export const SAMPLE_SLUG = 'sample-wellness';
export const SAMPLE_PASSWORD = 'sample-pass-2026';
const TZ = 'Asia/Tokyo';

export interface SampleIds {
  orgId: string;
  locations: { ikebukuro: string; shinjuku: string };
  staff: { aki: string; mika: string; ken: string };
  resources: { roomA: string; roomB: string; bed1: string; studio: string };
  services: { personal60: string; trial30: string; yoga6: string };
  customers: Record<'newbie' | 'repeater' | 'lastOne' | 'expiring' | 'noShow' | 'planMember' | 'waiting', string>;
  memberships: Record<'owner' | 'manager' | 'reception' | 'staffAki' | 'staffKen', string>;
  users: { role: string; email: string }[];
}

export async function seedSampleOrganization(pool: pg.Pool, opts: { appBaseUrl: string; sessionSecret: string; now?: Date }): Promise<SampleIds> {
  const now = opts.now ?? new Date();
  const clock = opts.now ? { now: () => opts.now! } : systemClock;
  const deps: Deps = {
    pool,
    config: { SESSION_SECRET: opts.sessionSecret, APP_BASE_URL: opts.appBaseUrl } as AppConfig,
    clock,
    mailer: new LogMailer(false),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const hash = await hashPassword(SAMPLE_PASSWORD);
  const org = await withSystem(pool, (q) =>
    q.one<{ id: string }>(
      `INSERT INTO organizations (slug, name, is_sample, timezone, settings, public_profile)
       VALUES ($1, 'Sample Wellness', true, $2, $3, $4) RETURNING id`,
      [
        SAMPLE_SLUG,
        TZ,
        JSON.stringify({ travelBufferMinutes: 30, lateCancelPolicy: 'confirm', consumptionPrompt: 'on_complete' }),
        JSON.stringify({ description: 'パーソナルトレーニングとヨガのスタジオです(サンプル)。', contact: 'sample@example.invalid' }),
      ],
    ),
  );
  const orgId = org.id;
  const ids = await withSystemForOrg(pool, orgId, async (q) => {
    const loc = async (slug: string, name: string, address: string, sort: number) => {
      const l = await q.one<{ id: string }>(
        `INSERT INTO locations (organization_id, slug, name, address, phone, timezone, min_notice_min, max_advance_days, cancel_deadline_hours, sort_order, booking_page)
         VALUES ($1,$2,$3,$4,$5,$6,60,60,24,$7,$8) RETURNING id`,
        [orgId, slug, name, address, sort === 0 ? '03-0000-0001' : '03-0000-0002', TZ, sort, JSON.stringify({ message: 'ご予約ありがとうございます。初めての方は30分体験がおすすめです。' })],
      );
      for (let wd = 1; wd <= 7; wd++) {
        await q.exec(`INSERT INTO location_hours (organization_id, location_id, weekday, open_time, close_time) VALUES ($1,$2,$3,'10:00','20:00')`, [orgId, l.id, wd]);
      }
      return l.id;
    };
    const ikebukuro = await loc('ikebukuro', '池袋店', '東京都豊島区(サンプル住所)', 0);
    const shinjuku = await loc('shinjuku', '新宿店', '東京都新宿区(サンプル住所)', 1);

    const staff = async (name: string, locs: string[], sort: number, profile: string) => {
      const s = await q.one<{ id: string }>(`INSERT INTO staff (organization_id, display_name, public_profile, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, name, profile, sort]);
      for (const l of locs) await q.exec('INSERT INTO staff_locations (organization_id, staff_id, location_id) VALUES ($1,$2,$3)', [orgId, s.id, l]);
      return s.id;
    };
    const aki = await staff('Aki', [ikebukuro, shinjuku], 0, 'パーソナルトレーナー。池袋店と新宿店を兼務。');
    const mika = await staff('Mika', [ikebukuro], 1, 'ストレッチとボディケアが得意です。');
    const ken = await staff('Ken', [shinjuku], 2, 'ヨガインストラクター。');

    const res = async (locationId: string, name: string, category: string) =>
      (await q.one<{ id: string }>(`INSERT INTO resources (organization_id, location_id, name, category, capacity) VALUES ($1,$2,$3,$4,1) RETURNING id`, [orgId, locationId, name, category])).id;
    const roomA = await res(ikebukuro, 'Room A', 'room');
    const bed1 = await res(ikebukuro, 'Bed 1', 'bed');
    const roomB = await res(shinjuku, 'Room B', 'room');
    const studio = await res(shinjuku, 'Studio', 'studio');

    const service = async (p: {
      name: string;
      duration: number;
      after?: number;
      capacity?: number;
      maxParty?: number;
      locs: string[];
      staffIds: string[];
      reqLabel: string;
      reqResources: string[];
      price: string;
      desc: string;
      fixed?: boolean;
      sort: number;
    }) => {
      const s = await q.one<{ id: string }>(
        `INSERT INTO services (organization_id, name, description, duration_min, buffer_after_min, capacity, max_party_size, price_label, schedule_mode, sort_order, category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [orgId, p.name, p.desc, p.duration, p.after ?? 0, p.capacity ?? 1, p.maxParty ?? 1, p.price, p.fixed ? 'fixed' : 'flexible', p.sort, p.capacity && p.capacity > 1 ? 'クラス' : 'パーソナル'],
      );
      for (const l of p.locs) await q.exec('INSERT INTO service_locations (organization_id, service_id, location_id) VALUES ($1,$2,$3)', [orgId, s.id, l]);
      for (const st of p.staffIds) await q.exec('INSERT INTO service_staff (organization_id, service_id, staff_id) VALUES ($1,$2,$3)', [orgId, s.id, st]);
      const r = await q.one<{ id: string }>('INSERT INTO service_resource_requirements (organization_id, service_id, label, quantity) VALUES ($1,$2,$3,1) RETURNING id', [
        orgId,
        s.id,
        p.reqLabel,
      ]);
      for (const x of p.reqResources) await q.exec('INSERT INTO service_resource_options (organization_id, requirement_id, resource_id) VALUES ($1,$2,$3)', [orgId, r.id, x]);
      return s.id;
    };
    const personal60 = await service({
      name: '60分パーソナル',
      duration: 60,
      locs: [ikebukuro, shinjuku],
      staffIds: [aki, mika, ken],
      reqLabel: '個室',
      reqResources: [roomA, roomB],
      price: '8,800円',
      desc: 'マンツーマンのトレーニングです。',
      sort: 0,
    });
    const trial30 = await service({
      name: '30分体験',
      duration: 30,
      after: 10,
      locs: [ikebukuro, shinjuku],
      staffIds: [aki, mika, ken],
      reqLabel: 'ベッド/個室',
      reqResources: [bed1, roomB],
      price: '2,200円',
      desc: '初めての方向けの体験コースです。',
      sort: 1,
    });
    const yoga6 = await service({
      name: '6名ヨガ',
      duration: 60,
      capacity: 6,
      maxParty: 2,
      locs: [shinjuku],
      staffIds: [ken, aki],
      reqLabel: 'スタジオ',
      reqResources: [studio],
      price: '3,300円',
      desc: '少人数制のヨガクラス(定員6名)。',
      fixed: true,
      sort: 2,
    });
    for (let wd = 1; wd <= 7; wd++) {
      for (const t of ['11:00', '19:00']) {
        await q.exec('INSERT INTO service_fixed_times (organization_id, service_id, location_id, weekday, start_time) VALUES ($1,$2,$3,$4,$5)', [orgId, yoga6, shinjuku, wd, t]);
      }
    }
    const questions: [string, string, unknown, boolean, number][] = [
      ['single_choice', 'ご来店は初めてですか', [{ id: 'first', label: '初めて' }, { id: 'repeat', label: '2回目以降' }], true, 0],
      ['short_text', '運動経験(任意)', [], false, 1],
      ['confirm', 'キャンセル規定(前日まで無料)を確認しました', [], true, 2],
    ];
    for (const [type, label, options, required, sort] of questions) {
      await q.exec(
        `INSERT INTO service_questions (organization_id, service_id, type, label, options, required, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, personal60, type, label, JSON.stringify(options), required, sort],
      );
    }

    // シフト: Aki は月水金=池袋 / 火木土=新宿(休憩13-14)、Mika は池袋 火〜日、Ken は新宿 毎日
    const tpl = async (staffId: string, locationId: string, weekdays: number[], start: string, end: string, breakAt?: [string, string]) => {
      for (const wd of weekdays) {
        await q.exec(`INSERT INTO shift_templates (organization_id, staff_id, location_id, weekday, shift_type, start_time, end_time) VALUES ($1,$2,$3,$4,'work',$5,$6)`, [
          orgId,
          staffId,
          locationId,
          wd,
          start,
          end,
        ]);
        if (breakAt) {
          await q.exec(`INSERT INTO shift_templates (organization_id, staff_id, location_id, weekday, shift_type, start_time, end_time) VALUES ($1,$2,$3,$4,'break',$5,$6)`, [
            orgId,
            staffId,
            locationId,
            wd,
            breakAt[0],
            breakAt[1],
          ]);
        }
      }
    };
    await tpl(aki, ikebukuro, [1, 3, 5, 7], '10:00', '19:00', ['13:00', '14:00']);
    await tpl(aki, shinjuku, [2, 4, 6], '10:00', '19:00', ['13:00', '14:00']);
    await tpl(mika, ikebukuro, [2, 3, 4, 5, 6, 7], '10:00', '20:00', ['14:00', '15:00']);
    await tpl(ken, shinjuku, [1, 2, 3, 4, 5, 6, 7], '10:00', '20:00');
    const today = todayIn(TZ, now);
    // 過去の実施履歴(extras.ts)のため63日前から生成
    await generateShiftsFromTemplates(q, orgId, [aki, mika, ken], addDays(today, -63), 63 + 60, { skipClosedDays: true, scope: null, createdBy: null });

    // ログインユーザー(サンプル専用パスワード)
    const users: { role: string; email: string }[] = [];
    const memberships = {} as SampleIds['memberships'];
    const user = async (key: keyof SampleIds['memberships'], role: string, email: string, name: string, locs: string[] | 'all', staffId: string | null) => {
      const existing = await q.maybeOne<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [normalizeEmail(email)]);
      const u =
        existing ??
        (await q.one<{ id: string }>(`INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id`, [
          email,
          normalizeEmail(email),
          hash,
          name,
        ]));
      const m = await q.one<{ id: string }>(
        `INSERT INTO memberships (organization_id, user_id, role, all_locations, staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, u.id, role, locs === 'all', staffId],
      );
      if (locs !== 'all') {
        for (const l of locs) await q.exec('INSERT INTO membership_locations (organization_id, membership_id, location_id) VALUES ($1,$2,$3)', [orgId, m.id, l]);
      }
      memberships[key] = m.id;
      users.push({ role, email });
    };
    await user('owner', 'owner', 'owner@sample-wellness.example', 'サンプル オーナー', 'all', null);
    await user('manager', 'manager', 'manager@sample-wellness.example', '池袋 マネージャー', [ikebukuro], null);
    await user('reception', 'reception', 'reception@sample-wellness.example', '池袋 受付', [ikebukuro], null);
    await user('staffAki', 'staff', 'aki@sample-wellness.example', 'Aki', [ikebukuro, shinjuku], aki);
    await user('staffKen', 'staff', 'ken@sample-wellness.example', 'Ken', [shinjuku], ken);

    const cust = async (name: string, kana: string, email: string, phone: string, tags: string[]) =>
      insertCustomer(q, orgId, { name, nameKana: kana, email, phone, tags }, 'staff', null);
    const customers = {
      newbie: await cust('新規 花子', 'シンキ ハナコ', 'hanako@sample-wellness.example', '090-0000-0001', ['新規']),
      repeater: await cust('常連 太郎', 'ジョウレン タロウ', 'taro@sample-wellness.example', '090-0000-0002', ['リピーター']),
      lastOne: await cust('残一 次郎', 'ザンイチ ジロウ', 'jiro@sample-wellness.example', '090-0000-0003', ['回数券']),
      expiring: await cust('期限 美咲', 'キゲン ミサキ', 'misaki@sample-wellness.example', '090-0000-0004', ['回数券']),
      noShow: await cust('欠席 健一', 'ケッセキ ケンイチ', 'kenichi@sample-wellness.example', '090-0000-0005', []),
      planMember: await cust('会員 由美', 'カイイン ユミ', 'yumi@sample-wellness.example', '090-0000-0006', ['月4回']),
      waiting: await cust('待機 誠', 'タイキ マコト', 'makoto@sample-wellness.example', '090-0000-0007', []),
    };
    return {
      orgId,
      locations: { ikebukuro, shinjuku },
      staff: { aki, mika, ken },
      resources: { roomA, roomB, bed1, studio },
      services: { personal60, trial30, yoga6 },
      customers,
      memberships,
      users,
    };
  });

  // 今後の予約(予約エンジン経由で作成し、競合チェックを通す)
  const actor: BookingActor = { actor: { type: 'operator', label: 'サンプル投入' }, membershipId: null, mode: 'staff', canForce: true };
  const today = todayIn(TZ, now);
  const at = (d: string, t: string) => localToUtcLenient(d, t, TZ);
  let seq = 0;
  const book = async (q: Q, p: { location: string; service: string; staff: string | null; date: string; time: string; customer: string; party?: number; force?: boolean }) =>
    (
      await createBooking(q, deps, ids.orgId, actor, {
        locationId: p.location,
        serviceId: p.service,
        staffId: p.staff,
        startsAt: at(p.date, p.time),
        partySize: p.party ?? 1,
        customer: { customerId: p.customer },
        channel: 'staff',
        force: p.force,
        forceReason: p.force ? 'サンプルデータ' : null,
        idempotencyKey: `sample-${++seq}`,
      })
    ).booking;
  await withSystemForOrg(pool, ids.orgId, async (q) => {
    // 翌日以降の Aki の予約(池袋)… 新宿の同時間には入れないことの確認用
    const wd = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
    let akiDay = addDays(today, 1);
    while (![1, 3, 5, 7].includes(wd(akiDay))) akiDay = addDays(akiDay, 1);
    await book(q, { location: ids.locations.ikebukuro, service: ids.services.personal60, staff: ids.staff.aki, date: akiDay, time: '11:00', customer: ids.customers.repeater });
    // 新規 花子の体験(Mika の勤務日 火〜日 のうち明日以降で最も近い日)
    let mikaDay = addDays(today, 1);
    while (![2, 3, 4, 5, 6, 7].includes(wd(mikaDay))) mikaDay = addDays(mikaDay, 1);
    await book(q, { location: ids.locations.ikebukuro, service: ids.services.trial30, staff: ids.staff.mika, date: mikaDay, time: '15:00', customer: ids.customers.newbie });
    // 6名ヨガ(満席)… 翌日 19:00
    const tomorrow = addDays(today, 1);
    const extraNames = ['ヨガ 一', 'ヨガ 二', 'ヨガ 三', 'ヨガ 四'];
    const yogaCustomers = [ids.customers.planMember, ids.customers.expiring];
    for (const n of extraNames) {
      yogaCustomers.push(await insertCustomer(q, ids.orgId, { name: n, email: null, phone: null }, 'staff', null));
    }
    for (const c of yogaCustomers) {
      await book(q, { location: ids.locations.shinjuku, service: ids.services.yoga6, staff: ids.staff.ken, date: tomorrow, time: '19:00', customer: c });
    }
    // 今日の受付状況(来店待ち・来店済み・対応中)
    const todayBooking = (time: string, service: string, staff: string, location: string, customer: string) =>
      book(q, { location, service, staff, date: today, time, customer, force: true });
    const b1 = await todayBooking('16:00', ids.services.personal60, ids.staff.ken, ids.locations.shinjuku, ids.customers.lastOne);
    const b2 = await todayBooking('17:00', ids.services.trial30, ids.staff.mika, ids.locations.ikebukuro, ids.customers.noShow);
    const b3 = await todayBooking('18:00', ids.services.personal60, ids.staff.mika, ids.locations.ikebukuro, ids.customers.repeater);
    await changeStatus(q, deps, ids.orgId, actor, b2.id, 'arrived');
    await changeStatus(q, deps, ids.orgId, actor, b3.id, 'in_service');
    void b1;
  });
  await sampleExtras(pool, deps, ids, now);
  return ids;
}
