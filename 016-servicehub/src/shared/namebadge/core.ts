/**
 * ServiceHub 名札・受付表 — 参加者番号・並び順・ページ分割・文字の収まり判定(純関数)。
 * #010「名札・受付チェック表メーカー」の core.js(番号・自然順・ページ計算・入力上限)と
 * app.js の文字サイズ調整(fitText / checkLayout)を移植した。
 *
 * 元ツールは印刷用 DOM を実寸で描いて行数を測っていたが、ここでは単体テストできるよう
 * 「文字幅の見積もり(全角=1em、半角英数=0.62em 等、実際のフォントより広め)」で行数を数える。
 * 見積もりが実際より広いので、ここで収まると判定したものは印刷でも収まる側に倒れる。
 * 寸法(91mm × 55mm を A4 に 2列×5段、受付表は1ページ20行)と文字サイズの段階は元ツールと同じ。
 */
import { katakanaToHiragana, nfkc } from '../normalize.js';

export const BADGES_PER_PAGE = 10;
export const ROWS_PER_PAGE = 20;
/** 1回の印刷で扱う上限(同行者を1人ずつ数えた件数)。元ツールは1イベント100人 */
export const MAX_PARTICIPANTS = 500;

export const LIMITS = { eventName: 40, eventDate: 30 } as const;

/** 印刷寸法(mm)。CSS と同じ値を使う */
export const MM = {
  page: { w: 210, h: 297, pad: 10 },
  badge: { w: 91, h: 55, colGap: 4, padX: 4, padY: 3, border: 0.25, topMin: 5, gap: 1, noMaxW: 45, noPadX: 1.2, noPadY: 0.2, noBorder: 0.25, topGap: 2 },
  sheet: { headerMax: 25, headerGap: 6, cols: [14, 30, 58, 48, 40] as const, rowH: 11.5, headRowH: 7, cellPadX: 1.5, cellPadY: 0.8, cellBorder: 0.25 },
} as const;

export const FONT = {
  badgeEvent: [8, 7.5, 7],
  badgeNo: [10, 9],
  badgeKana: [9, 8.5, 8],
  badgeName: [26, 24, 22, 20, 18, 16],
  badgeOrg: [10, 9.5, 9],
  sheetNo: [10],
  sheetName: [11, 10.5, 10],
  sheetOrg: [10],
  sheetEvent: [13, 12, 11, 10],
} as const;
export const MIN_NAME_PT = 16;

export type OutputMode = 'both' | 'badges' | 'sheet';
export type PartyMode = 'person' | 'booking';
export type SortOrder = 'number' | 'kana' | 'time';
export type OrgField = 'none' | 'service' | 'staff' | 'tags';

export const OUTPUT_MODE_LABELS: Record<OutputMode, string> = { both: '両方', badges: '名札のみ', sheet: '受付表のみ' };
export const PARTY_MODE_LABELS: Record<PartyMode, string> = { person: '1人1枚(同行者の名前欄は空欄)', booking: '1予約1枚(代表者のみ)' };
export const SORT_LABELS: Record<SortOrder, string> = { number: '参加者番号順(予約を受けた順)', kana: '五十音順(ふりがな)', time: '開始時刻順' };
export const ORG_FIELD_LABELS: Record<OrgField, string> = { none: '表示しない', service: 'サービス名', staff: '担当スタッフ', tags: '顧客のタグ' };

/** 予約が取り消された・来なかった状態。名札・受付表には載せない(番号は欠番として残す) */
export const EXCLUDED_STATUSES = new Set(['canceled_customer', 'canceled_business', 'no_show']);

/* ------------------------------------------------------------------ */
/* 参加者番号                                                          */
/* ------------------------------------------------------------------ */

function pad3(v: number): string {
  return String(v).padStart(3, '0');
}

/** 自然順の比較(P2 < P10、001 と 1 は桁数で区別)。元ツールの naturalCompare */
export function naturalCompare(a: string, b: string): number {
  const tokenize = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const digits = (x: string, y: string) => {
    const xs = x.replace(/^0+/, '') || '0';
    const ys = y.replace(/^0+/, '') || '0';
    if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1;
    if (xs !== ys) return xs < ys ? -1 : 1;
    return 0;
  };
  const ta = tokenize(a.toLowerCase());
  const tb = tokenize(b.toLowerCase());
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    const c = /^\d/.test(x) && /^\d/.test(y) ? digits(x, y) : x === y ? 0 : x < y ? -1 : 1;
    if (c !== 0) return c;
  }
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export interface NumberSource {
  id: string;
  createdAt: string;
}

