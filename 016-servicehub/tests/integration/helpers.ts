import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/server/app.js';
import { hashPassword } from '../../src/server/auth/crypto.js';
import { loadConfig } from '../../src/server/config.js';
import { createPool } from '../../src/server/db/pool.js';
import { withSystem } from '../../src/server/db/tx.js';
import { FakeClock, type Deps } from '../../src/server/deps.js';
import { LogMailer } from '../../src/server/email/mailer.js';
import { TEST_DATABASE_URL } from './global-setup.js';

export const TEST_PASSWORD = 'correct-horse-battery';
export const TEST_ORIGIN = 'http://localhost:3000';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

export interface TestContext {
  app: FastifyInstance;
  pool: pg.Pool;
  clock: FakeClock;
  mailer: LogMailer;
  deps: Deps;
  close(): Promise<void>;
}

export async function makeTestContext(opts: { now?: string; env?: Record<string, string> } = {}): Promise<TestContext> {
  process.env.SCRYPT_N_OVERRIDE = '1024';
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: 'test-session-secret-0123456789abcdefghijklmnop',
    LOG_LEVEL: 'silent',
    APP_BASE_URL: TEST_ORIGIN,
    LOGIN_RATE_LIMIT_PER_15MIN: '1000',
    PUBLIC_RATE_LIMIT_PER_MIN: '10000',
    ...opts.env,
  });
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 25 });
  const clock = new FakeClock(opts.now ?? '2030-01-07T00:00:00Z');
  const mailer = new LogMailer(false);
  const deps: Deps = { pool, config, clock, mailer, log: silent };
  const app = await buildApp(deps, { serveStatic: false, logger: false });
  return {
    app,
    pool,
    clock,
    mailer,
    deps,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export class ApiSession {
  constructor(
    private readonly app: FastifyInstance,
    public cookie: string | null,
    public csrf: string | null,
  ) {}

  async request<T = any>(method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { origin: TEST_ORIGIN, ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({ method: method as any, url, payload: payload as any, headers });
    let body: any = res.body;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      // non-JSON (CSV 等)
    }
    return { status: res.statusCode, body, headers: res.headers as Record<string, unknown> };
  }
  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, body?: unknown) {
    return this.request<T>('POST', url, body ?? {});
  }
  patch<T = any>(url: string, body?: unknown) {
    return this.request<T>('PATCH', url, body ?? {});
  }
  put<T = any>(url: string, body?: unknown) {
    return this.request<T>('PUT', url, body ?? {});
  }
  delete<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }
}

export function anonymous(app: FastifyInstance): ApiSession {
  return new ApiSession(app, null, null);
}

export async function login(app: FastifyInstance, email: string, password = TEST_PASSWORD, extra: Record<string, unknown> = {}): Promise<ApiSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password, ...extra },
    headers: { origin: TEST_ORIGIN },
  });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  const cookie = raw.split(';')[0];
  return new ApiSession(app, cookie, JSON.parse(res.body).csrfToken);
}

let cachedHash: string | null = null;
async function testHash(): Promise<string> {
  process.env.SCRYPT_N_OVERRIDE = '1024';
  if (!cachedHash) cachedHash = await hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export interface OrgFixture {
  orgId: string;
  slug: string;
  suffix: string;
  locations: { id: string; slug: string; name: string }[];
  users: Record<'owner' | 'manager' | 'staff' | 'reception', { email: string; userId: string; membershipId: string }>;
  staffIds: string[];
}

/**
 * 組織 + 2拠点 + 4ロールのユーザーを作成。
 * manager/reception は拠点1のみ担当。staff はスタッフ「Aki」(両拠点所属)に紐付く。
 */
export async function createOrgFixture(pool: pg.Pool, opts: { name?: string; timezone?: string } = {}): Promise<OrgFixture> {
  const suffix = randomBytes(4).toString('hex');
  const slug = `org-${suffix}`;
  const hash = await testHash();
  return withSystem(pool, async (q) => {
    const org = await q.one<{ id: string }>(
      'INSERT INTO organizations (slug, name, timezone) VALUES ($1,$2,$3) RETURNING id',
      [slug, opts.name ?? `Test Org ${suffix}`, opts.timezone ?? 'Asia/Tokyo'],
    );
    const locations: OrgFixture['locations'] = [];
    for (const [i, name] of ['池袋店', '新宿店'].entries()) {
      const l = await q.one<{ id: string }>(
        `INSERT INTO locations (organization_id, slug, name, timezone, min_notice_min, max_advance_days, sort_order)
         VALUES ($1,$2,$3,$4,0,90,$5) RETURNING id`,
        [org.id, i === 0 ? 'ikebukuro' : 'shinjuku', name, opts.timezone ?? 'Asia/Tokyo', i],
      );
      locations.push({ id: l.id, slug: i === 0 ? 'ikebukuro' : 'shinjuku', name });
      for (let wd = 1; wd <= 7; wd++) {
        await q.exec(
          `INSERT INTO location_hours (organization_id, location_id, weekday, open_time, close_time) VALUES ($1,$2,$3,'09:00','21:00')`,
          [org.id, l.id, wd],
        );
      }
    }
    const aki = await q.one<{ id: string }>(`INSERT INTO staff (organization_id, display_name) VALUES ($1,'Aki') RETURNING id`, [org.id]);
    for (const l of locations) {
      await q.exec('INSERT INTO staff_locations (organization_id, staff_id, location_id) VALUES ($1,$2,$3)', [org.id, aki.id, l.id]);
    }
    const users = {} as OrgFixture['users'];
    for (const role of ['owner', 'manager', 'staff', 'reception'] as const) {
      const email = `${role}+${suffix}@test.example`;
      const u = await q.one<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1,$1,$2,$3) RETURNING id`,
        [email, hash, `${role}-${suffix}`],
      );
      const m = await q.one<{ id: string }>(
        `INSERT INTO memberships (organization_id, user_id, role, all_locations, staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org.id, u.id, role, role === 'owner', role === 'staff' ? aki.id : null],
      );
      if (role === 'manager' || role === 'reception') {
        await q.exec('INSERT INTO membership_locations (organization_id, membership_id, location_id) VALUES ($1,$2,$3)', [
          org.id,
          m.id,
          locations[0].id,
        ]);
      }
      if (role === 'staff') {
        for (const l of locations) {
          await q.exec('INSERT INTO membership_locations (organization_id, membership_id, location_id) VALUES ($1,$2,$3)', [org.id, m.id, l.id]);
        }
      }
      users[role] = { email, userId: u.id, membershipId: m.id };
    }
    return { orgId: org.id, slug, suffix, locations, users, staffIds: [aki.id] };
  });
}

export function expectError(res: ApiResponse, status: number, code?: string): void {
  if (res.status !== status || (code && res.body?.error?.code !== code)) {
    throw new Error(`expected ${status}${code ? ' ' + code : ''} but got ${res.status}: ${JSON.stringify(res.body)}`);
  }
}
