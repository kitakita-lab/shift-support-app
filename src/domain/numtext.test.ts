import { describe, expect, it } from 'vitest';
import { normalizeNumText, numTextValue } from './numtext';

describe('数値の入力欄に打たれた文字列をそろえる', () => {
  it('半角の数字は、そのまま', () => {
    expect(normalizeNumText('320')).toBe('320');
    expect(normalizeNumText('0')).toBe('0');
    expect(normalizeNumText('')).toBe('');
  });
  it('全角で打った数字・小数点・マイナスは、半角にする', () => {
    expect(normalizeNumText('３２０')).toBe('320');
    expect(normalizeNumText('１２．５')).toBe('12.5');
    expect(normalizeNumText('－５')).toBe('-5');
    expect(normalizeNumText('−5')).toBe('-5');   // U+2212
    expect(normalizeNumText('ー5')).toBe('-5');   // 日本語入力でマイナスのキーを押すと入る長音
    expect(normalizeNumText('１２。５')).toBe('12.5');
  });
  it('桁区切りのカンマ・空白・単位などの文字は取り除く', () => {
    expect(normalizeNumText('1,234')).toBe('1234');
    expect(normalizeNumText('１，２３４')).toBe('1234');
    expect(normalizeNumText(' 12 000 ')).toBe('12000');
    expect(normalizeNumText('220円')).toBe('220');
    expect(normalizeNumText('abc')).toBe('');
  });
  it('入力の途中の形は、そのまま残す（打っている途中で消えない）', () => {
    expect(normalizeNumText('-')).toBe('-');
    expect(normalizeNumText('1.')).toBe('1.');
    expect(normalizeNumText('.5')).toBe('.5');
    expect(normalizeNumText('0120')).toBe('0120');
  });
  it('マイナスは先頭だけ・小数点は最初の 1 つだけ', () => {
    expect(normalizeNumText('5-3')).toBe('53');
    expect(normalizeNumText('--5')).toBe('-5');
    expect(normalizeNumText('1.2.3')).toBe('1.23');
  });
});

describe('値として渡す文字列', () => {
  it('数値として読めるものは、そろえた表記で渡す', () => {
    expect(numTextValue('320')).toBe('320');
    expect(numTextValue('３２０')).toBe('320');
    expect(numTextValue('1.')).toBe('1.');
    expect(Number(numTextValue('1.'))).toBe(1);
    expect(Number(numTextValue('0120'))).toBe(120);
    expect(Number(numTextValue('-.5'))).toBe(-0.5);
  });
  it('数値として読めないものは空欄として渡す（NaN を作らない）', () => {
    for (const s of ['', '-', '.', '-.', 'abc', '　']) expect(numTextValue(s)).toBe('');
  });
  it('末尾の 1 桁だけを消して打ち直す操作（321 → 32 → 320）が、そのまま値になる', () => {
    expect(numTextValue('321')).toBe('321');
    expect(numTextValue('32')).toBe('32');
    expect(numTextValue('320')).toBe('320');
  });
});