/**
 * 参加者番号を割り当てる(P001, P002, …)。予約を受けた順(作成日時 → ID)で、
 * **キャンセル済みを含めた**対象の全予約に付けるため、あとからキャンセルが出ても
 * 他の人の番号は変わらない(元ツールと同じく欠番はそのまま残る)。
 */
export function assignNumbers(bookings: NumberSource[]): Map<string, string> {
  const sorted = [...bookings].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((b, i) => [b.id, `P${pad3(i + 1)}`]));
}

/** 同行者の番号: 代表 P003 の2人目は P003-2 */
export function companionNumber(base: string, nth: number): string {
  return `${base}-${nth}`;
}

/* ------------------------------------------------------------------ */
/* 参加者の組み立て                                                    */
/* ------------------------------------------------------------------ */

export interface BadgeBooking {
  id: string;
  createdAt: string;
  startsAt: string;
  status: string;
  partySize: number;
  customerName: string;
  customerKana: string | null;
  customerTags: string[];
  serviceName: string;
  staffName: string | null;
  /** 表示用の開始時刻(HH:mm)。1日分の受付表で使う */
  startTime: string;
}

export interface Participant {
  number: string;
  bookingId: string;
  /** 同行者(名前は空欄で印刷) */
  companion: boolean;
  /** 予約の人数(1予約1枚のとき受付表に「(3名)」と出す) */
  partySize: number;
  name: string;
  kana: string;
  org: string;
  startTime: string;
  startsAt: string;
}

export interface BuildOptions {
  partyMode: PartyMode;
  sort: SortOrder;
  orgField: OrgField;
  showKana: boolean;
}

function orgText(b: BadgeBooking, field: OrgField): string {
  if (field === 'service') return b.serviceName;
  if (field === 'staff') return b.staffName ? `担当 ${b.staffName}` : '';
  if (field === 'tags') return b.customerTags.join('・');
  return '';
}

function kanaKey(p: { kana: string; name: string }): string {
  return katakanaToHiragana(nfkc(p.kana || p.name).replace(/[\s　]+/g, ''));
}

/**
 * 予約から印刷対象の参加者を作る。キャンセル・無断欠席は除き、番号は assignNumbers の結果を使う。
 * 並び替えても番号は変わらない。同行者は必ず代表者の直後に並ぶ。
 */
export function buildParticipants(bookings: BadgeBooking[], opts: BuildOptions): Participant[] {
  const numbers = assignNumbers(bookings);
  const active = bookings.filter((b) => !EXCLUDED_STATUSES.has(b.status));
  const groups = active.map((b) => {
    const base = numbers.get(b.id)!;
    const lead: Participant = {
      number: base,
      bookingId: b.id,
      companion: false,
      partySize: b.partySize,
      name: b.customerName,
      kana: opts.showKana ? (b.customerKana ?? '') : '',
      org: orgText(b, opts.orgField),
      startTime: b.startTime,
      startsAt: b.startsAt,
    };
    const list = [lead];
    if (opts.partyMode === 'person') {
      for (let i = 2; i <= b.partySize; i++) {
        list.push({ ...lead, number: companionNumber(base, i), companion: true, name: '', kana: '', org: `${b.customerName} 様のお連れ様` });
      }
    }
    return list;
  });
  const cmpNo = (a: Participant[], b: Participant[]) => naturalCompare(a[0].number, b[0].number);
  if (opts.sort === 'kana') {
    groups.sort((a, b) => {
      const ka = kanaKey(a[0]);
      const kb = kanaKey(b[0]);
      return ka < kb ? -1 : ka > kb ? 1 : cmpNo(a, b);
    });
  } else if (opts.sort === 'time') {
    groups.sort((a, b) => (a[0].startsAt < b[0].startsAt ? -1 : a[0].startsAt > b[0].startsAt ? 1 : cmpNo(a, b)));
  } else {
    groups.sort(cmpNo);
  }
  return groups.flat();
}

/* ------------------------------------------------------------------ */
/* 文字幅の見積もりと折り返し                                          */
/* ------------------------------------------------------------------ */

const PT_MM = 25.4 / 72;

/** 1文字の幅(em)。実際のフォントより広めに見積もる */
export function charEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === ' ') return 0.35;
  if (cp >= 0x21 && cp <= 0x7e) return /[MWmw@%&]/.test(ch) ? 0.9 : /[A-Z0-9#$?_~]/.test(ch) ? 0.68 : 0.62;
  if (cp >= 0xff61 && cp <= 0xff9f) return 0.55; // 半角カナ
  return 1;
}

