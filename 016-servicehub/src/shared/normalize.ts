/** 検索・照合用の正規化(サーバー/クライアント共通) */

export function nfkc(s: string): string {
  return s.normalize('NFKC');
}

/** カタカナ → ひらがな */
export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = nfkc(email).trim().toLowerCase();
  return e.length > 0 ? e : null;
}

/** 電話番号: 数字のみ。+81 は 0 に置き換える */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let p = nfkc(phone).trim();
  if (p.startsWith('+81')) p = '0' + p.slice(3);
  const digits = p.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/** 氏名/かな: NFKC・小文字・空白除去・カタカナ→ひらがな */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return katakanaToHiragana(nfkc(name).toLowerCase().replace(/[\s　]+/g, ''));
}

/** 前方一致レンジ検索の上限(COLLATE "C" の列に対して col >= p AND col < upper) */
export function prefixUpperBound(prefix: string): string {
  return prefix + '\u{10FFFF}';
}

/** 表示用のメールマスク(例: ta***@example.com) */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  return d.length <= 4 ? '****' : `***-****-${d.slice(-4)}`;
}
