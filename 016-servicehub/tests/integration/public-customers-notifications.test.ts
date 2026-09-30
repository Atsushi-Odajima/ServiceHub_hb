import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '../../src/server/db/tx.js';
import type { Mailer, OutgoingMail } from '../../src/server/email/mailer.js';
import { runScheduler } from '../../src/server/jobs/scheduler.js';
import { processDueNotifications } from '../../src/server/jobs/worker.js';
import { addShift, at, type Catalog, idem, setupCatalog } from './catalog.js';
import { anonymous, type ApiSession, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

let t: TestContext;
let f: OrgFixture;
let owner: ApiSession;
let cat: Catalog;
const D = '2030-01-10';
let IKE = '';
let SHIN = '';

class FakeSmtp implements Mailer {
  readonly name = 'fake-smtp';
  readonly delivers = true;
  sent: OutgoingMail[] = [];
  failTimes = 0;
  async send(m: OutgoingMail) {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('SMTP 451 temporary failure');
    }
    this.sent.push(m);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

async function publicBook(body: Record<string, unknown> = {}, slug = f.slug, loc = 'ikebukuro') {
  const pub = anonymous(t.app);
  const svc = (body.serviceId as string) ?? cat.services.personal60;
  const av = await pub.get(`/api/v1/public/orgs/${slug}/locations/${loc}/availability?serviceId=${svc}&date=${D}`);
  if (av.status !== 200) throw new Error(JSON.stringify(av.body));
  t.clock.advanceMinutes(0.1); // フォームトークンの最短時間(3秒)を経過させる
  const res = await pub.post(`/api/v1/public/orgs/${slug}/locations/${loc}/bookings`, {
    serviceId: svc,
    staffId: null,
    startsAt: av.body.slots[0]?.startsAt,
    customer: { name: '山田 花子', nameKana: 'ヤマダ ハナコ', email: 'hanako@cust.example', phone: '090-1234-5678' },
    idempotencyKey: idem('pub'),
    formToken: av.body.formToken,
    agree: true,
    ...body,
  });
  return { res, av };
}

beforeAll(async () => {
  t = await makeTestContext({ now: '2030-01-07T00:00:00Z' });
  f = await createOrgFixture(t.pool);
  IKE = f.locations[0].id;
  SHIN = f.locations[1].id;
  owner = await login(t.app, f.users.owner.email, undefined, { remember: true });
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.mika, IKE, D, '09:00', '21:00');
  await addShift(owner, cat.staff.ken, SHIN, D, '09:00', '21:00');
  await owner.put(`/api/v1/services/${cat.services.personal60}/questions`, {
    questions: [
      { type: 'single_choice', label: 'ご来店は初めてですか', options: [{ id: 'first', label: '初めて' }, { id: 'repeat', label: '2回目以降' }], required: true },
      { type: 'confirm', label: 'キャンセル規定に同意します', required: true },
      { type: 'short_text', label: 'ご要望', required: false },
    ],
  });
});
afterAll(async () => {
  await t.close();
});

describe('Phase3: public booking', () => {
  it('org and location pages expose only public data', async () => {
    const pub = anonymous(t.app);
    const org = await pub.get(`/api/v1/public/orgs/${f.slug}`);
    expect(org.body.locations.map((l: any) => l.slug)).toEqual(['ikebukuro', 'shinjuku']);
    const loc = await pub.get(`/api/v1/public/orgs/${f.slug}/locations/shinjuku`);
    expect(loc.body.services.map((s: any) => s.name).sort()).toEqual(['30分体験', '60分パーソナル', '6名ヨガ']);
    expect(JSON.stringify(loc.body)).not.toContain('internal');
    expectError(await pub.get(`/api/v1/public/orgs/no-such-org`), 404);
  });

  it('full flow: availability → booking with question answers (snapshot) → manage link', async () => {
    const qs = (await anonymous(t.app).get(`/api/v1/public/orgs/${f.slug}/locations/ikebukuro/services/${cat.services.personal60}/questions`)).body.items;
    const answers = [
      { questionId: qs[0].id, value: 'first' },
      { questionId: qs[1].id, value: true },
      { questionId: qs[2].id, value: '肩こりが気になります' },
    ];
    const { res } = await publicBook({ answers });
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(res.body.manageUrl).toContain('/b/');
    // 質問を変更しても予約時点のスナップショットは変わらない
    await owner.put(`/api/v1/services/${cat.services.personal60}/questions`, {
      questions: [{ id: qs[0].id, type: 'single_choice', label: '変更後の質問文', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], required: true }],
    });
    const bookings = await owner.get(`/api/v1/bookings?code=${res.body.code}`);
    const detail = await owner.get(`/api/v1/bookings/${bookings.body.items[0].id}`);
    expect(detail.body.answers[0].question.label).toBe('ご来店は初めてですか');
    expect(detail.body.answers[0].answer).toBe('first');
    expect(detail.body.channel).toBe('public');
    // 管理リンク
    const view = await anonymous(t.app).get(`/api/v1/public/manage/${res.body.manageToken}`);
    expect(view.body.code).toBe(res.body.code);
    expect(view.body.canCancel).toBe(true);
    const ics = await anonymous(t.app).get(`/api/v1/public/manage/${res.body.manageToken}/ics`);
    expect(String(ics.body)).toContain('BEGIN:VEVENT');
  });

  it('required questions are enforced for public bookings', async () => {
    const { res } = await publicBook({ answers: [] });
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('bot protection: honeypot and too-fast form token are rejected', async () => {
    const pub = anonymous(t.app);
    const av = await pub.get(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/availability?serviceId=${cat.services.trial30}&date=${D}`);
    const base = {
      serviceId: cat.services.trial30,
      staffId: null,
      startsAt: av.body.slots[0].startsAt,
      customer: { name: 'ボット', email: 'bot@cust.example', phone: '0000000000' },
      idempotencyKey: idem('bot'),
      formToken: av.body.formToken,
      agree: true,
    };
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/bookings`, base), 400, 'VALIDATION_ERROR'); // 3秒未満
    t.clock.advanceMinutes(0.1);
    expectError(await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/bookings`, { ...base, website: 'http://spam' }), 400);
    const ok = await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/bookings`, base);
    expect(ok.status).toBe(200);
  });

  it('resending the same confirmation returns the same booking and manage token (idempotent)', async () => {
    const pub = anonymous(t.app);
    const av = await pub.get(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/availability?serviceId=${cat.services.trial30}&date=${D}`);
    t.clock.advanceMinutes(0.1);
    const body = {
      serviceId: cat.services.trial30,
      staffId: null,
      startsAt: av.body.slots[3].startsAt,
      customer: { name: '再送 太郎', email: 'resend@cust.example', phone: '09011112222' },
      idempotencyKey: idem('resend'),
      formToken: av.body.formToken,
      agree: true,
    };
    const r1 = await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/bookings`, body);
    const r2 = await pub.post(`/api/v1/public/orgs/${f.slug}/locations/shinjuku/bookings`, body);
    expect(r1.body.code).toBe(r2.body.code);
    expect(r2.body.manageToken).toBe(r1.body.manageToken);
    expect(r2.body.created).toBe(false);
  });

  it('manage link: reschedule and cancel before deadline; after deadline cancel is refused', async () => {
    const { res } = await publicBook({ serviceId: cat.services.trial30 }, f.slug, 'shinjuku');
    const token = res.body.manageToken;
    const av = await anonymous(t.app).get(`/api/v1/public/manage/${token}/availability?date=${D}`);
    const target = av.body.slots.find((s: any) => s.startsAt !== res.body.startsAt);
    const moved = await anonymous(t.app).post(`/api/v1/public/manage/${token}/reschedule`, { startsAt: target.startsAt });
    expect(moved.status).toBe(200);
    expect(moved.body.startsAt).toBe(target.startsAt);
    const canceled = await anonymous(t.app).post(`/api/v1/public/manage/${token}/cancel`, { reason: '体調不良' });
    expect(canceled.body.status).toBe('canceled_customer');
    // 締切後(24時間前を過ぎた)予約はWebキャンセル不可
    const { res: r2 } = await publicBook({ serviceId: cat.services.trial30 }, f.slug, 'shinjuku');
    const saved = t.clock.now();
    t.clock.set(new Date(new Date(r2.body.startsAt).getTime() - 2 * 3600_000));
    const late = await anonymous(t.app).post(`/api/v1/public/manage/${r2.body.manageToken}/cancel`, {});
    expectError(late, 409, 'INVALID_STATE');
    expect(late.body.error.message).toContain('締切');
    t.clock.set(saved);
  });

  it('invalid or unknown manage tokens reveal nothing', async () => {
    expectError(await anonymous(t.app).get('/api/v1/public/manage/short'), 404);
    expectError(await anonymous(t.app).get(`/api/v1/public/manage/${'x'.repeat(43)}`), 404);
  });
});

describe('Phase3: customers', () => {
  it('public booking links to existing customer only on email + name match; otherwise creates a duplicate candidate', async () => {
    const opt = (customer: Record<string, string>) => publicBook({ serviceId: cat.services.trial30, customer }, f.slug, 'shinjuku');
    const r1 = (await opt({ name: '佐藤 一郎', email: 'ichiro@cust.example', phone: '080-1111-2222' })).res;
    const r2 = (await opt({ name: '佐藤一郎', email: 'ICHIRO@cust.example', phone: '080-1111-2222' })).res;
    const r3 = (await opt({ name: '佐藤 次郎', email: 'ichiro@cust.example', phone: '080-1111-2222' })).res;
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    const b1 = (await owner.get(`/api/v1/bookings?code=${r1.body.code}`)).body.items[0];
    const b2 = (await owner.get(`/api/v1/bookings?code=${r2.body.code}`)).body.items[0];
    const b3 = (await owner.get(`/api/v1/bookings?code=${r3.body.code}`)).body.items[0];
    expect(b2.customerId).toBe(b1.customerId);
    expect(b3.customerId).not.toBe(b1.customerId);
    const c1 = await owner.get(`/api/v1/customers/${b1.customerId}`);
    expect(c1.body.duplicateCandidates.map((d: any) => d.id)).toContain(b3.customerId);
    // 自動統合はされていない
    expect((await owner.get(`/api/v1/customers/${b3.customerId}`)).body.status).toBe('active');
  });

  it('search by phone suffix, name prefix, kana, email', async () => {
    const c = (await owner.post('/api/v1/customers', { name: '高橋 美咲', nameKana: 'タカハシ ミサキ', email: 'misaki@cust.example', phone: '090-9876-5432' })).body;
    const hit = async (q: string) => (await owner.get(`/api/v1/customers?q=${encodeURIComponent(q)}`)).body.items.map((x: any) => x.id);
    expect(await hit('5432')).toContain(c.id);
    expect(await hit('090-9876')).toContain(c.id);
    expect(await hit('高橋')).toContain(c.id);
    expect(await hit('たかはし')).toContain(c.id);
    expect(await hit('タカハシ')).toContain(c.id);
    expect(await hit('misaki@')).toContain(c.id);
    expect(await hit('美咲')).toContain(c.id); // 部分一致フォールバック
  });

  it('#9 Reception cannot read or write confidential notes; timeline hides them', async () => {
    const c = (await owner.post('/api/v1/customers', { name: '機密 テスト' })).body;
    await owner.post(`/api/v1/customers/${c.id}/notes`, { body: '一般メモ', visibility: 'general' });
    await owner.post(`/api/v1/customers/${c.id}/notes`, { body: '機密メモ本文', visibility: 'confidential' });
    const rec = await login(t.app, f.users.reception.email);
    expectError(await rec.post(`/api/v1/customers/${c.id}/notes`, { body: 'x', visibility: 'confidential' }), 403, 'FORBIDDEN');
    const tl = await rec.get(`/api/v1/customers/${c.id}/timeline`);
    expect(tl.status).toBe(200);
    expect(JSON.stringify(tl.body)).not.toContain('機密メモ本文');
    expect(JSON.stringify(tl.body)).toContain('一般メモ');
    const ownerTl = await owner.get(`/api/v1/customers/${c.id}/timeline`);
    expect(JSON.stringify(ownerTl.body)).toContain('機密メモ本文');
  });

  it('location-scoped manager cannot see customers who only visit another location', async () => {
    const shinOnly = (await publicBook({ serviceId: cat.services.trial30, customer: { name: '新宿 だけ', email: 'shinonly@cust.example', phone: '0311112222' } }, f.slug, 'shinjuku')).res;
    const b = (await owner.get(`/api/v1/bookings?code=${shinOnly.body.code}`)).body.items[0];
    const mgr = await login(t.app, f.users.manager.email); // 池袋のみ
    expectError(await mgr.get(`/api/v1/customers/${b.customerId}`), 404);
    const list = await mgr.get(`/api/v1/customers?q=${encodeURIComponent('新宿')}`);
    expect(list.body.items.map((x: any) => x.id)).not.toContain(b.customerId);
    expect((await owner.get(`/api/v1/customers/${b.customerId}`)).status).toBe(200);
  });

  it('staff sees only customers they serve', async () => {
    const staff = await login(t.app, f.users.staff.email); // Aki
    const other = (await owner.post('/api/v1/customers', { name: '他担当 顧客' })).body;
    expectError(await staff.get(`/api/v1/customers/${other.id}`), 404);
    await addShift(owner, cat.staff.aki, IKE, '2030-01-11', '09:00', '18:00');
    const b = await owner.post('/api/v1/bookings', {
      locationId: IKE,
      serviceId: cat.services.personal60,
      staffId: cat.staff.aki,
      startsAt: at('2030-01-11', '10:00'),
      customer: { customerId: other.id },
      idempotencyKey: idem(),
    });
    expect(b.status).toBe(200);
    expect((await staff.get(`/api/v1/customers/${other.id}`)).status).toBe(200);
  });

  it('merge requires confirmation and moves bookings to the survivor with history', async () => {
    const a = (await owner.post('/api/v1/customers', { name: '統合 A', email: 'mergeA@cust.example' })).body;
    const b = (await owner.post('/api/v1/customers', { name: '統合 A', phone: '090-5555-6666' })).body;
    const bk = await owner.post('/api/v1/bookings', {
      locationId: IKE,
      serviceId: cat.services.trial30,
      staffId: cat.staff.mika,
      startsAt: at(D, '19:00'),
      customer: { customerId: b.id },
      idempotencyKey: idem(),
    });
    expectError(await owner.post(`/api/v1/customers/${a.id}/merge`, { mergeFromId: b.id }), 400);
    const m = await owner.post(`/api/v1/customers/${a.id}/merge`, { mergeFromId: b.id, confirm: true, reason: '同一人物' });
    expect(m.status).toBe(200);
    expect(m.body.moved.bookings).toBe(1);
    expect((await owner.get(`/api/v1/bookings/${bk.body.id}`)).body.customerId).toBe(a.id);
    const merged = await owner.get(`/api/v1/customers/${b.id}`);
    expect(merged.body.status).toBe('merged');
    expect(merged.body.mergedIntoId).toBe(a.id);
    const survivor = await owner.get(`/api/v1/customers/${a.id}`);
    expect(survivor.body.phone).toBe('090-5555-6666');
    const tl = await owner.get(`/api/v1/customers/${a.id}/timeline`);
    expect(tl.body.items.some((x: any) => x.kind === 'merge')).toBe(true);
    // 統合済み顧客では新規予約できない
    expectError(
      await owner.post('/api/v1/bookings', { locationId: IKE, serviceId: cat.services.trial30, staffId: cat.staff.mika, startsAt: at(D, '20:00'), customer: { customerId: b.id }, idempotencyKey: idem() }),
      409,
    );
  });

  it('anonymize removes personal data but keeps booking counts', async () => {
    const c = (await owner.post('/api/v1/customers', { name: '匿名 候補', email: 'anon@cust.example', phone: '09099990000' })).body;
    const free = await owner.get(`/api/v1/availability?locationId=${SHIN}&serviceId=${cat.services.trial30}&date=${D}`);
    const bk = await owner.post('/api/v1/bookings', { locationId: SHIN, serviceId: cat.services.trial30, staffId: null, startsAt: free.body.slots.at(-1).startsAt, customer: { customerId: c.id }, idempotencyKey: idem() });
    expect(bk.status).toBe(200);
    await owner.post(`/api/v1/bookings/${bk.body.id}/cancel`, { by: 'business' });
    expectError(await owner.post(`/api/v1/customers/${c.id}/anonymize`, { confirmName: '違う名前' }), 400);
    expect((await owner.post(`/api/v1/customers/${c.id}/anonymize`, { confirmName: '匿名 候補' })).status).toBe(200);
    const after = await owner.get(`/api/v1/customers/${c.id}`);
    expect(after.body.name).toBe('匿名化済み顧客');
    expect(after.body.email).toBeNull();
    expect(after.body.stats.total).toBe(1);
    const mgr = await login(t.app, f.users.manager.email);
    expectError(await mgr.post(`/api/v1/customers/${c.id}/anonymize`, { confirmName: 'x' }), 403);
  });

  it('customer update uses optimistic locking', async () => {
    const c = (await owner.post('/api/v1/customers', { name: '同時 更新' })).body;
    const [u1, u2] = await Promise.all([
      owner.patch(`/api/v1/customers/${c.id}`, { phone: '0901', expectedVersion: c.version }),
      owner.patch(`/api/v1/customers/${c.id}`, { phone: '0902', expectedVersion: c.version }),
    ]);
    expect([u1.status, u2.status].sort()).toEqual([200, 409]);
  });
});

describe('Phase3: notifications', () => {
  it('booking confirmation is queued once and processed; log provider marks as not delivered', async () => {
    const { res } = await publicBook({ serviceId: cat.services.trial30, customer: { name: '通知 確認', email: 'notify@cust.example', phone: '0900000001' } }, f.slug, 'shinjuku');
    expect(res.status).toBe(200);
    const b = (await owner.get(`/api/v1/bookings?code=${res.body.code}`)).body.items[0];
    // 他のテストが残した通知も含めてキューを処理し切る
    let claimed = 0;
    for (let i = 0; i < 50; i++) {
      const r = await processDueNotifications(t.deps, 100);
      claimed += r.claimed;
      if (r.claimed === 0) break;
    }
    expect(claimed).toBeGreaterThan(0);
    const rows = await withTenant(t.pool, { orgId: f.orgId }, (q) =>
      q.many<{ status: string; skip_reason: string | null; payload: any }>(`SELECT status, skip_reason, payload FROM notifications WHERE booking_id = $1`, [b.id]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('email_provider_log');
    expect(t.mailer.sent.some((m) => m.to === 'notify@cust.example' && m.subject.includes('ご予約を承りました'))).toBe(true);
    // 本文に管理リンク、DB(送信箱)にはトークンを保存していない
    const mail = t.mailer.sent.find((m) => m.to === 'notify@cust.example')!;
    expect(mail.text).toContain(res.body.manageToken);
    expect(JSON.stringify(rows[0].payload)).not.toContain(res.body.manageToken);
  });

  it('#17 running the scheduler/worker twice creates no duplicate reminders', async () => {
    const saved = t.clock.now();
    // 予約(1/10)の前日に時計を進める
    t.clock.set(at('2030-01-09', '12:00'));
    const s1 = await runScheduler(t.deps);
    const s2 = await runScheduler(t.deps);
    expect(s1.reminders).toBeGreaterThan(0);
    expect(s2.reminders).toBe(0);
    const dup = await withTenant(t.pool, { orgId: f.orgId }, (q) =>
      q.many<{ k: string; n: number }>(`SELECT idempotency_key AS k, count(*) AS n FROM notifications WHERE type = 'booking_reminder' GROUP BY 1 HAVING count(*) > 1`),
    );
    expect(dup).toHaveLength(0);
    await processDueNotifications(t.deps, 200);
    const second = await processDueNotifications(t.deps, 200);
    expect(second.claimed).toBe(0);
    t.clock.set(saved);
  });

  it('delivering mailer: sent status, retry with backoff, then failed after max attempts; manual retry re-queues same row', async () => {
    const smtp = new FakeSmtp();
    const deps = { ...t.deps, mailer: smtp };
    const id = await withTenant(t.pool, { orgId: f.orgId }, async (q) => {
      const r = await q.one<{ id: string }>(
        `INSERT INTO notifications (organization_id, type, recipient, payload, idempotency_key, max_attempts)
         VALUES ($1,'plan_expiring','retry@cust.example','{"planName":"月4回","endsOn":"2030-02-01"}',$2, 3) RETURNING id`,
        [f.orgId, idem('retry')],
      );
      return r.id;
    });
    smtp.failTimes = 10;
    await processDueNotifications(deps, 100);
    let row = await withSystem(t.pool, (q) => q.one<{ status: string; attempts: number; next_attempt_at: Date }>('SELECT status, attempts, next_attempt_at FROM notifications WHERE id = $1', [id]));
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(t.clock.now().getTime());
    for (let i = 0; i < 3; i++) {
      t.clock.advanceMinutes(61);
      await processDueNotifications(deps, 100);
    }
    row = await withSystem(t.pool, (q) => q.one('SELECT status, attempts, next_attempt_at FROM notifications WHERE id = $1', [id]));
    expect(row.status).toBe('failed');
    smtp.failTimes = 0;
    const retry = await owner.post(`/api/v1/notifications/${id}/retry`);
    expect(retry.status).toBe(200);
    await processDueNotifications(deps, 100);
    row = await withSystem(t.pool, (q) => q.one('SELECT status FROM notifications WHERE id = $1', [id]));
    expect(row.status).toBe('sent');
    expect(smtp.sent.filter((m) => m.to === 'retry@cust.example')).toHaveLength(1);
  });

  it('concurrent workers never send the same notification twice', async () => {
    const smtp = new FakeSmtp();
    const deps = { ...t.deps, mailer: smtp };
    await withTenant(t.pool, { orgId: f.orgId }, async (q) => {
      for (let i = 0; i < 30; i++) {
        await q.exec(
          `INSERT INTO notifications (organization_id, type, recipient, payload, idempotency_key) VALUES ($1,'plan_expiring',$2,'{"planName":"x","endsOn":"y"}',$3)`,
          [f.orgId, `w${i}@cust.example`, idem('w')],
        );
      }
    });
    await Promise.all([processDueNotifications(deps, 50), processDueNotifications(deps, 50), processDueNotifications(deps, 50)]);
    const tos = smtp.sent.map((m) => m.to);
    expect(new Set(tos).size).toBe(tos.length);
    expect(tos.filter((x) => /^w\d+@/.test(x))).toHaveLength(30);
  });

  it('sample organizations never deliver email', async () => {
    const smtp = new FakeSmtp();
    const deps = { ...t.deps, mailer: smtp };
    const sample = await createOrgFixture(t.pool);
    await withSystem(t.pool, (q) => q.exec('UPDATE organizations SET is_sample = true WHERE id = $1', [sample.orgId]));
    await withTenant(t.pool, { orgId: sample.orgId }, (q) =>
      q.exec(`INSERT INTO notifications (organization_id, type, recipient, payload, idempotency_key) VALUES ($1,'plan_expiring','real@person.example','{}',$2)`, [
        sample.orgId,
        idem('sample'),
      ]),
    );
    await processDueNotifications(deps, 100);
    expect(smtp.sent.find((m) => m.to === 'real@person.example')).toBeUndefined();
    const row = await withTenant(t.pool, { orgId: sample.orgId }, (q) => q.one<{ status: string; skip_reason: string }>(`SELECT status, skip_reason FROM notifications WHERE recipient = 'real@person.example'`));
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'sample_org' });
  });

  it('notification history masks recipients and hides bodies', async () => {
    const r = await owner.get('/api/v1/notifications');
    expect(r.status).toBe(200);
    expect(r.body.items.every((n: any) => !n.recipient || n.recipient.includes('***'))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('/b/');
    const rec = await login(t.app, f.users.reception.email);
    expectError(await rec.get('/api/v1/notifications'), 403);
  });
});
