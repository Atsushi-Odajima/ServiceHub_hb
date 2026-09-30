/**
 * 公開予約・キャンセル待ちの bot 対策(Cloudflare Turnstile。任意)
 * - サイトキーとシークレットキーを設定すると、公開ページの設定(/public/config)でサイトキーを返し、
 *   送信時にトークンをサーバーで検証する(検証先はテスト用のサーバーに差し替え)
 * - トークンなし・検証に失敗したトークンでは予約できない。検証に成功すれば予約できる
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addShift, type Catalog, idem, setupCatalog } from './catalog.js';
import { anonymous, createOrgFixture, login, makeTestContext, type OrgFixture, type TestContext } from './helpers.js';

const D = '2030-01-10';
let t: TestContext;
let f: OrgFixture;
let cat: Catalog;
let verify: Server;
const seen: { secret: string | null; response: string | null }[] = [];

beforeAll(async () => {
  // Cloudflare の siteverify の代わり: good-token だけ成功
  verify = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      seen.push({ secret: p.get('secret'), response: p.get('response') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: p.get('secret') === 'test-secret' && p.get('response') === 'good-token' }));
    });
  });
  await new Promise<void>((r) => verify.listen(0, '127.0.0.1', () => r()));
  const port = (verify.address() as AddressInfo).port;
  t = await makeTestContext({
    now: '2030-01-07T00:00:00Z',
    env: { TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_VERIFY_URL: `http://127.0.0.1:${port}/siteverify` },
  });
  f = await createOrgFixture(t.pool);
  const owner = await login(t.app, f.users.owner.email);
  cat = await setupCatalog(owner, f);
  await addShift(owner, cat.staff.mika, f.locations[0].id, D, '09:00', '21:00');
});

afterAll(async () => {
  await t.close();
  await new Promise((r) => verify.close(r));
});

async function book(turnstileToken: string | undefined, email: string) {
  const pub = anonymous(t.app);
  const base = `/api/v1/public/orgs/${f.slug}/locations/ikebukuro`;
  const av = await pub.get(`${base}/availability?serviceId=${cat.services.trial30}&date=${D}`);
  expect(av.status).toBe(200);
  t.clock.advanceMinutes(0.1);
  return pub.post(`${base}/bookings`, {
    serviceId: cat.services.trial30,
    staffId: null,
    startsAt: av.body.slots[0].startsAt,
    customer: { name: '確認 太郎', email, phone: '090-1111-2222' },
    idempotencyKey: idem('ts'),
    formToken: av.body.formToken,
    agree: true,
    ...(turnstileToken !== undefined ? { turnstileToken } : {}),
  });
}

describe('Turnstile', () => {
  it('公開ページの設定でサイトキーを返す(シークレットは返さない)', async () => {
    const r = await anonymous(t.app).get('/api/v1/public/config');
    expect(r.body).toEqual({ turnstileSiteKey: 'test-site-key' });
  });

  it('トークンなし・検証に失敗したトークンでは予約できず、成功したトークンなら予約できる', async () => {
    const none = await book(undefined, 'ts-none@cust.example');
    expect(none.status).toBe(400);
    expect(none.body.error.message).toContain('確認に失敗');
    const bad = await book('bad-token', 'ts-bad@cust.example');
    expect(bad.status).toBe(400);
    const good = await book('good-token', 'ts-good@cust.example');
    expect(good.status).toBe(200);
    expect(good.body.code).toBeTruthy();
    // サーバーはシークレットと受け取ったトークンで検証している(トークンなしのときは問い合わせない)
    expect(seen).toEqual([
      { secret: 'test-secret', response: 'bad-token' },
      { secret: 'test-secret', response: 'good-token' },
    ]);
  });

  it('キャンセル待ちの登録もトークンを検証する', async () => {
    const pub = anonymous(t.app);
    const base = `/api/v1/public/orgs/${f.slug}/locations/ikebukuro`;
    const tok = await pub.get(`${base}/form-token`);
    t.clock.advanceMinutes(0.1);
    const body = (turnstileToken?: string) => ({
      serviceId: cat.services.personal60,
      dateFrom: D,
      dateTo: D,
      customer: { name: '待機 花子', email: `ts-wait-${turnstileToken ?? 'none'}@cust.example`, phone: '090-3333-4444' },
      formToken: tok.body.formToken,
      agree: true,
      ...(turnstileToken ? { turnstileToken } : {}),
    });
    expect((await pub.post(`${base}/waitlist`, body())).status).toBe(400);
    expect((await pub.post(`${base}/waitlist`, body('good-token'))).status).toBe(200);
  });
});
