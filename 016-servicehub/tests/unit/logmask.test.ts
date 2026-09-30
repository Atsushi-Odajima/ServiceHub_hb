import { describe, expect, it } from 'vitest';
import { maskPii } from '../../src/server/logmask.js';
import { safeErrorForLog, sanitizeUrl } from '../../src/server/app.js';

describe('ログの個人情報マスク', () => {
  it('メールアドレスと電話番号を伏せる', () => {
    expect(maskPii('550 5.1.1 <yamada.hanako@example.co.jp>: Recipient address rejected')).toBe('550 5.1.1 <ya***@example.co.jp>: Recipient address rejected');
    expect(maskPii('電話 090-1234-5678 / +81-90-1234-5678')).toBe('電話 *******5678 / ********5678');
    expect(maskPii('予約 2030-01-07 10:00 件数 12345')).toBe('予約 2030-01-07 10:00 件数 12345');
    expect(maskPii(null)).toBe('');
  });

  it('DBエラーの detail(行の値を含む)をログに出さない', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_normalized_key"'), {
      code: '23505',
      constraint: 'users_email_normalized_key',
      detail: 'Key (email_normalized)=(secret@example.com) already exists.',
      where: 'SQL statement "INSERT ..."',
    });
    const out = safeErrorForLog(err);
    expect(JSON.stringify(out)).not.toContain('secret@example.com');
    expect(out).toMatchObject({ code: '23505', constraint: 'users_email_normalized_key' });
  });

  it('URL の秘密トークンを伏せる', () => {
    expect(sanitizeUrl('/api/v1/public/manage/abcdef123456/ics')).toBe('/api/v1/public/manage/***/ics');
    expect(sanitizeUrl('/api/v1/auth/invitations/tok123/accept')).toBe('/api/v1/auth/invitations/***/accept');
    expect(sanitizeUrl('/reset-password?token=abc&x=1')).toBe('/reset-password?token=***&x=1');
    expect(sanitizeUrl('/api/v1/customers?q=090-1234-5678&limit=20')).toBe('/api/v1/customers?q=***&limit=20');
    expect(sanitizeUrl('/api/v1/search?limit=5&q=%E5%B1%B1%E7%94%B0')).toBe('/api/v1/search?limit=5&q=***');
  });
});
