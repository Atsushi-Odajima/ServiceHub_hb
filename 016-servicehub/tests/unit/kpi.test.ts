import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, parseCsv, unescapeCell } from '../../src/server/modules/csv/format.js';
import { mergeIvs, rate, subtractIvs, utilizationOf, type Iv } from '../../src/server/modules/kpi/service.js';

const H = 3600_000;
const iv = (a: number, b: number): Iv => [a * H, b * H];

describe('稼働率(CALCULATION_RULES.md §5)', () => {
  it('勤務8h・休憩1h・予約3h(buffer は含めない)→ 3/7 = 42.9%', () => {
    const u = utilizationOf([iv(9, 17)], [iv(12, 13)], [iv(9, 10), iv(10, 11), iv(14, 15)], iv(0, 24));
    expect(u).toEqual({ availableMin: 420, occupiedMin: 180, outsideShift: 0 });
    expect(rate(u.occupiedMin, u.availableMin).value).toBeCloseTo(3 / 7, 5);
  });

  it('勤務なしは分母0で null(0% にしない)', () => {
    const u = utilizationOf([], [], [iv(9, 10)], iv(0, 24));
    expect(u.availableMin).toBe(0);
    expect(u.outsideShift).toBe(1);
    expect(rate(u.occupiedMin, u.availableMin)).toEqual({ value: null, numerator: 0, denominator: 0 });
  });

  it('シフト外にはみ出す予約は重なった分だけ分子に入れ、シフト外予約として数える', () => {
    const u = utilizationOf([iv(9, 12)], [], [iv(11, 13)], iv(0, 24));
    expect(u).toEqual({ availableMin: 180, occupiedMin: 60, outsideShift: 1 });
  });

  it('休憩・休暇が重なっても差し引きは1回だけ', () => {
    const u = utilizationOf([iv(9, 17)], [iv(12, 13), iv(12.5, 13.5), iv(12, 13)], [], iv(0, 24));
    expect(u.availableMin).toBe(8 * 60 - 90);
  });

  it('期間外の勤務は切り取る', () => {
    const u = utilizationOf([iv(20, 26)], [], [], iv(0, 24));
    expect(u.availableMin).toBe(4 * 60);
  });

  it('区間の結合・差分', () => {
    expect(mergeIvs([iv(1, 3), iv(2, 4), iv(5, 6)])).toEqual([iv(1, 4), iv(5, 6)]);
    expect(subtractIvs([iv(1, 10)], [iv(2, 3), iv(5, 7)])).toEqual([iv(1, 2), iv(3, 5), iv(7, 10)]);
  });
});

describe('CSV', () => {
  it('数式インジェクション対策: 文字列の先頭 = + - @ に \' を付ける(数値は付けない)', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+81')).toBe("'+81");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell('\tx')).toBe("'\tx");
  });

  it('カンマ・引用符・改行は引用し、読み込みで元に戻る', () => {
    const values = ['山田, 花子', '"引用"', '1行目\n2行目', '', null, 12, '=1+1'];
    const line = csvLine(values);
    expect(line.endsWith('\r\n')).toBe(true);
    const [row] = parseCsv(`﻿${line}`);
    expect(row.map(unescapeCell)).toEqual(['山田, 花子', '"引用"', '1行目\n2行目', '', '', '12', '=1+1']);
  });

  it('LF・CRLF 混在と空行・末尾改行', () => {
    expect(parseCsv('a,b\r\n1,2\n\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('閉じていない引用符はエラー', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow();
  });
});
