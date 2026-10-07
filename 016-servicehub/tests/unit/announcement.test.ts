/**
 * ServiceHub 空き枠お知らせ画像: 状態の組み立て(core)とレイアウト(render)の単体テスト。
 * レイアウトは文字幅を「文字数 × 文字サイズ」とみなす計測用の Canvas モックで検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  type AnnState,
  type AvailabilityDay,
  buildAnnouncementState,
  collectIssues,
  eligibleSlots,
  emptyOverrides,
  formatPeriod,
  imageFileName,
  pickSpread,
  resolveDay,
  slotKey,
  visibleSlots,
  weekDates,
  weekdayLabel,
} from '../../src/shared/announcement/core.js';
import { type Ctx2D, layoutAnnouncement, renderAnnouncement, tokenize, wrapText } from '../../src/shared/announcement/render.js';

class FakeCtx implements Ctx2D {
  font = '';
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  textAlign = 'left';
  textBaseline = 'alphabetic';
  drawn: string[] = [];
  measureText(text: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
    // 全角は1文字=size、半角は0.6×size
    let w = 0;
    for (const ch of Array.from(text)) w += /[\x20-\x7e]/.test(ch) ? size * 0.6 : size;
    return { width: w };
  }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  setLineDash() {}
  fillText(text: string) {
    this.drawn.push(text);
  }
  save() {}
  restore() {}
  setTransform() {}
  clearRect() {}
}

const START = '2030-01-07'; // 月曜
const times = (list: string[], available: boolean[]): AvailabilityDay['slots'] =>
  list.map((time, i) => ({ time, startsAt: `${START}T00:00:00Z`, available: available[i] ?? true, seatsAvailable: null }));

function sampleDays(): AvailabilityDay[] {
  return weekDates(START).map((date, i) => {
    if (i === 3) return { date, closed: true, slots: [] };
    if (i === 2) return { date, closed: false, slots: times(['10:00', '11:00'], [false, false]) };
    return {
      date,
      closed: false,
      slots: times(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], [true, true, false, true, true, true, true, true, true]),
    };
  });
}

function build(over: Partial<Parameters<typeof buildAnnouncementState>[0]> = {}): AnnState {
  return buildAnnouncementState({
    shop: { name: 'サンプルネイル', booking: 'ご予約はDMからお願いいたします', note: 'メニューによってご案内できる時間が異なります' },
    design: { palette: 'white', size: 'square' },
    output: { mode: 'week', singleKey: null, singleTitle: 'vacancy' },
    startDate: START,
    days: sampleDays(),
    overrides: emptyOverrides(),
    ...over,
  });
}

describe('announcement core', () => {
  it('formats dates like the original tool', () => {
    expect(weekdayLabel('2030-01-07')).toBe('月');
    expect(weekdayLabel('2030-01-06')).toBe('日');
    expect(formatPeriod('2030-01-07')).toBe('2030年1月7日(月)〜1月13日(日)');
    expect(formatPeriod('2029-12-28')).toBe('2029年12月28日(金)〜2030年1月3日(木)');
  });

  it('pickSpread picks evenly from morning to evening, keeping order', () => {
    expect(pickSpread([1, 2, 3], 4)).toEqual([1, 2, 3]);
    expect(pickSpread([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([1, 4, 6, 9]);
    expect(pickSpread([1, 2, 3, 4, 5], 1)).toEqual([1]);
  });

  it('auto mode: closed / full / slots from availability, up to 4 available slots per day', () => {
    const s = build();
    expect(s.days.map((d) => d.mode)).toEqual(['slots', 'slots', 'full', 'closed', 'slots', 'slots', 'slots']);
    expect(s.days[0].slots.map((x) => x.time)).toEqual(['09:00', '12:00', '15:00', '17:00']);
    expect(s.days[0].slots.every((x) => x.status === 'open')).toBe(true);
  });

  it('manual overrides: day mode, chosen times (incl. full ones), slot status and labels', () => {
    const d0 = weekDates(START)[0];
    const d4 = weekDates(START)[4];
    const ov = emptyOverrides();
    ov.days[d0] = { mode: 'auto', times: ['11:00', '09:00', '99:99'] };
    ov.days[d4] = { mode: 'closed', times: null };
    ov.slotStatus[slotKey(d0, '09:00')] = 'hidden';
    ov.labels[slotKey(d0, '11:00')] = ' ジェルオフ込み ';
    const s = build({ overrides: ov });
    expect(s.days[0].slots.map((x) => [x.time, x.status, x.label])).toEqual([
      ['09:00', 'hidden', ''],
      ['11:00', 'full', 'ジェルオフ込み'],
    ]);
    expect(visibleSlots(s.days[0]).map((x) => x.time)).toEqual(['11:00']);
    expect(s.days[4].mode).toBe('closed');
    expect(visibleSlots(s.days[4])).toEqual([]);
  });

  it('manual times on an otherwise full day show the slots', () => {
    const d2 = weekDates(START)[2];
    const r = resolveDay(sampleDays()[2], { mode: 'auto', times: ['10:00'] });
    expect(r).toMatchObject({ autoMode: 'full', mode: 'slots', times: ['10:00'], manual: true });
    const ov = emptyOverrides();
    ov.days[d2] = { mode: 'auto', times: ['10:00'] };
    expect(build({ overrides: ov }).days[2].slots.map((x) => x.status)).toEqual(['full']);
  });

  it('single mode: selects only an eligible open slot, file names', () => {
    const d1 = weekDates(START)[1];
    const s = build({ output: { mode: 'single', singleKey: slotKey(d1, '12:00'), singleTitle: 'cancel' } });
    expect(s.output.singleSlotId).toBe('d1-1200');
    expect(eligibleSlots(s).length).toBeGreaterThan(0);
    expect(collectIssues(s).filter((i) => i.level === 'error')).toEqual([]);
    expect(imageFileName(s)).toBe('空き枠_1枠_2030-01-08_1200_正方形.png');
    const notEligible = build({ output: { mode: 'single', singleKey: slotKey(d1, '11:00'), singleTitle: 'vacancy' } });
    expect(notEligible.output.singleSlotId).toBeNull();
    expect(collectIssues(notEligible).some((i) => i.field === 'single' && i.level === 'error')).toBe(true);
    expect(imageFileName(build({ design: { palette: 'beige', size: 'story' } }))).toBe('空き枠_週間_2030-01-07_縦長.png');
  });

  it('issues: empty shop name is a warning, a day without visible slots warns, over-long label is an error', () => {
    const d0 = weekDates(START)[0];
    const ov = emptyOverrides();
    ov.days[d0] = { mode: 'slots', times: [] };
    ov.labels[slotKey(weekDates(START)[1], '09:00')] = 'とても長いメニュー名の補足説明';
    const s = build({ shop: { name: '', booking: '', note: '' }, overrides: ov });
    const issues = collectIssues(s);
    expect(issues.find((i) => i.field === 'shop.name')?.level).toBe('warning');
    expect(issues.find((i) => i.field === 'day:0')?.level).toBe('warning');
    expect(issues.some((i) => i.level === 'error' && i.field === 'slot:d1-0900:label')).toBe(true);
  });
});

describe('announcement render (ported layout)', () => {
  it('tokenize keeps words together and applies simple kinsoku', () => {
    expect(tokenize('DM@salon_1から。')).toEqual(['DM@salon_1', 'か', 'ら。']);
    const ctx = new FakeCtx();
    ctx.font = 'bold 10px x';
    expect(wrapText(ctx, 'あいうえおかきくけこ', 50)).toEqual(['あいうえお', 'かきくけこ']);
  });

  for (const size of ['square', 'story'] as const) {
    for (const mode of ['week', 'single'] as const) {
      it(`${mode} / ${size}: fits the canvas and every text stays inside its box`, () => {
        const d1 = weekDates(START)[1];
        const s = build({ design: { palette: 'charcoal', size }, output: { mode, singleKey: slotKey(d1, '12:00'), singleTitle: 'vacancy' } });
        const ctx = new FakeCtx();
        const r = layoutAnnouncement(ctx, s);
        expect(r.problems).toEqual([]);
        expect(r.fits).toBe(true);
        expect([r.width, r.height]).toEqual(size === 'square' ? [1080, 1080] : [1080, 1920]);
        const texts = r.ops.filter((o) => o.t === 'text') as Extract<(typeof r.ops)[number], { t: 'text' }>[];
        expect(texts.length).toBeGreaterThan(5);
        for (const tx of texts) {
          expect(tx.x).toBeGreaterThanOrEqual(0);
          expect(tx.x + tx.w).toBeLessThanOrEqual(r.width + 0.01);
          expect(tx.y + tx.h).toBeLessThanOrEqual(r.height + 0.01);
          if (tx.container) {
            expect(tx.x).toBeGreaterThanOrEqual(tx.container.x - 0.01);
            expect(tx.x + tx.w).toBeLessThanOrEqual(tx.container.x + tx.container.w + 0.01);
          }
        }
        const kinds = new Set(texts.map((x) => x.kind));
        if (mode === 'week') {
          for (const k of ['kicker', 'shop', 'period', 'date', 'time', 'status', 'daybadge', 'booking', 'note']) expect(kinds.has(k)).toBe(true);
        } else {
          for (const k of ['shop', 'title', 'year', 'date', 'time', 'status']) expect(kinds.has(k)).toBe(true);
          expect(texts.find((x) => x.kind === 'time')?.text).toBe('12:00');
        }
      });
    }
  }

  it('reports a problem when the shop name cannot fit', () => {
    const s = build({ shop: { name: 'あ'.repeat(80), booking: '', note: '' } });
    const r = layoutAnnouncement(new FakeCtx(), s);
    expect(r.problems.some((p) => p.field === 'shop.name' && p.level === 'error')).toBe(true);
  });

  it('renderAnnouncement sizes the canvas and paints the texts', () => {
    const ctx = new FakeCtx();
    const canvas = { width: 300, height: 150, getContext: () => ctx };
    const r = renderAnnouncement(canvas, build({ design: { palette: 'white', size: 'story' } }));
    expect([canvas.width, canvas.height]).toEqual([1080, 1920]);
    expect(ctx.drawn).toContain('空き枠のご案内');
    expect(ctx.drawn).toContain('休業');
    expect(ctx.drawn).toContain('満席');
    expect(r.texts.length).toBe(ctx.drawn.length);
  });
});
