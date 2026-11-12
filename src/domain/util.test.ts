// 日付・時刻・丸めなど、試算と警告の土台になる小さな関数の確認。
// テストは日本時間で実行される（vitest.config.ts）。
import { describe, expect, it } from 'vitest';
import { MAX_DAYS, circled, compactDate, daySpan, listDates, localDate, num, periodText, roundYen, shortDate, toMinutes, yen } from './util';

describe('日付', () => {
  it('テストは日本時間で動いている', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-540);
  });
  it('localDate：日本時間の午前 0〜9 時でも「今日」の日付になる（UTC の日付にならない）', () => {
    const morning = new Date('2026-11-12T23:30:00Z');             // 日本時間 2026-11-13 08:30
    expect(morning.toISOString().slice(0, 10)).toBe('2026-11-12'); // toISOString は前日になる（V1 の不具合の原因）
    expect(localDate(morning)).toBe('2026-11-13');
    expect(localDate(new Date('2026-11-12T15:00:00Z'))).toBe('2026-11-13');   // 日本時間 0:00 ちょうど
    expect(localDate(new Date('2026-11-12T14:59:59Z'))).toBe('2026-11-12');   // 日本時間 23:59:59
    expect(localDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05');           // 月・日は 2 桁にそろえる
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('listDates：両端を含む日付の一覧。逆転・未入力・不正は空', () => {
    expect(listDates('2026-11-13', '2026-11-17')).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
    expect(listDates('2026-11-13', '2026-11-13')).toEqual(['2026-11-13']);
    expect(listDates('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(listDates('2026-11-17', '2026-11-13')).toEqual([]);
    expect(listDates('', '2026-11-13')).toEqual([]);
    expect(listDates('2026/11/13', '2026-11-17')).toEqual([]);
  });
  it('listDates は最大 366 日。daySpan は上限なしの日数（上限超えの警告に使う）', () => {
    expect(MAX_DAYS).toBe(366);
    expect(listDates('2026-01-01', '2030-01-01')).toHaveLength(366);
    expect(daySpan('2026-01-01', '2027-01-01')).toBe(366);
    expect(daySpan('2026-01-01', '2027-01-02')).toBe(367);
    expect(daySpan('2026-11-13', '2026-11-17')).toBe(5);
    expect(daySpan('2026-11-13', '2026-11-13')).toBe(1);
    expect(daySpan('2026-11-17', '2026-11-13')).toBe(0);
    expect(daySpan('', '')).toBe(0);
    for (const [s, e] of [['2026-11-13', '2026-11-17'], ['2028-02-27', '2028-03-01'], ['2026-12-30', '2027-01-02']]) {
      expect(daySpan(s, e)).toBe(listDates(s, e).length);
    }
  });
  it('shortDate：月/日(曜日)', () => {
    expect(shortDate('2026-11-13')).toBe('11/13(金)');
    expect(shortDate('2026-11-17')).toBe('11/17(火)');
    expect(shortDate('2026-12-05')).toBe('12/5(土)');
    expect(shortDate('')).toBe('');
  });
});

describe('時刻・数値', () => {
  it('toMinutes："HH:MM" を分にする。不正は null', () => {
    expect(toMinutes('10:00')).toBe(600);
    expect(toMinutes('9:05')).toBe(545);
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('')).toBeNull();
    expect(toMinutes('10時')).toBeNull();
  });
  it('num：空・不正な値は 0 として計算する（入力は禁止しない）', () => {
    expect([num(''), num(null), num(undefined), num('abc'), num(NaN), num(Infinity)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([num('12'), num(12.5), num(-3)]).toEqual([12, 12.5, -3]);
  });
  it('roundYen：円未満を四捨五入（0.5 は切り上げ）。2進小数の誤差で 1 円ずれない', () => {
    expect(roundYen(57.5)).toBe(58);
    expect(roundYen(57.49)).toBe(57);
    expect(1 * 1.15 * 50).toBeLessThan(57.5);            // 素朴に掛けるとこうなる（57.49999999999999）
    expect(Math.round(1 * 1.15 * 50)).toBe(57);          // そのまま Math.round すると 1 円少ない
    expect(roundYen(1 * 1.15 * 50)).toBe(58);
    expect(roundYen((65 / 60) * 1542)).toBe(1671);       // 1670.5 のはずが 1670.4999… になる例
    expect(roundYen(0)).toBe(0);
    expect(roundYen(-57.5)).toBe(-57);                   // マイナスは Math.round と同じ向き
    expect(roundYen(1234567.5)).toBe(1234568);
  });
  it('yen：円表示（3桁区切り・四捨五入）', () => {
    expect(yen(125340)).toBe('¥125,340');
    expect(yen(-38910)).toBe('¥-38,910');
    expect(yen(0)).toBe('¥0');
  });
  it('periodText：会期の表示（配置図用）。年をまたぐときだけ終了日にも年を付ける。未入力・不正・逆転は空', () => {
    expect(periodText('2026-11-13', '2026-11-17')).toBe('2026/11/13(金)〜11/17(火)');
    expect(periodText('2026-11-13', '2026-11-13')).toBe('2026/11/13(金)');
    expect(periodText('2026-12-30', '2027-01-03')).toBe('2026/12/30(水)〜2027/1/3(日)');
    expect(periodText('2026-02-28', '2026-03-01')).toBe('2026/2/28(土)〜3/1(日)');
    expect([periodText('', ''), periodText('2026-11-13', ''), periodText('', '2026-11-17'), periodText('2026-11-18', '2026-11-17'), periodText('abc', '2026-11-17')]).toEqual(['', '', '', '', '']);
  });
  it('compactDate：ファイル名用の日付', () => {
    expect([compactDate('2026-11-13'), compactDate('2026-01-05'), compactDate(''), compactDate('2026/11/13')]).toEqual(['20261113', '20260105', '', '']);
  });
  it('circled：丸数字は ⑳ まで、それ以降は (21)', () => {
    expect([circled(1), circled(2), circled(20), circled(21)]).toEqual(['①', '②', '⑳', '(21)']);
  });
});
