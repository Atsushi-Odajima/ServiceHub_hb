/**
 * ServiceHub 名札・受付表(#010 名札・受付チェック表メーカーの統合): 番号・並び順・ページ分割・文字の収まり判定
 */
import { describe, expect, it } from 'vitest';
import {
  assignNumbers,
  type BadgeBooking,
  buildDocument,
  buildParticipants,
  chunk,
  countLines,
  fitText,
  FONT,
  layoutBadge,
  MAX_PARTICIPANTS,
  naturalCompare,
  pageCounts,
  type Participant,
  type Problem,
  textWidthMm,
  validateEvent,
} from '../../src/shared/namebadge/core.js';

let seq = 0;
function bk(over: Partial<BadgeBooking> = {}): BadgeBooking {
  seq++;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    createdAt: `2030-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    startsAt: '2030-01-10T01:00:00.000Z',
    startTime: '10:00',
    status: 'confirmed',
    partySize: 1,
    customerName: `顧客${seq}`,
    customerKana: null,
    customerTags: [],
    serviceName: 'ヨガ',
    staffName: 'Aki',
    ...over,
  };
}
const OPTS = { partyMode: 'person', sort: 'number', orgField: 'none', showKana: true } as const;
const person = (over: Partial<Participant> = {}): Participant => ({
  number: 'P001',
  bookingId: 'b',
  companion: false,
  partySize: 1,
  name: '山田 花子',
  kana: 'やまだ はなこ',
  org: '',
  startTime: '10:00',
  startsAt: '2030-01-10T01:00:00.000Z',
  ...over,
});

describe('participant numbers', () => {
  it('numbers bookings in the order they were received (created_at, then id), P001 style', () => {
    const a = bk({ createdAt: '2030-01-01T00:00:03Z' });
    const b = bk({ createdAt: '2030-01-01T00:00:01Z' });
    const c = bk({ createdAt: '2030-01-01T00:00:01Z' });
    const m = assignNumbers([a, b, c]);
    expect([m.get(b.id), m.get(c.id), m.get(a.id)]).toEqual(['P001', 'P002', 'P003']);
  });

  it('keeps numbers stable when a booking is canceled (gap remains, others unchanged)', () => {
    const list = [bk({ createdAt: '2030-01-01T00:00:01Z', customerName: 'A' }), bk({ createdAt: '2030-01-01T00:00:02Z', customerName: 'B' }), bk({ createdAt: '2030-01-01T00:00:03Z', customerName: 'C' })];
    const before = buildParticipants(list, OPTS).map((p) => `${p.number}:${p.name}`);
    expect(before).toEqual(['P001:A', 'P002:B', 'P003:C']);
    list[1].status = 'canceled_customer';
    list.push(bk({ createdAt: '2030-01-01T00:00:04Z', customerName: 'D', status: 'no_show' }));
    expect(buildParticipants(list, OPTS).map((p) => `${p.number}:${p.name}`)).toEqual(['P001:A', 'P003:C']);
  });

  it('natural order like the original (P2 < P10, 001 vs 1 by length)', () => {
    expect(['P10', 'P2', 'P1'].sort(naturalCompare)).toEqual(['P1', 'P2', 'P10']);
    expect(['P003-10', 'P003-2', 'P003'].sort(naturalCompare)).toEqual(['P003', 'P003-2', 'P003-10']);
    expect(naturalCompare('001', '1')).toBe(1);
    expect(naturalCompare('a', 'a')).toBe(0);
  });
});

describe('party size', () => {
  it('person mode: one badge per person, companions follow with blank names and sub-numbers', () => {
    const lead = bk({ customerName: '佐藤 一郎', partySize: 3, createdAt: '2030-01-01T00:00:01Z' });
    const other = bk({ customerName: '鈴木', createdAt: '2030-01-01T00:00:02Z' });
    const ps = buildParticipants([other, lead], OPTS);
    expect(ps.map((p) => p.number)).toEqual(['P001', 'P001-2', 'P001-3', 'P002']);
    expect(ps[1]).toMatchObject({ companion: true, name: '', kana: '', org: '佐藤 一郎 様のお連れ様', bookingId: lead.id });
  });

  it('booking mode: one badge per booking, the sheet shows the party size', () => {
    const lead = bk({ customerName: '佐藤 一郎', partySize: 3 });
    const ps = buildParticipants([lead], { ...OPTS, partyMode: 'booking' });
    expect(ps).toHaveLength(1);
    const doc = buildDocument({ participants: ps, excluded: new Set(), eventName: 'ヨガ', eventDate: '', mode: 'both', partyMode: 'booking' });
    expect(doc.sheetPages[0].rows[0].nameText).toBe('佐藤 一郎(3名)');
    expect(doc.countText).toBe('印刷対象：1件(3名)');
  });
});

describe('sort order and fields', () => {
  const list = () => [
    bk({ customerName: '渡辺', customerKana: 'ワタナベ', createdAt: '2030-01-01T00:00:01Z', startsAt: '2030-01-10T03:00:00Z', partySize: 2 }),
    bk({ customerName: '青木', customerKana: 'あおき', createdAt: '2030-01-01T00:00:02Z', startsAt: '2030-01-10T01:00:00Z', customerTags: ['VIP', '会員'] }),
    bk({ customerName: 'Kato', customerKana: null, createdAt: '2030-01-01T00:00:03Z', startsAt: '2030-01-10T02:00:00Z' }),
  ];
  it('kana order (katakana and hiragana alike; latin names without kana first); companions stay with their lead', () => {
    expect(buildParticipants(list(), { ...OPTS, sort: 'kana' }).map((p) => p.number)).toEqual(['P003', 'P002', 'P001', 'P001-2']);
  });
  it('time order for a whole day', () => {
    expect(buildParticipants(list(), { ...OPTS, sort: 'time' }).map((p) => p.number)).toEqual(['P002', 'P003', 'P001', 'P001-2']);
  });
  it('org field options and hiding kana', () => {
    const ps = buildParticipants(list(), { ...OPTS, orgField: 'tags', showKana: false });
    expect(ps.find((p) => p.number === 'P002')).toMatchObject({ org: 'VIP・会員', kana: '' });
    expect(buildParticipants(list(), { ...OPTS, orgField: 'service' })[0].org).toBe('ヨガ');
    expect(buildParticipants(list(), { ...OPTS, orgField: 'staff' })[0].org).toBe('担当 Aki');
  });
});

describe('pages', () => {
  it('10 badges and 20 rows per A4 page, same numbers on both', () => {
    const ps = buildParticipants(Array.from({ length: 23 }, () => bk()), OPTS);
    const doc = buildDocument({ participants: ps, excluded: new Set(), eventName: '交流会', eventDate: '2030年1月10日', mode: 'both', partyMode: 'person' });
    expect(doc.pages).toEqual({ badges: 3, sheet: 2, total: 5 });
    expect(doc.badgePages.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(doc.sheetPages.map((p) => [p.rows.length, p.pageNo, p.pageTotal])).toEqual([
      [20, 1, 2],
      [3, 2, 2],
    ]);
    expect(doc.badgePages.flat().map((b) => b.p.number)).toEqual(doc.sheetPages.flatMap((p) => p.rows.map((r) => r.p.number)));
    expect(doc.problems).toEqual([]);
    expect(pageCounts(23, 'badges')).toEqual({ badges: 3, sheet: 0, total: 3 });
    expect(pageCounts(23, 'sheet')).toEqual({ badges: 0, sheet: 2, total: 2 });
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('excluded participants leave both outputs; empty and over-limit block printing', () => {
    const ps = buildParticipants([bk(), bk()], OPTS);
    const doc = buildDocument({ participants: ps, excluded: new Set(['P001']), eventName: '', eventDate: '', mode: 'both', partyMode: 'person' });
    expect(doc.targets.map((p) => p.number)).toEqual(['P002']);
    expect(doc.countText).toBe('印刷対象人数：1人');
    const none = buildDocument({ participants: ps, excluded: new Set(['P001', 'P002']), eventName: '', eventDate: '', mode: 'both', partyMode: 'person' });
    expect(none.problems.map((p) => p.kind)).toEqual(['empty']);
    const many = buildParticipants([bk({ partySize: MAX_PARTICIPANTS + 1 })], OPTS);
    expect(buildDocument({ participants: many, excluded: new Set(), eventName: '', eventDate: '', mode: 'both', partyMode: 'person' }).problems[0].kind).toBe('limit');
  });

  it('validates event name / date length like the original (40 / 30 chars)', () => {
    expect(validateEvent({ name: 'あ'.repeat(40), date: 'x'.repeat(30) })).toEqual([]);
    expect(validateEvent({ name: 'あ'.repeat(41), date: 'x'.repeat(31) })).toHaveLength(2);
  });
});

describe('text fitting', () => {
  it('estimates widths conservatively (full width 1em, ASCII narrower)', () => {
    expect(textWidthMm('あ', 72)).toBeCloseTo(25.4);
    expect(textWidthMm('a', 72)).toBeLessThan(textWidthMm('W', 72));
    expect(textWidthMm('a', 72)).toBeLessThan(textWidthMm('あ', 72));
  });

  it('counts wrapped lines, breaking at spaces for latin words and anywhere for Japanese', () => {
    const w = textWidthMm('あ'.repeat(10), 10);
    expect(countLines('あ'.repeat(10), 10, w)).toBe(1);
    expect(countLines('あ'.repeat(11), 10, w)).toBe(2);
    expect(countLines('', 10, w)).toBe(0);
    // 長い英単語は途中で折る
    expect(countLines('x'.repeat(100), 10, w)).toBeGreaterThan(2);
    // 語の途中ではなく空白で改行する
    const ww = textWidthMm('Taro ', 10) + 0.1;
    expect(countLines('Taro Yamada', 10, ww)).toBe(3);
  });

  it('picks the largest font size that fits within 2 lines (name 26pt → 16pt)', () => {
    expect(fitText('山田 花子', FONT.badgeName, 82.5, 2)).toMatchObject({ size: 26, ok: true, lines: 1 });
    // 26pt は1行8文字 → 20文字は3行。22pt(1行10文字)で2行に収まる
    expect(fitText('あ'.repeat(20), FONT.badgeName, 82.5, 2)).toMatchObject({ size: 22, ok: true, lines: 2 });
    expect(fitText('あ'.repeat(40), FONT.badgeName, 82.5, 2)).toMatchObject({ size: 16, ok: false });
  });

  it('reports what does not fit instead of silently cutting it (badge and sheet)', () => {
    const problems: Problem[] = [];
    layoutBadge(person({ name: 'あ'.repeat(40) }), '', problems);
    expect(problems.map((p) => p.text)).toEqual(['名札 P001 ' + 'あ'.repeat(40) + ':氏名／表示名が長すぎます(16ptで2行まで)。顧客の表示名を短くしてください。']);
    const doc = buildDocument({ participants: [person({ org: 'い'.repeat(60) })], excluded: new Set(), eventName: '', eventDate: '', mode: 'both', partyMode: 'person' });
    expect(doc.problems.some((p) => p.text.startsWith('名札 P001 山田 花子:所属が長すぎます'))).toBe(true);
    expect(doc.problems.some((p) => p.text.startsWith('受付表 P001 山田 花子:所属が長すぎます'))).toBe(true);
  });

  it('a badge with 2-line kana, 2-line name, 2-line org and 2-line event name still fits (no silent cut)', () => {
    const problems: Problem[] = [];
    const { layout } = layoutBadge(person({ name: 'あ'.repeat(16), kana: 'か'.repeat(48), org: 'そ'.repeat(44) }), 'い'.repeat(40), problems);
    expect(problems).toEqual([]);
    expect(layout).toMatchObject({ namePt: 26, kanaPt: 9, orgPt: 10 });
    expect(layout.eventPt).toBeLessThanOrEqual(8);
  });

  it('flags event names over the original limits and fits the longest allowed one', () => {
    const ok = buildDocument({ participants: [person()], excluded: new Set(), eventName: 'あ'.repeat(40), eventDate: 'x'.repeat(30), mode: 'both', partyMode: 'person' });
    expect(ok.problems).toEqual([]);
    const ng = buildDocument({ participants: [person()], excluded: new Set(), eventName: 'あ'.repeat(41), eventDate: '', mode: 'both', partyMode: 'person' });
    expect(ng.problems.map((p) => p.text)).toContain('イベント名は40文字以内にしてください(現在41文字)。');
  });

  it('companion badges have a blank name and still lay out', () => {
    const ps = buildParticipants([bk({ customerName: '佐藤', partySize: 2 })], OPTS);
    const doc = buildDocument({ participants: ps, excluded: new Set(), eventName: 'ヨガ', eventDate: '', mode: 'both', partyMode: 'person' });
    expect(doc.problems).toEqual([]);
    expect(doc.sheetPages[0].rows.map((r) => r.nameText)).toEqual(['佐藤', '(同行者)']);
  });
});
