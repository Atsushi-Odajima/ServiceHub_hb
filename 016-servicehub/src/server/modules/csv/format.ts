/**
 * CSV の書き出し/読み込み(RFC 4180)。
 * - 出力は UTF-8 BOM 付き・CRLF(Excel で文字化けしない)
 * - 数式インジェクション対策: 文字列が = + - @ タブ CR で始まる場合は先頭に ' を付ける(数値型はそのまま)
 */
export const CSV_BOM = '﻿';

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** CSV テキストを行×列に分解する。BOM を除き、引用符・改行を含む項目に対応。空行は除く */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    field = '';
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      pushRow();
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) throw new Error('引用符(")が閉じられていません');
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/** 出力時に付けた数式対策の ' を取り込み時に外す(先頭が ' + 危険文字の場合のみ) */
export function unescapeCell(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/** RFC 5987 の filename* 付き Content-Disposition(日本語ファイル名) */
export function contentDisposition(asciiName: string, utf8Name: string): string {
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}