export function textWidthMm(text: string, pt: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * pt * PT_MM;
}

/** 折り返し単位: 半角英数字の語はひとかたまり(空白で改行)、それ以外は1文字ずつ */
function tokens(text: string): string[] {
  return text.match(/[\x21-\x7e]+ ?| |[^\x20-\x7e]/gu) ?? [];
}

/**
 * 幅 widthMm に折り返したときの行数(CSS の overflow-wrap: anywhere 相当)。
 * 語が1行に入らなければ語の途中で折る。
 */
export function countLines(text: string, pt: number, maxWidthMm: number): number {
  if (text === '') return 0;
  const widthMm = maxWidthMm + 1e-6; // 小数の誤差でちょうどの幅を溢れと判定しない
  let lines = 1;
  let cur = 0;
  for (const tok of tokens(text)) {
    const w = textWidthMm(tok, pt);
    const trimmed = textWidthMm(tok.trimEnd(), pt);
    if (cur + trimmed <= widthMm) {
      cur += w;
      continue;
    }
    if (trimmed <= widthMm && cur > 0) {
      lines++;
      cur = w;
      continue;
    }
    // 語の途中で折る
    for (const ch of tok) {
      const cw = textWidthMm(ch, pt);
      if (cur + cw > widthMm && cur > 0) {
        lines++;
        cur = 0;
      }
      cur += cw;
    }
  }
  return lines;
}

export interface Fit {
  size: number;
  lines: number;
  ok: boolean;
}

/** 大きい文字サイズから順に試し、maxLines 行以内に収まる最大のサイズを選ぶ(元ツールの fitText) */
export function fitText(text: string, sizes: readonly number[], widthMm: number, maxLines: number): Fit {
  let last: Fit = { size: sizes[sizes.length - 1], lines: 0, ok: true };
  for (const size of sizes) {
    const lines = countLines(text, size, widthMm);
    last = { size, lines, ok: lines <= maxLines };
    if (last.ok) return last;
  }
  return last;
}

const heightMm = (lines: number, pt: number, lh: number) => lines * pt * lh * PT_MM;

/* ------------------------------------------------------------------ */
/* レイアウト                                                          */
/* ------------------------------------------------------------------ */

export interface BadgeLayout {
  p: Participant;
  eventPt: number;
  noPt: number;
  kanaPt: number;
  namePt: number;
  orgPt: number;
}

export interface RowLayout {
  p: Participant;
  noPt: number;
  namePt: number;
  orgPt: number;
  /** 受付表の氏名欄に出す文字(同行者・人数の表記を含む) */
  nameText: string;
}

export interface SheetPage {
  rows: RowLayout[];
  pageNo: number;
  pageTotal: number;
}

export interface DocumentInput {
  participants: Participant[];
  /** 印刷しない参加者番号(欠席が分かっている人など)。名札・受付表の両方から外す */
  excluded: ReadonlySet<string>;
  eventName: string;
  eventDate: string;
  mode: OutputMode;
  partyMode: PartyMode;
}

export interface Problem {
  kind: 'event' | 'fit' | 'empty' | 'limit';
  text: string;
}

