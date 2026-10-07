/**
 * ReserveFlow(#015)から統合した機能:
 * 店舗宛て通知 / 全サービス共通の事前質問 / 予約管理リンクの再発行・無効化 / 変更締切 /
 * 電話番号の要否・同意文・完了メッセージ / 受付方法 / 予約CSVの回答列 / 予約の一括 .ics 出力
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tx.js';
import { processDueNotifications } from '../../src/server/jobs/worker.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { anonymous, type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let cat: Catalog;
const D = '2030-01-10';
let IKE = '';
const OWNER_MAIL = 'shop-owner@shop.example';

async function publicBook(body: Record<string, any> = {}) {
  const pub = anonymous(t.app);
  const svc = body.serviceId ?? cat.services.personal60;
  const av = await pub.get(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro/availability?serviceId=${svc}&date=${D}`);
  if (av.status !== 200) throw new Error(JSON.stringify(av.body));
  t.clock.advanceMinutes(0.1);
  const { customer, slotIndex, ...rest } = body;
  if (!av.body.slots[slotIndex ?? 0]) throw new Error(`slot ${slotIndex ?? 0} not available (${av.body.slots.length} slots)`);
  return pub.post(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro/bookings`, {
    serviceId: svc,
    staffId: null,
    startsAt: av.body.slots[slotIndex ?? 0]?.startsAt,
    customer: { name: '統合 太郎', email: 'merge@cust.example', phone: '090-1111-2222', ...customer },
    idempotencyKey: idem('pub'),
    formToken: av.body.formToken,
    agree: true,
    ...rest,
  });
}

async function drainMail() {
  for (let i = 0; i < 50; i++) {
    const r = await processDueNotifications(t.deps, 100);
    if (r.claimed === 0) break;
  }
}

async function notificationsFor(bookingId: string) {
  return withTenant(t.pool, { orgId: f.orgId }, (q) =>
    q.many<{ type: string; recipient: string | null }>('SELECT type, recipient FROM notifications WHERE booking_id = $1 ORDER BY created_at, id', [bookingId]),
  );
}

async function bookingIdOf(code: string): Promise<string> {
  return (await owner.get(`/api/v1/bookings?code=${code}`)).body.items[0].id;
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  owner = await login(t.app, f.users.owner.email, undefined, { remember: true });
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '21:00');
  const r = await owner.patch('/api/v1/org', { settings: { ownerNotifications: { email: OWNER_MAIL }, emailSignature: 'サンプル整体院\n03-0000-0000' } });
  expect(r.status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('ReserveFlow merge: owner notifications', () => {
  it('public booking, customer reschedule and customer cancel notify the shop; staff bookings do not', async () => {
    const res = await publicBook();
    expect(res.status).toBe(200);
    const id = await bookingIdOf(res.body.code);
    expect((await notificationsFor(id)).map((n) => [n.type, n.recipient])).toEqual([
      ['booking_confirmed', 'merge@cust.example'],
      ['owner_booking_created', OWNER_MAIL],
    ]);

    // お客様による日時変更・キャンセル
    const tok = res.body.manageToken;
    const slots = (await anonymous(t.app).get(`/api/v1/public/manage/${tok}/availability?date=${D}`)).body.slots;
    expect((await anonymous(t.app).post(`/api/v1/public/manage/${tok}/reschedule`, { startsAt: slots[3].startsAt })).status).toBe(200);
    expect((await anonymous(t.app).post(`/api/v1/public/manage/${tok}/cancel`, { reason: '都合が悪くなりました' })).status).toBe(200);
    const types = (await notificationsFor(id)).map((n) => n.type);
    expect(types).toContain('owner_booking_changed');
    expect(types).toContain('owner_booking_canceled');

    await drainMail();
    const ownerMails = t.mailer.sent.filter((m) => m.to === OWNER_MAIL);
    expect(ownerMails.some((m) => m.subject.includes('新しいWeb予約') && m.text.includes('090-1111-2222'))).toBe(true);
    expect(ownerMails.some((m) => m.subject.includes('お客様によるキャンセル') && m.text.includes('都合が悪くなりました'))).toBe(true);
    // お客様宛てメールには署名が入る。店舗宛てには入らない
    expect(t.mailer.sent.find((m) => m.to === 'merge@cust.example')!.text).toContain('サンプル整体院');
    expect(ownerMails[0].text).not.toContain('サンプル整体院');

    // スタッフが登録した予約・スタッフ操作のキャンセルでは店舗へ通知しない
    const staffB = await owner.post('/api/v1/bookings', {
      locationId: IKE,
      serviceId: cat.services.personal60,
      startsAt: at(D, '15:00'),
      customer: { name: '電話 予約', phone: '0300000000' },
      sourceDetail: 'phone',
      idempotencyKey: idem('adm'),
    });
    expect(staffB.status).toBe(200);
    expect(staffB.body.sourceDetail).toBe('phone');
    await owner.post(`/api/v1/bookings/${staffB.body.id}/cancel`, { by: 'customer', reason: '電話でキャンセル' });
    expect((await notificationsFor(staffB.body.id)).filter((n) => n.type.startsWith('owner_'))).toEqual([]);
  });

  it('can be turned off per type', async () => {
    await owner.patch('/api/v1/org', { settings: { ownerNotifications: { email: OWNER_MAIL, bookingCreated: false } } });
    const res = await publicBook({ slotIndex: 6 });
    expect(res.status).toBe(200);
    const types = (await notificationsFor(await bookingIdOf(res.body.code))).map((n) => n.type);
    expect(types).not.toContain('owner_booking_created');
    await owner.patch('/api/v1/org', { settings: { ownerNotifications: { email: OWNER_MAIL, bookingCreated: true } } });
  });
});

describe('ReserveFlow merge: waitlist alert to the shop', () => {
  it('customer cancel that frees a slot matching a waitlist entry notifies the shop', async () => {
    // 1人用サービス(担当1名)で 18:00 の枠を予約で埋め、同じ時間帯のキャンセル待ちを登録
    const res = await publicBook({ slotIndex: 0, serviceId: cat.services.trial30 });
    expect(res.status).toBe(200);
    const start = new Date(res.body.startsAt);
    const hm = (d: Date) => d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    const hhmm = hm(start);
    const until = hm(new Date(start.getTime() + 30 * 60_000));
    const w = await owner.post('/api/v1/customers', { name: 'キャンセル待ち 次郎', phone: '0901234000' });
    expect(w.status).toBe(200);
    const entry = await owner.post('/api/v1/waitlist', {
      customer: { customerId: w.body.id },
      locationId: IKE,
      serviceId: cat.services.trial30,
      dateFrom: D,
      dateTo: D,
      timeFrom: hhmm,
      timeTo: until,
      partySize: 1,
    });
    expect(entry.status).toBe(200);
    expect((await anonymous(t.app).post(`/api/v1/public/manage/${res.body.manageToken}/cancel`, {})).status).toBe(200);
    const id = await bookingIdOf(res.body.code);
    const owners = (await notificationsFor(id)).filter((n) => n.type === 'owner_waitlist_opening');
    expect(owners).toEqual([{ type: 'owner_waitlist_opening', recipient: OWNER_MAIL }]);
  });
});

describe('ReserveFlow merge: common questions', () => {
  it('org-wide questions are shown before service questions and validated', async () => {
    expect((await owner.put('/api/v1/common-questions', { questions: [{ type: 'yes_no', label: '駐車場を利用しますか', required: true }] })).status).toBe(200);
    await owner.put(`/api/v1/services/${cat.services.personal60}/questions`, { questions: [{ type: 'short_text', label: '気になる部位', required: false }] });
    const items = (await anonymous(t.app).get(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro/services/${cat.services.personal60}/questions`)).body.items;
    expect(items.map((x: any) => x.label)).toEqual(['駐車場を利用しますか', '気になる部位']);
    // 他のサービスでも共通の質問が出る
    const trial = (await anonymous(t.app).get(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro/services/${cat.services.trial30}/questions`)).body.items;
    expect(trial.map((x: any) => x.label)).toContain('駐車場を利用しますか');
    // 必須の共通質問に未回答なら予約できない
    expectError(await publicBook({ slotIndex: 8 }), 400, 'VALIDATION_ERROR');
    const ok = await publicBook({ slotIndex: 8, answers: [{ questionId: items[0].id, value: true }] });
    expect(ok.status).toBe(200);
    // 回答は予約管理ページと予約CSVに出る
    const view = (await anonymous(t.app).get(`/api/v1/public/manage/${ok.body.manageToken}`)).body;
    expect(view.answers).toEqual([{ label: '駐車場を利用しますか', value: 'はい' }]);
    const csv = (await owner.get(`/api/v1/csv/export/bookings?from=${D}&to=${D}`)).body as string;
    expect(csv).toContain('事前質問の回答');
    expect(csv).toContain('駐車場を利用しますか: はい');
    expect(csv).toContain('受付方法');
    expect(csv).toContain('電話');
    // 共通の質問の編集はサービスの質問に影響しない
    expect((await owner.get('/api/v1/common-questions')).body.questions).toHaveLength(1);
    expect((await owner.get(`/api/v1/services/${cat.services.personal60}`)).body.questions.map((x: any) => x.label)).toEqual(['気になる部位']);
    await owner.put('/api/v1/common-questions', { questions: [] });
  });
});

describe('ReserveFlow merge: manage link reissue / revoke', () => {
  it('reissue invalidates the old link; revoke disables it; email resend carries the new link', async () => {
    const res = await publicBook({ slotIndex: 10 });
    const id = await bookingIdOf(res.body.code);
    const old = res.body.manageToken;
    const r1 = await owner.post(`/api/v1/bookings/${id}/manage-link`, { action: 'reissue', sendEmail: true });
    expect(r1.status).toBe(200);
    const newTok = r1.body.manageUrl.split('/b/')[1];
    expect(newTok).not.toBe(old);
    expectError(await anonymous(t.app).get(`/api/v1/public/manage/${old}`), 404);
    expect((await anonymous(t.app).get(`/api/v1/public/manage/${newTok}`)).status).toBe(200);
    await drainMail();
    const resend = t.mailer.sent.find((m) => m.subject.includes('確認・変更用リンク'));
    expect(resend?.text).toContain(newTok);
    // 同じ冪等キーの再送では最新のリンクを返す
    const detail = (await owner.get(`/api/v1/bookings/${id}`)).body;
    expect(detail.manageLink).toMatchObject({ available: true, active: true });

    const r2 = await owner.post(`/api/v1/bookings/${id}/manage-link`, { action: 'revoke' });
    expect(r2.body.manageUrl).toBeNull();
    expectError(await anonymous(t.app).get(`/api/v1/public/manage/${newTok}`), 404);
    expect((await owner.get(`/api/v1/bookings/${id}`)).body.manageLink.active).toBe(false);
    const events = (await owner.get(`/api/v1/bookings/${id}`)).body.events.map((e: any) => e.type);
    expect(events).toEqual(expect.arrayContaining(['manage_link_reissued', 'manage_link_revoked']));
  });
});

describe('ReserveFlow merge: booking page options', () => {
  it('change deadline separate from cancel deadline', async () => {
    await owner.patch(`/api/v1/locations/${IKE}`, { bookingPage: { changeDeadlineHours: 48 } });
    const res = await publicBook({ slotIndex: 5 });
    const start = new Date(res.body.startsAt).getTime();
    t.clock.set(new Date(start - 36 * 3600_000).toISOString());
    const view = (await anonymous(t.app).get(`/api/v1/public/manage/${res.body.manageToken}`)).body;
    expect(view.canReschedule).toBe(false);
    expect(view.changeDeadlinePassed).toBe(true);
    expect(view.canCancel).toBe(true);
    expectError(await anonymous(t.app).post(`/api/v1/public/manage/${res.body.manageToken}/reschedule`, { startsAt: res.body.startsAt }), 409);
    t.clock.set('2030-01-07T00:00:00Z');
    await owner.patch(`/api/v1/locations/${IKE}`, { bookingPage: { changeDeadlineHours: null } });
  });

  it('phone requirement, completion message and notes', async () => {
    await owner.patch(`/api/v1/locations/${IKE}`, { bookingPage: { phoneRequirement: 'required' } });
    const noPhone = await publicBook({ slotIndex: 1, customer: { phone: '' } });
    expectError(noPhone, 400, 'VALIDATION_ERROR');
    expect(noPhone.body.error.message).toBe('電話番号を入力してください');
    const r0 = await owner.patch(`/api/v1/locations/${IKE}`, {
      bookingPage: { phoneRequirement: 'optional', completionMessage: 'ご来店をお待ちしております', notes: '動きやすい服装でお越しください', consentText: '規約に同意します', websiteUrl: 'https://shop.example' },
    });
    expect(r0.status).toBe(200);
    const loc = (await anonymous(t.app).get(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro`)).body;
    expect(loc.location.page).toMatchObject({ phoneRequirement: 'optional', consentText: '規約に同意します', websiteUrl: 'https://shop.example' });
    const ok = await publicBook({ slotIndex: 1, customer: { phone: '', email: 'nophone@cust.example' } });
    expect(ok.status).toBe(200);
    expect(ok.body.completionMessage).toBe('ご来店をお待ちしております');
    await drainMail();
    expect(t.mailer.sent.find((m) => m.to === 'nophone@cust.example')!.text).toContain('動きやすい服装でお越しください');
    // javascript: など http(s) 以外のURLは保存できない
    expectError(await owner.patch(`/api/v1/locations/${IKE}`, { bookingPage: { snsUrl: 'javascript:alert(1)' } }), 400);
  });
});

describe('ReserveFlow merge: bulk calendar export', () => {
  it('exports active bookings in the period as one .ics', async () => {
    const r = await owner.get(`/api/v1/export/bookings.ics?from=${D}&to=${D}`);
    expect(r.status).toBe(200);
    const body = String(r.body);
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(body).not.toContain('電話 予約'); // キャンセル済みは含めない
    expectError(await owner.get(`/api/v1/export/bookings.ics?from=${D}&to=2029-01-01`), 400);
  });
});
