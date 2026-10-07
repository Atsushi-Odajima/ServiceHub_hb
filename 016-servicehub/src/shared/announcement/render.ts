/**
 * ServiceHub 空き枠お知らせ画像 — Canvas 描画。
 * #005「サロン空き枠お知らせ画像メーカー」の render.js をそのまま TypeScript に移植したもの
 * (レイアウト・配色・文字サイズ・折り返し・禁則・はみ出し検出は元ツールと同じ)。
 * プレビューと PNG 保存は同じ render() の結果(同じ Canvas)を使う。
 * Canvas の型は必要な部分だけを Ctx2D として定義し、DOM なしでも(単体テストの計測用モックで)レイアウトを検証できるようにしている。
 */
import { addDays } from '../time.js';
import {
  type AnnState,
  findSlot,
  formatJaDate,
  formatMonthDay,
  formatPeriod,
  isSlotEligible,
  eligibleSlots,
  type Issue,
  MAX_SLOTS_PER_DAY,
  type PaletteId,
  SINGLE_TITLE_TEXT,
  type SizeId,
  STATUS_LABELS,
  visibleSlots,
  weekDates,
  weekdayIndex,
  weekdayLabel,
} from './core.js';

/** 使う Canvas 2D API の部分集合(CanvasRenderingContext2D はこれを満たす) */
export interface Ctx2D {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Ctx2D | null;
}

export const CANVAS_SIZES: Record<SizeId, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
};

// 端末にある日本語対応システムフォントのみ(外部フォントは読み込まない)
export const FONT_FAMILY =
  '"Yu Gothic UI", "Yu Gothic", YuGothic, Meiryo, "Hiragino Sans", "Hiragino Kaku Gothic ProN", ' +
  '"Noto Sans JP", "Noto Sans CJK JP", "IPAGothic", "IPAPGothic", sans-serif';

interface Palette {
  name: string;
  bg: string;
  frame: string;
  text: string;
  sub: string;
  accent: string;
  accentText: string;
  rowBg: string;
  openBg: string;
  openText: string;
  fullBg: string;
  fullText: string;
  closedBg: string;
  closedText: string;
  unsetBorder: string;
  unsetText: string;
  sat: string;
  sun: string;
}

export const PALETTES: Record<PaletteId, Palette> = {
  white: {
    name: 'ホワイト',
    bg: '#FFFFFF', frame: '#E6DED6', text: '#2A2622', sub: '#655D55',
    accent: '#A4505A', accentText: '#FFFFFF', rowBg: '#F8F5F2',
    openBg: '#A4505A', openText: '#FFFFFF', fullBg: '#E3E0DC', fullText: '#524C46',
    closedBg: '#EFEBE6', closedText: '#524C46', unsetBorder: '#B26A00', unsetText: '#8A5200',
    sat: '#2F5FA8', sun: '#B8322A',
  },
  beige: {
    name: 'ウォームベージュ',
    bg: '#F3EBDD', frame: '#DCCBB2', text: '#3A2E24', sub: '#6A5A4A',
    accent: '#80603F', accentText: '#FFFFFF', rowBg: '#FBF6EE',
    openBg: '#80603F', openText: '#FFFFFF', fullBg: '#E1D6C6', fullText: '#54483C',
    closedBg: '#EAE0D1', closedText: '#54483C', unsetBorder: '#A55F00', unsetText: '#824B00',
    sat: '#2E5A8C', sun: '#A8362B',
  },
  charcoal: {
    name: 'チャコール',
    bg: '#2B2B2E', frame: '#48484E', text: '#F4F1EC', sub: '#C4BEB5',
    accent: '#D8B879', accentText: '#2B2B2E', rowBg: '#36363A',
    openBg: '#D8B879', openText: '#2B2B2E', fullBg: '#4B4B51', fullText: '#D2CDC5',
    closedBg: '#404045', closedText: '#C4BEB5', unsetBorder: '#F0B45A', unsetText: '#F0B45A',
    sat: '#9CBDF0', sun: '#F29A8F',
  },
};

