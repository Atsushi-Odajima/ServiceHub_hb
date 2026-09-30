import { expect, type Page, request as pwRequest } from '@playwright/test';
import { E2E } from './env';

export function todayJst(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** JST の日付と時刻から ISO(UTC)を作る */
export function jstIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/app(\/|$|\?)/);
}

export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible();
}

export interface ApiClient {
  get<T = any>(url: string): Promise<T>;
  post<T = any>(url: string, data?: unknown): Promise<T>;
  patch<T = any>(url: string, data?: unknown): Promise<T>;
  dispose(): Promise<void>;
}

/**
 * 前提データの準備用(検証対象の操作は画面で行う)。
 * 画面と同じ認証・CSRF・Origin 検査を通る。
 */
export async function apiAs(email: string, password: string): Promise<ApiClient> {
  const req = await pwRequest.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { origin: E2E.baseUrl } });
  const r = await req.post('/api/v1/auth/login', { data: { email, password } });
  if (!r.ok()) throw new Error(`login failed ${r.status()} ${await r.text()}`);
  const csrf = (await r.json()).csrfToken as string;
  const check = async (res: Awaited<ReturnType<typeof req.get>>) => {
    if (!res.ok()) throw new Error(`${res.url()} ${res.status()} ${await res.text()}`);
    return res.json();
  };
  return {
    get: async (url) => check(await req.get(url)),
    post: async (url, data = {}) => check(await req.post(url, { data, headers: { 'x-csrf-token': csrf } })),
    patch: async (url, data = {}) => check(await req.patch(url, { data, headers: { 'x-csrf-token': csrf } })),
    dispose: () => req.dispose(),
  };
}

let seq = 0;
export function idem(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 1=月 … 7=日 */
export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

export interface SampleRefs {
  ikebukuro: string;
  shinjuku: string;
  personal60: string;
  aki: string;
  mika: string;
  ken: string;
}

export async function sampleRefs(api: ApiClient): Promise<SampleRefs> {
  const locs = (await api.get('/api/v1/locations')).items as { id: string; slug: string }[];
  const services = (await api.get('/api/v1/services')).items as { id: string; name: string }[];
  const staff = (await api.get('/api/v1/staff')).items as { id: string; displayName: string }[];
  const find = <T,>(list: T[], pred: (x: T) => boolean, what: string) => {
    const x = list.find(pred);
    if (!x) throw new Error(`sample ${what} not found`);
    return x;
  };
  return {
    ikebukuro: find(locs, (l) => l.slug === 'ikebukuro', 'location').id,
    shinjuku: find(locs, (l) => l.slug === 'shinjuku', 'location').id,
    personal60: find(services, (s) => s.name === '60分パーソナル', 'service').id,
    aki: find(staff, (s) => s.displayName === 'Aki', 'staff').id,
    mika: find(staff, (s) => s.displayName === 'Mika', 'staff').id,
    ken: find(staff, (s) => s.displayName === 'Ken', 'staff').id,
  };
}
