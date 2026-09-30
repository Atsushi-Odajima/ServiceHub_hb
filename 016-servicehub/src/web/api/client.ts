export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: any;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get fields(): Record<string, string> {
    return (this.details && typeof this.details === 'object' && this.details.fields) || {};
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown, extraHeaders: Record<string, string> = {}, raw = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'サーバーに接続できません。通信状態を確認してください。操作は完了していません。');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = data && typeof data === 'object' ? data.error : null;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `エラーが発生しました (${res.status})`, e?.details);
  }
  // API は必ず JSON を返す。HTML 等(誤ったURL・プロキシのエラーページ)をデータとして扱わない
  if (url.startsWith('/api/') && text && typeof data !== 'object' && !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new ApiError(502, 'BAD_RESPONSE', 'サーバーから予期しない応答がありました。時間をおいて再度お試しください。');
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  /** ファイル本体をそのまま送る(バックアップの検証・復元) */
  upload: <T = any>(url: string, file: Blob) => request<T>('POST', url, file, { 'Content-Type': 'application/octet-stream' }, true),
};

/** クエリ文字列の組み立て(undefined/null/'' は除外) */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** 冪等キー(確定操作の再送・二重タップ対策) */
export function newIdempotencyKey(prefix = 'k'): string {
  const rand = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