interface WeekSizes {
  kicker: number; shop: number; shopMin: number; period: number; periodMin: number;
  date: number; weekday: number; time: number; timeMin: number; status: number; statusMin: number;
  label: number; labelMin: number; dayBadge: number;
  booking: number; bookingMin: number; note: number; noteMin: number;
}
interface SingleSizes {
  shop: number; shopMin: number; title: number; titleMin: number; year: number; date: number; dateMin: number;
  time: number; timeMin: number; status: number; label: number; labelMin: number;
  booking: number; bookingMin: number; note: number; noteMin: number;
}
interface SizeCfg {
  marginX: number;
  padY: number;
  week: WeekSizes;
  single: SingleSizes;
}

// 基準の文字サイズ(px)。scale で全体を縮小し、min 未満にはしない
const BASE: Record<SizeId, SizeCfg> = {
  square: {
    marginX: 44, padY: 40,
    week: {
      kicker: 26, shop: 50, shopMin: 34, period: 28, periodMin: 22,
      date: 34, weekday: 22, time: 32, timeMin: 24, status: 19, statusMin: 16,
      label: 18, labelMin: 15, dayBadge: 30,
      booking: 30, bookingMin: 22, note: 24, noteMin: 18,
    },
    single: {
      shop: 46, shopMin: 32, title: 58, titleMin: 40, year: 32, date: 92, dateMin: 64,
      time: 210, timeMin: 150, status: 38, label: 46, labelMin: 32,
      booking: 36, bookingMin: 26, note: 28, noteMin: 20,
    },
  },
  story: {
    marginX: 60, padY: 90,
    week: {
      kicker: 34, shop: 66, shopMin: 44, period: 36, periodMin: 28,
      date: 44, weekday: 28, time: 42, timeMin: 30, status: 24, statusMin: 20,
      label: 24, labelMin: 18, dayBadge: 40,
      booking: 38, bookingMin: 28, note: 30, noteMin: 22,
    },
    single: {
      shop: 62, shopMin: 40, title: 80, titleMin: 52, year: 46, date: 136, dateMin: 90,
      time: 300, timeMin: 200, status: 54, label: 64, labelMin: 44,
      booking: 48, bookingMin: 34, note: 38, noteMin: 26,
    },
  },
};

const MIN_SCALE = 0.8;
const LINE_HEIGHT = 1.3;

/* ---------- 文字の分割と折り返し ---------- */

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;

function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

// 行頭に来てはいけない文字 / 行末に来てはいけない文字(簡易禁則)
const NO_START = new Set(Array.from('、。，．,.!?！？)）]］}｝」』】〉》〕ー～〜ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・:：;；…‥%％'));
const NO_END = new Set(Array.from('(（[［{｛「『【〈《〔'));
const WORD_CHAR = /^[A-Za-z0-9@#&_\-+./:%'=~]$/;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const g of graphemes(text)) {
    if (WORD_CHAR.test(g)) {
      word += g;
      continue;
    }
    if (word) {
      tokens.push(word);
      word = '';
    }
    tokens.push(g);
  }
  if (word) tokens.push(word);
  const merged: string[] = [];
  for (const t of tokens) {
    const last = merged.length - 1;
    if (last >= 0 && (NO_START.has(t) || NO_END.has(merged[last].slice(-1)))) merged[last] += t;
    else merged.push(t);
  }
  return merged;
}

function setFont(ctx: Ctx2D, weight: string, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
}

function textWidth(ctx: Ctx2D, text: string, weight: string, size: number): number {
  setFont(ctx, weight, size);
  return ctx.measureText(text).width;
}