export interface PrintDocument {
  targets: Participant[];
  badgePages: BadgeLayout[][];
  sheetPages: SheetPage[];
  sheetEventPt: number;
  /** 受付表の見出しに出す人数表記 */
  countText: string;
  pages: { badges: number; sheet: number; total: number };
  problems: Problem[];
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function pageCounts(n: number, mode: OutputMode): { badges: number; sheet: number; total: number } {
  const badges = mode === 'sheet' ? 0 : Math.ceil(n / BADGES_PER_PAGE);
  const sheet = mode === 'badges' ? 0 : Math.ceil(n / ROWS_PER_PAGE);
  return { badges, sheet, total: badges + sheet };
}

/** イベント名・開催日の検証(元ツールの validateEvent) */
export function validateEvent(ev: { name: string; date: string }): string[] {
  const errs: string[] = [];
  const check = (v: string, label: string, max: number) => {
    if (/[\u0000-\u001F\u007F]/.test(v)) errs.push(`${label}に使用できない制御文字が含まれています。`);
    const len = Array.from(v).length;
    if (len > max) errs.push(`${label}は${max}文字以内にしてください(現在${len}文字)。`);
  };
  check(ev.name, 'イベント名', LIMITS.eventName);
  check(ev.date, '開催日', LIMITS.eventDate);
  return errs;
}

export function who(p: Participant): string {
  return p.companion ? `${p.number}(同行者)` : `${p.number} ${p.name}`;
}

export function sheetNameText(p: Participant, partyMode: PartyMode): string {
  if (p.companion) return '(同行者)';
  return partyMode === 'booking' && p.partySize > 1 ? `${p.name}(${p.partySize}名)` : p.name;
}

const B = MM.badge;
const BADGE_INNER_W = B.w - 2 * B.border - 2 * B.padX;
const BADGE_INNER_H = B.h - 2 * B.border - 2 * B.padY;

/** 名札1枚の文字サイズを決める。収まらない項目は problems に追加する */
export function layoutBadge(p: Participant, eventName: string, problems: Problem[]): { layout: BadgeLayout; eventFail: boolean } {
  const label = `名札 ${who(p)}`;
  // 上段: 参加者番号の枠(最大45mm)とイベント名
  // box-sizing: border-box のため max-width 45mm は枠線・内側余白を含む
  const noFrame = 2 * B.noPadX + 2 * B.noBorder;
  const no = fitText(p.number, FONT.badgeNo, B.noMaxW - noFrame, 2);
  if (!no.ok) problems.push({ kind: 'fit', text: `${label}:参加者番号が枠に収まりません。` });
  const noW = Math.min(B.noMaxW, textWidthMm(p.number, no.size) + noFrame);
  const noH = heightMm(Math.max(1, no.lines), no.size, 1.25) + 2 * B.noPadY + 2 * B.noBorder;
  const evW = BADGE_INNER_W - B.topGap - noW;
  const ev = eventName ? fitText(eventName, FONT.badgeEvent, evW, 2) : { size: FONT.badgeEvent[0], lines: 0, ok: true };
  const topH = Math.max(B.topMin, noH, heightMm(ev.lines, ev.size, 1.25));

  const kana = p.kana ? fitText(p.kana, FONT.badgeKana, BADGE_INNER_W, 2) : null;
  if (kana && !kana.ok) problems.push({ kind: 'fit', text: `${label}:ふりがなが長すぎます(2行まで)。短くしてください。` });
  const org = p.org ? fitText(p.org, FONT.badgeOrg, BADGE_INNER_W, 2) : null;
  if (org && !org.ok) problems.push({ kind: 'fit', text: `${label}:所属が長すぎます(2行まで)。短くしてください。` });
  let name = p.name ? fitText(p.name, FONT.badgeName, BADGE_INNER_W, 2) : { size: FONT.badgeName[0], lines: 0, ok: true };
  if (!name.ok) problems.push({ kind: 'fit', text: `${label}:氏名／表示名が長すぎます(${MIN_NAME_PT}ptで2行まで)。顧客の表示名を短くしてください。` });

  // 各項目は収まっても合計で溢れる場合は、氏名を最小サイズまで段階的に下げて再確認(元ツールと同じ)
  const mainH = BADGE_INNER_H - topH;
  const total = (nm: Fit) => {
    const parts = [kana ? heightMm(kana.lines, kana.size, 1.25) : null, heightMm(Math.max(1, nm.lines), nm.size, 1.2), org ? heightMm(org.lines, org.size, 1.25) : null].filter((v): v is number => v !== null);
    return parts.reduce((a, b) => a + b, 0) + B.gap * (parts.length - 1);
  };
  if (name.ok && total(name) > mainH) {
    for (const size of FONT.badgeName.filter((s) => s < name.size)) {
      const lines = countLines(p.name, size, BADGE_INNER_W);
      name = { size, lines, ok: lines <= 2 };
      if (name.ok && total(name) <= mainH) break;
    }
    if (total(name) > mainH) problems.push({ kind: 'fit', text: `${label}:ふりがな・氏名・所属を合わせると名札に収まりません。どれかを短くしてください。` });
  }
  return {
    layout: { p, eventPt: ev.size, noPt: no.size, kanaPt: kana?.size ?? FONT.badgeKana[0], namePt: name.size, orgPt: org?.size ?? FONT.badgeOrg[0] },
    eventFail: !ev.ok,
  };
}

const S = MM.sheet;
const cellTextW = (i: number) => S.cols[i] - 2 * S.cellPadX - S.cellBorder;
const CELL_TEXT_H = S.rowH - S.cellBorder - 2 * S.cellPadY;

export function layoutRow(p: Participant, partyMode: PartyMode, problems: Problem[]): RowLayout {
  const label = `受付表 ${who(p)}`;
  const nameText = sheetNameText(p, partyMode);
  const no = fitText(p.number, FONT.sheetNo, cellTextW(1), 2);
  if (!no.ok) problems.push({ kind: 'fit', text: `${label}:参加者番号が欄に収まりません。` });
  const nm = fitText(nameText, FONT.sheetName, cellTextW(2), 2);
  if (!nm.ok) problems.push({ kind: 'fit', text: `${label}:氏名／表示名が長すぎます(10ptで2行まで)。短くしてください。` });
  const og = p.org ? fitText(p.org, FONT.sheetOrg, cellTextW(3), 2) : { size: FONT.sheetOrg[0], lines: 0, ok: true };
  if (!og.ok) problems.push({ kind: 'fit', text: `${label}:所属が長すぎます(10ptで2行まで)。短くしてください。` });
  const tallest = Math.max(heightMm(no.lines, no.size, 1.2), heightMm(nm.lines, nm.size, 1.2), heightMm(og.lines, og.size, 1.2));
  if (no.ok && nm.ok && og.ok && tallest > CELL_TEXT_H) problems.push({ kind: 'fit', text: `${label}:行の高さに収まりません。氏名または所属を短くしてください。` });
  return { p, noPt: no.size, namePt: nm.size, orgPt: og.size, nameText };
}

export function sheetMetaText(eventDate: string, countText: string): string {
  return [eventDate ? `開催日：${eventDate}` : '', countText].filter(Boolean).join('　');
}

/** 名札・受付表の全体を組み立てる(ページ分割・文字サイズ・確認事項) */
export function buildDocument(input: DocumentInput): PrintDocument {
  const problems: Problem[] = [];
  for (const e of validateEvent({ name: input.eventName, date: input.eventDate })) problems.push({ kind: 'event', text: e });
  const targets = input.participants.filter((p) => !input.excluded.has(p.number));
  const people = input.partyMode === 'booking' ? targets.reduce((n, p) => n + p.partySize, 0) : targets.length;
  const countText = input.partyMode === 'booking' ? `印刷対象：${targets.length}件(${people}名)` : `印刷対象人数：${targets.length}人`;
  const pages = pageCounts(targets.length, input.mode);
  const empty: PrintDocument = { targets, badgePages: [], sheetPages: [], sheetEventPt: FONT.sheetEvent[0], countText, pages, problems };
  if (targets.length === 0) {
    problems.push({ kind: 'empty', text: '印刷対象の参加者がいません。' });
    return empty;
  }
  if (targets.length > MAX_PARTICIPANTS) {
    problems.push({ kind: 'limit', text: `印刷対象が${MAX_PARTICIPANTS}人を超えています(${targets.length}人)。回ごとに分けて印刷してください。` });
    return empty;
  }

  let badgePages: BadgeLayout[][] = [];
  if (input.mode !== 'sheet') {
    let eventFail = false;
    const layouts = targets.map((p) => {
      const r = layoutBadge(p, input.eventName, problems);
      eventFail ||= r.eventFail;
      return r.layout;
    });
    if (eventFail) problems.push({ kind: 'event', text: '名札:イベント名が長すぎて名札の上部に収まりません(2行まで)。イベント名を短くしてください。' });
    badgePages = chunk(layouts, BADGES_PER_PAGE);
  }

  let sheetPages: SheetPage[] = [];
  let sheetEventPt: number = FONT.sheetEvent[0];
  if (input.mode !== 'badges') {
    const rows = targets.map((p) => layoutRow(p, input.partyMode, problems));
    const chunks = chunk(rows, ROWS_PER_PAGE);
    sheetPages = chunks.map((r, i) => ({ rows: r, pageNo: i + 1, pageTotal: chunks.length }));
    // 見出し: 「ページ N / M」の幅を除いた残りにイベント名(2行まで)、全体で25mm以内
    const pageLabelW = textWidthMm(`ページ ${chunks.length} / ${chunks.length}`, 12) + 2;
    const headW = MM.page.w - 2 * MM.page.pad - S.headerGap - pageLabelW;
    const ev = input.eventName ? fitText(input.eventName, FONT.sheetEvent, headW, 2) : { size: FONT.sheetEvent[0], lines: 0, ok: true };
    sheetEventPt = ev.size;
    const metaLines = countLines(sheetMetaText(input.eventDate, countText), 10, headW);
    const headH = heightMm(1, 10, 1.3) + heightMm(ev.lines, ev.size, 1.25) + 1 + heightMm(metaLines, 10, 1.3) + 2 + 0.5;
    if (!ev.ok || headH > S.headerMax) problems.push({ kind: 'event', text: '受付表:イベント名・開催日がページ上部に収まりません。短くしてください。' });
  }
  return { targets, badgePages, sheetPages, sheetEventPt, countText, pages, problems };
}
