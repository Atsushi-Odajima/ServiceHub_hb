/**
 * ログに出す文字列の個人情報をマスクする(外部サービスのエラーメッセージ等に宛先が含まれる場合の対策)。
 * メールアドレス: 先頭2文字 + ***@ドメイン / 電話番号らしき数字列: 下4桁以外を * に置き換える。
 */
export function maskPii(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2')
    .replace(/(?<![\d-])(\+?\d[\d-]{7,}\d)(?![\d-])/g, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 10) return m;
      return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
    });
}