/** 現在の ctx.font で maxW に収まるよう折り返す */
export function wrapText(ctx: Ctx2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  const w = (s: string) => ctx.measureText(s).width;
  for (const t of tokenize(text)) {
    if (line === '' && /^\s+$/.test(t)) continue;
    if (w(line + t) <= maxW) {
      line += t;
      continue;
    }
    if (line.trim() !== '') {
      lines.push(line.replace(/\s+$/, ''));
      line = '';
      if (/^\s+$/.test(t)) continue;
    }
    if (w(t) <= maxW) {
      line = t;
      continue;
    }
    for (const g of graphemes(t)) {
      if (line === '' || w(line + g) <= maxW) line += g;
      else {
        lines.push(line);
        line = g;
      }
    }
  }
  if (line.trim() !== '') lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/** 行数を変えずに最も狭い幅で折り返し、最終行だけ1〜2文字になるのを防ぐ */
function balanceLines(ctx: Ctx2D, text: string, maxW: number, lines: string[]): string[] {
  const n = lines.length;
  let lo = maxW / n;
  let hi = maxW;
  let best = lines;
  for (let k = 0; k < 12; k++) {
    const mid = (lo + hi) / 2;
    const trial = wrapText(ctx, text, mid);
    if (trial.length <= n) {
      best = trial;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

function ellipsize(ctx: Ctx2D, text: string, maxW: number): string {
  const gs = graphemes(text);
  while (gs.length && ctx.measureText(gs.join('') + '…').width > maxW) gs.pop();
  return gs.join('') + '…';
}

interface Fit {
  ok: boolean;
  size: number;
  weight: string;
  lines: string[];
  lh: number;
  h: number;
}

/** 行数上限と最小サイズの範囲で文字を収める。収まらない場合 ok=false(問題として報告し、保存を止める) */
function fitText(ctx: Ctx2D, text: string, o: { weight: string; size: number; min: number; maxLines: number; maxW: number }): Fit {
  let size = Math.max(Math.round(o.size), o.min);
  for (;;) {
    setFont(ctx, o.weight, size);
    let lines = wrapText(ctx, text, o.maxW);
    if (lines.length <= o.maxLines) {
      if (lines.length > 1) lines = balanceLines(ctx, text, o.maxW, lines);
      return { ok: true, size, weight: o.weight, lines, lh: size * LINE_HEIGHT, h: lines.length * size * LINE_HEIGHT };
    }
    if (size <= o.min) {
      const shown = lines.slice(0, o.maxLines);
      shown[shown.length - 1] = ellipsize(ctx, shown[shown.length - 1], o.maxW);
      return { ok: false, size, weight: o.weight, lines: shown, lh: size * LINE_HEIGHT, h: shown.length * size * LINE_HEIGHT };
    }
    size = Math.max(o.min, size - 2);
  }
}

/* ---------- 描画命令 ---------- */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Op =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: string | null; stroke?: string | null; dash?: number[] }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { t: 'text'; text: string; weight: string; size: number; color: string; x: number; y: number; w: number; h: number; kind: string; container: Box | null };

export interface PlacedText {
  text: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  container: Box | null;
}

class Builder {
  ops: Op[] = [];
  rect(x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke?: string | null, dash?: number[]): Box {
    this.ops.push({ t: 'rect', x, y, w, h, r, fill, stroke, dash });
    return { x, y, w, h };
  }
  /** 1行の文字。box={x,w} の範囲に align で配置。container ははみ出し検証用 */
  text(ctx: Ctx2D, text: string, weight: string, size: number, color: string, align: 'left' | 'center' | 'right', bx: number, bw: number, top: number, lh: number, kind: string, container?: Box | null) {
    const tw = textWidth(ctx, text, weight, size);
    const x = align === 'center' ? bx + (bw - tw) / 2 : align === 'right' ? bx + bw - tw : bx;
    this.ops.push({ t: 'text', text, weight, size, color, x, y: top, w: tw, h: lh, kind, container: container ?? null });
  }
  lines(ctx: Ctx2D, fit: { lines: string[]; weight: string; size: number; lh: number }, color: string, align: 'left' | 'center' | 'right', bx: number, bw: number, top: number, kind: string, container?: Box | null) {
    fit.lines.forEach((ln, i) => this.text(ctx, ln, fit.weight, fit.size, color, align, bx, bw, top + i * fit.lh, fit.lh, kind, container));
  }
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r || 0, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function paint(ctx: Ctx2D, ops: Op[]): void {
  for (const op of ops) {
    if (op.t === 'rect') {
      roundRectPath(ctx, op.x, op.y, op.w, op.h, op.r);
      if (op.fill) {
        ctx.fillStyle = op.fill;
        ctx.fill();
      }
      if (op.stroke) {
        ctx.setLineDash(op.dash ?? []);
        ctx.lineWidth = 2;
        ctx.strokeStyle = op.stroke;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (op.t === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.lineWidth = op.width;
      ctx.strokeStyle = op.color;
      ctx.stroke();
    } else {
      setFont(ctx, op.weight, op.size);
      ctx.fillStyle = op.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(op.text, op.x, op.y + op.h / 2);
    }
  }
}

/* ---------- 週間告知 ---------- */

interface Section {
  h: number;
  emit: (y: number) => void;
}
interface LayoutResult {
  ops: Op[];
  problems: Issue[];
  fits: boolean;
}

function dayColor(P: Palette, iso: string): string {
  const wd = weekdayIndex(iso);
  return wd === 0 ? P.sun : wd === 6 ? P.sat : P.text;
}

function layoutWeek(ctx: Ctx2D, state: AnnState, W: number, H: number, s: number, P: Palette, cfg: SizeCfg): LayoutResult {
  const F = cfg.week;
  const problems: Issue[] = [];
  const b = new Builder();
  const mx = cfg.marginX;
  const cw = W - mx * 2;
  const dates = weekDates(state.startDate);
  const sections: Section[] = [];

  // ヘッダー
  const kicker = fitText(ctx, '空き枠のご案内', { weight: 'bold', size: F.kicker * s, min: 18, maxLines: 1, maxW: cw });
  const shopName = state.shop.name.trim();
  const shop = shopName ? fitText(ctx, shopName, { weight: 'bold', size: F.shop * s, min: F.shopMin, maxLines: 2, maxW: cw }) : null;
  if (shop && !shop.ok) problems.push({ level: 'error', field: 'shop.name', message: '店舗名が長すぎて画像に収まりません。短くしてください。' });
  const period = fitText(ctx, formatPeriod(state.startDate), { weight: 'normal', size: F.period * s, min: F.periodMin, maxLines: 1, maxW: cw });
  const gapS = 10 * s;
  const headerH = kicker.h + (shop ? gapS + shop.h : 0) + gapS + period.h;
  sections.push({
    h: headerH,
    emit: (y) => {
      b.lines(ctx, kicker, P.accent, 'center', mx, cw, y, 'kicker');
      y += kicker.h;
      if (shop) {
        y += gapS;
        b.lines(ctx, shop, P.text, 'center', mx, cw, y, 'shop');
        y += shop.h;
      }
      y += gapS;
      b.lines(ctx, period, P.sub, 'center', mx, cw, y, 'period');
    },
  });

  // 日ごとの行
  const rowPad = Math.max(8, 10 * s);
  const dateSize = Math.round(F.date * s);
  const wdSize = Math.round(F.weekday * s);
  const dateColW = Math.ceil(textWidth(ctx, '12/31', 'bold', dateSize)) + Math.round(20 * s);
  const areaX = mx + rowPad + dateColW + Math.round(8 * s);
  const areaW = mx + cw - rowPad - areaX;
  const chipGap = Math.max(8, Math.round(10 * s));
  const chipW = (areaW - chipGap * (MAX_SLOTS_PER_DAY - 1)) / MAX_SLOTS_PER_DAY;
  const chipPadX = Math.max(6, Math.round(10 * s));
  const chipPadY = Math.max(6, Math.round(8 * s));
  const chipInnerW = chipW - chipPadX * 2;
  const timeSize = Math.max(F.timeMin, Math.round(F.time * s));
  const statusSize = Math.max(F.statusMin, Math.round(F.status * s));
  const timeLH = timeSize * 1.2;
  const statusLH = statusSize * LINE_HEIGHT;
  const dateBlockH = dateSize * 1.2 + wdSize * LINE_HEIGHT;
  const badgeSize = Math.round(F.dayBadge * s);

  // 時刻と状態を1行に並べられるか(全枠で統一)
  let inline = true;
  for (const day of state.days) {
    for (const sl of visibleSlots(day)) {
      const w = textWidth(ctx, sl.time, 'bold', timeSize) + 6 * s + textWidth(ctx, STATUS_LABELS[sl.status], 'bold', statusSize);
      if (w > chipInnerW) inline = false;
    }
  }

  const rows = state.days.map((day, i) => {
    const chips = visibleSlots(day).map((sl) => {
      const tw = textWidth(ctx, sl.time, 'bold', timeSize);
      if (tw > chipInnerW) problems.push({ level: 'error', field: null, message: '時刻が枠内に収まりません。' });
      const label = sl.label.trim();
      const lf = label ? fitText(ctx, label, { weight: 'normal', size: F.label * s, min: F.labelMin, maxLines: 2, maxW: chipInnerW }) : null;
      if (lf && !lf.ok) {
        problems.push({
          level: 'error',
          field: `slot:${sl.id}:label`,
          message: `${formatJaDate(dates[i], false)} ${sl.time} のメニュー名・補足が長すぎて収まりません。短くしてください。`,
        });
      }
      const contentH = timeLH + (inline ? 0 : statusLH) + (lf ? 4 * s + lf.h : 0);
      return { slot: sl, label: lf, contentH };
    });
    let inner = dateBlockH;
    for (const c of chips) inner = Math.max(inner, c.contentH + chipPadY * 2);
    if (!chips.length) inner = Math.max(inner, badgeSize * 1.6);
    return { day, iso: dates[i], chips, h: inner + rowPad * 2 };
  });
  const rowGap = Math.max(6, 8 * s);
  const rowsH = rows.reduce((a, r) => a + r.h, 0) + rowGap * (rows.length - 1);
  const rowsSection = {
    h: rowsH,
    extraPerRow: 0,
    emit: (y: number) => {
      for (const r of rows) {
        const h = r.h + rowsSection.extraPerRow;
        emitRow(r, y, h);
        y += h + rowGap;
      }
    },
  };
  sections.push(rowsSection);

  function emitRow(r: (typeof rows)[number], y: number, h: number) {
    const card = b.rect(mx, y, cw, h, 14 * s, P.rowBg);
    // 日付
    const dTop = y + (h - dateBlockH) / 2;
    const dx = mx + rowPad;
    const col = dayColor(P, r.iso);
    b.text(ctx, formatMonthDay(r.iso), 'bold', dateSize, col, 'center', dx, dateColW, dTop, dateSize * 1.2, 'date', card);
    b.text(ctx, `(${weekdayLabel(r.iso)})`, 'bold', wdSize, col, 'center', dx, dateColW, dTop + dateSize * 1.2, wdSize * LINE_HEIGHT, 'weekday', card);

    const ay = y + rowPad;
    const ah = h - rowPad * 2;
    if (r.day.mode === 'full' || r.day.mode === 'closed') {
      const isFull = r.day.mode === 'full';
      const box = b.rect(areaX, ay, areaW, ah, 10 * s, isFull ? P.fullBg : P.closedBg);
      b.text(ctx, isFull ? '満席' : '休業', 'bold', badgeSize, isFull ? P.fullText : P.closedText, 'center', areaX, areaW, ay + (ah - badgeSize * LINE_HEIGHT) / 2, badgeSize * LINE_HEIGHT, 'daybadge', box);
      return;
    }
    if (!r.chips.length) {
      const ub = b.rect(areaX + 1, ay + 1, areaW - 2, ah - 2, 10 * s, null, P.unsetBorder, [10, 8]);
      b.text(ctx, '情報未設定', 'bold', Math.round(badgeSize * 0.8), P.unsetText, 'center', areaX, areaW, ay + (ah - badgeSize * 0.8 * LINE_HEIGHT) / 2, badgeSize * 0.8 * LINE_HEIGHT, 'unset', ub);
      return;
    }
    r.chips.forEach((c, k) => {
      const cx = areaX + k * (chipW + chipGap);
      const open = c.slot.status === 'open';
      const bg = open ? P.openBg : P.fullBg;
      const fg = open ? P.openText : P.fullText;
      const chip = b.rect(cx, ay, chipW, ah, 10 * s, bg);
      let ty = ay + (ah - c.contentH) / 2;
      const statusText = STATUS_LABELS[c.slot.status];
      if (inline) {
        const tw = textWidth(ctx, c.slot.time, 'bold', timeSize);
        const sw = textWidth(ctx, statusText, 'bold', statusSize);
        const gx = cx + (chipW - (tw + 6 * s + sw)) / 2;
        b.text(ctx, c.slot.time, 'bold', timeSize, fg, 'left', gx, tw, ty, timeLH, 'time', chip);
        b.text(ctx, statusText, 'bold', statusSize, fg, 'left', gx + tw + 6 * s, sw, ty + (timeLH - statusLH) / 2 + statusSize * 0.08, statusLH, 'status', chip);
        ty += timeLH;
      } else {
        b.text(ctx, c.slot.time, 'bold', timeSize, fg, 'center', cx, chipW, ty, timeLH, 'time', chip);
        ty += timeLH;
        b.text(ctx, statusText, 'bold', statusSize, fg, 'center', cx, chipW, ty, statusLH, 'status', chip);
        ty += statusLH;
      }
      if (c.label) {
        ty += 4 * s;
        b.lines(ctx, c.label, fg, 'center', cx + chipPadX, chipInnerW, ty, 'label', chip);
      }
    });
  }

  footer(ctx, state, b, sections, problems, F, s, mx, cw, P, 6);
  return finishLayout(b, sections, 22 * s, W, H, cfg, P, problems, rowsSection, rows.length);
}

function footer(
  ctx: Ctx2D,
  state: AnnState,
  b: Builder,
  sections: Section[],
  problems: Issue[],
  F: { booking: number; bookingMin: number; note: number; noteMin: number },
  s: number,
  mx: number,
  cw: number,
  P: Palette,
  gapBase: number,
): void {
  const booking = state.shop.booking.trim();
  const note = state.shop.note.trim();
  const bf = booking ? fitText(ctx, booking, { weight: 'bold', size: F.booking * s, min: F.bookingMin, maxLines: 2, maxW: cw }) : null;
  const nf = note ? fitText(ctx, note, { weight: 'normal', size: F.note * s, min: F.noteMin, maxLines: 2, maxW: cw }) : null;
  if (bf && !bf.ok) problems.push({ level: 'error', field: 'shop.booking', message: '予約方法の案内文が長すぎて画像に収まりません。短くしてください。' });
  if (nf && !nf.ok) problems.push({ level: 'error', field: 'shop.note', message: '補足文が長すぎて画像に収まりません。短くしてください。' });
  if (!bf && !nf) return;
  const g = gapBase * s;
  sections.push({
    h: (bf ? bf.h : 0) + (bf && nf ? g : 0) + (nf ? nf.h : 0),
    emit: (y) => {
      if (bf) {
        b.lines(ctx, bf, P.text, 'center', mx, cw, y, 'booking');
        y += bf.h + (nf ? g : 0);
      }
      if (nf) b.lines(ctx, nf, P.sub, 'center', mx, cw, y, 'note');
    },
  });
}

/** セクションを縦に配置。余白は行の高さとセクション間に配分する */
function finishLayout(
  b: Builder,
  sections: Section[],
  gap: number,
  W: number,
  H: number,
  cfg: SizeCfg,
  P: Palette,
  problems: Issue[],
  stretchSection: { h: number; extraPerRow: number } | null,
  stretchCount: number,
): LayoutResult {
  const natural = cfg.padY * 2 + sections.reduce((a, sec) => a + sec.h, 0) + gap * (sections.length - 1);
  let extra = H - natural;
  const fits = extra >= 0;
  let sectionGap = gap;
  let top = cfg.padY;
  if (fits) {
    if (stretchSection) {
      const perRow = Math.min((extra * 0.5) / stretchCount, 40);
      stretchSection.extraPerRow = perRow;
      stretchSection.h += perRow * stretchCount;
      extra -= perRow * stretchCount;
    }
    const add = Math.min(extra / (sections.length + 1), 80);
    sectionGap += add;
    extra -= add * (sections.length - 1);
    top += extra / 2;
  }
  // 背景と枠
  const bg = new Builder();
  bg.rect(0, 0, W, H, 0, P.bg);
  bg.rect(16, 16, W - 32, H - 32, 20, null, P.frame);
  let y = top;
  for (const sec of sections) {
    sec.emit(y);
    y += sec.h + sectionGap;
  }
  return { ops: bg.ops.concat(b.ops), problems, fits };
}

/* ---------- 1枠告知 ---------- */

function layoutSingle(ctx: Ctx2D, state: AnnState, W: number, H: number, s: number, P: Palette, cfg: SizeCfg): LayoutResult {
  const F = cfg.single;
  const problems: Issue[] = [];
  const b = new Builder();
  const mx = cfg.marginX;
  const cw = W - mx * 2;
  const sections: Section[] = [];
  const found = findSlot(state, state.output.singleSlotId);
  const eligible = found && isSlotEligible(state, state.output.singleSlotId);

  const shopName = state.shop.name.trim();
  const shop = shopName ? fitText(ctx, shopName, { weight: 'bold', size: F.shop * s, min: F.shopMin, maxLines: 2, maxW: cw }) : null;
  if (shop && !shop.ok) problems.push({ level: 'error', field: 'shop.name', message: '店舗名が長すぎて画像に収まりません。短くしてください。' });
  if (shop) sections.push({ h: shop.h, emit: (y) => b.lines(ctx, shop, P.text, 'center', mx, cw, y, 'shop') });

  const tf = fitText(ctx, SINGLE_TITLE_TEXT[state.output.singleTitle], { weight: 'bold', size: F.title * s, min: F.titleMin, maxLines: 1, maxW: cw - 80 * s });
  const tPadY = 16 * s;
  const tPadX = 40 * s;
  sections.push({
    h: tf.h + tPadY * 2,
    emit: (y) => {
      const tw = textWidth(ctx, tf.lines[0], 'bold', tf.size);
      const pill = b.rect(W / 2 - tw / 2 - tPadX, y, tw + tPadX * 2, tf.h + tPadY * 2, (tf.h + tPadY * 2) / 2, P.accent);
      b.lines(ctx, tf, P.accentText, 'center', mx, cw, y + tPadY, 'title', pill);
    },
  });

  if (!eligible || !found) {
    const msg = eligibleSlots(state).length === 0 ? '空きありの枠がありません' : '告知する枠を選んでください';
    const mf = fitText(ctx, msg, { weight: 'bold', size: 48 * s, min: 30, maxLines: 2, maxW: cw - 80 });
    const mh = mf.h + 80 * s;
    sections.push({
      h: mh,
      emit: (y) => {
        const box = b.rect(mx + 20, y, cw - 40, mh, 16, null, P.unsetBorder, [12, 10]);
        b.lines(ctx, mf, P.unsetText, 'center', mx, cw, y + 40 * s, 'placeholder', box);
      },
    });
  } else {
    const slot = found.slot;
    const iso = addDays(state.startDate, found.dayIndex);
    const [yy, mm, dd] = iso.split('-').map(Number);
    const yf = fitText(ctx, `${yy}年`, { weight: 'normal', size: F.year * s, min: 22, maxLines: 1, maxW: cw });
    const df = fitText(ctx, `${mm}月${dd}日(${weekdayLabel(iso)})`, { weight: 'bold', size: F.date * s, min: F.dateMin, maxLines: 1, maxW: cw });
    const tmf = fitText(ctx, slot.time, { weight: 'bold', size: F.time * s, min: F.timeMin, maxLines: 1, maxW: cw });
    const statusSize = Math.round(F.status * s);
    const stH = statusSize * LINE_HEIGHT + 16 * s;
    const lbl = slot.label.trim();
    const lf = lbl ? fitText(ctx, lbl, { weight: 'bold', size: F.label * s, min: F.labelMin, maxLines: 2, maxW: cw }) : null;
    if (lf && !lf.ok) problems.push({ level: 'error', field: `slot:${slot.id}:label`, message: 'メニュー名・補足が長すぎて収まりません。短くしてください。' });
    const dcol = dayColor(P, iso);
    const timeGap = 4 * s;
    const h = yf.h + df.h + timeGap + tmf.h * 0.92 + 10 * s + stH + (lf ? 14 * s + lf.h : 0);
    sections.push({
      h,
      emit: (y) => {
        b.lines(ctx, yf, P.sub, 'center', mx, cw, y, 'year');
        y += yf.h;
        b.lines(ctx, df, dcol, 'center', mx, cw, y, 'date');
        y += df.h + timeGap;
        // 大きな時刻は行送りを詰める(字形は行ボックス内に収まる)
        const tfit = { lines: tmf.lines, weight: tmf.weight, size: tmf.size, lh: tmf.h * 0.92 };
        b.lines(ctx, tfit, P.text, 'center', mx, cw, y, 'time');
        y += tfit.lh + 10 * s;
        const sw = textWidth(ctx, '空きあり', 'bold', statusSize);
        const pill = b.rect(W / 2 - sw / 2 - 28 * s, y, sw + 56 * s, stH, stH / 2, P.openBg);
        b.text(ctx, '空きあり', 'bold', statusSize, P.openText, 'center', mx, cw, y + 8 * s, statusSize * LINE_HEIGHT, 'status', pill);
        y += stH;
        if (lf) {
          y += 14 * s;
          b.lines(ctx, lf, P.text, 'center', mx, cw, y, 'label');
        }
      },
    });
  }

  footer(ctx, state, b, sections, problems, F, s, mx, cw, P, 8);
  return finishLayout(b, sections, 40 * s, W, H, cfg, P, problems, null, 0);
}

/* ---------- 公開関数 ---------- */

export interface RenderResult {
  problems: Issue[];
  texts: PlacedText[];
  width: number;
  height: number;
}

/** レイアウトだけを計算する(描画しない)。scale を 1 → 0.8 まで縮めて収まる大きさを探す */
export function layoutAnnouncement(ctx: Ctx2D, state: AnnState): LayoutResult & { width: number; height: number } {
  const size = CANVAS_SIZES[state.design.size];
  const P = PALETTES[state.design.palette];
  const cfg = BASE[state.design.size];
  const layout = state.output.mode === 'single' ? layoutSingle : layoutWeek;
  let result: LayoutResult | null = null;
  for (let s = 1; s >= MIN_SCALE - 1e-9; s -= 0.05) {
    result = layout(ctx, state, size.w, size.h, s, P, cfg);
    if (result.fits) break;
  }
  const r = result!;
  if (!r.fits) {
    r.problems.push({
      level: 'error',
      field: null,
      message:
        state.design.size === 'square'
          ? '内容が多く、正方形の画像に収まりません。縦長サイズにするか、メニュー名・補足や案内文を短くしてください。'
          : '内容が多く、画像に収まりません。メニュー名・補足や案内文を短くしてください。',
    });
  }
  return { ...r, width: size.w, height: size.h };
}

/** state を canvas に描画する。canvas は出力サイズ(1080×1080 / 1080×1920)に設定される */
export function renderAnnouncement(canvas: CanvasLike, state: AnnState): RenderResult {
  const size = CANVAS_SIZES[state.design.size];
  if (canvas.width !== size.w) canvas.width = size.w;
  if (canvas.height !== size.h) canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('このブラウザでは画像を作成できません(Canvas が使えません)');
  const result = layoutAnnouncement(ctx, state);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  paint(ctx, result.ops);
  ctx.restore();
  return {
    problems: result.problems,
    texts: textsOf(result.ops),
    width: size.w,
    height: size.h,
  };
}

export function textsOf(ops: Op[]): PlacedText[] {
  return ops
    .filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text')
    .map((o) => ({ text: o.text, kind: o.kind, x: o.x, y: o.y, w: o.w, h: o.h, size: o.size, container: o.container }));
}
