/**
 * 環境変数の読み込み(デプロイ先で起動できなくならないこと)
 * - docker compose の `${X:-}` やホスティング画面の空欄(空文字)は未設定として扱う
 * - Render では APP_BASE_URL を省略すると RENDER_EXTERNAL_URL を使う。本番で公開URLが無ければ分かる言葉で止める
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/servicehub', SESSION_SECRET: 'x'.repeat(40) };

describe('loadConfig', () => {
  it('空文字の任意項目は未設定として扱う(暗号化キー・SMTP・Turnstile など)', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://reserve.example.com',
      BACKUP_ENCRYPTION_KEY: '',
      SMTP_URL: '',
      TURNSTILE_SITE_KEY: '',
      EMAIL_FROM: '',
      LOG_LEVEL: '',
      TRUST_PROXY: '',
    });
    expect(c.BACKUP_ENCRYPTION_KEY).toBeUndefined();
    expect(c.SMTP_URL).toBeUndefined();
    expect(c.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(c.EMAIL_FROM).toBe('ServiceHub <no-reply@example.invalid>');
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.TRUST_PROXY).toBe(false);
    expect(c.cookieSecure).toBe(true);
  });

  it('設定された暗号化キーが短すぎれば起動しない', () => {
    expect(() => loadConfig({ ...base, BACKUP_ENCRYPTION_KEY: 'short' })).toThrow(/BACKUP_ENCRYPTION_KEY/);
  });

  it('APP_BASE_URL 末尾の / は取り除く(メールのリンクが // にならない)', () => {
    expect(loadConfig({ ...base, APP_BASE_URL: 'https://reserve.example.com/' }).APP_BASE_URL).toBe('https://reserve.example.com');
  });

  it('Render: APP_BASE_URL が無ければ RENDER_EXTERNAL_URL を使う。明示した APP_BASE_URL が優先', () => {
    const r = loadConfig({ ...base, NODE_ENV: 'production', APP_BASE_URL: '', RENDER_EXTERNAL_URL: 'https://servicehub-abcd.onrender.com' });
    expect(r.APP_BASE_URL).toBe('https://servicehub-abcd.onrender.com');
    expect(r.cookieSecure).toBe(true);
    const own = loadConfig({ ...base, NODE_ENV: 'production', APP_BASE_URL: 'https://reserve.example.com', RENDER_EXTERNAL_URL: 'https://servicehub-abcd.onrender.com' });
    expect(own.APP_BASE_URL).toBe('https://reserve.example.com');
  });

  it('本番で公開URLが分からなければ起動しない(開発では localhost)', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/APP_BASE_URL/);
    expect(loadConfig({ ...base }).APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('本番で SESSION_SECRET が見本のままなら起動しない', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_BASE_URL: 'https://a.example.com', SESSION_SECRET: 'change-me-to-a-long-random-string-at-least-32-chars' })).toThrow(/SESSION_SECRET/);
  });
});
