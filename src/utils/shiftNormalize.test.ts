import { describe, it, expect } from 'vitest';
import {
  cleanSiteName,
  buildNormalizedSiteKey,
  buildSiteIdentityKey,
} from './shiftNormalize';

// ─────────────────────────────────────────────────────────────
// これらは characterization テスト（現在の出力を「正」として固定する）。
//
// buildNormalizedSiteKey / buildSiteIdentityKey は
// 現場グルーピング・再インポート判定・重複除外の唯一の同一性基準であり、
// 出力が 1 文字でも変わると既存 Firestore/localStorage データとの
// 同一性判定がずれて重複現場が発生する。
// 意図的にキー生成仕様を変更する場合のみ、このテストを更新すること。
// ─────────────────────────────────────────────────────────────

describe('cleanSiteName', () => {
  it('"+N名" を除去する（半角）', () => {
    expect(cleanSiteName('WB小樽+2名 ネイチャー')).toBe('WB小樽 ネイチャー');
  });

  it('"＋N名" を除去する（全角プラス）', () => {
    expect(cleanSiteName('渋谷＋3名')).toBe('渋谷');
  });

  it('"+N"（名なし）も除去する', () => {
    expect(cleanSiteName('渋谷+2')).toBe('渋谷');
  });

  it('※以降をすべて除去する', () => {
    expect(cleanSiteName('イオン厚別 ※サテライト')).toBe('イオン厚別');
  });

  it('末尾の補足語（サテ/臨時/応援/短縮営業）を除去する', () => {
    expect(cleanSiteName('イオン厚別 サテ')).toBe('イオン厚別');
    expect(cleanSiteName('イオン厚別 臨時')).toBe('イオン厚別');
    expect(cleanSiteName('イオン厚別 応援')).toBe('イオン厚別');
    expect(cleanSiteName('イオン厚別 短縮営業')).toBe('イオン厚別');
  });

  it('末尾以外・単語の一部は過剰除去しない', () => {
    // 「サテライト」は「サテ」+末尾 ではないので残る（過剰除去防止）
    expect(cleanSiteName('札幌 サテライトビル')).toBe('札幌 サテライトビル');
  });

  it('連続スペース・全角スペースを半角スペース1個に圧縮する', () => {
    expect(cleanSiteName('現場A   現場B')).toBe('現場A 現場B');
    expect(cleanSiteName('現場A　現場B')).toBe('現場A 現場B');
  });

  it('前後の空白を除去する', () => {
    expect(cleanSiteName('  Bivi新札幌  ')).toBe('Bivi新札幌');
  });

  it('空文字はそのまま空文字を返す', () => {
    expect(cleanSiteName('')).toBe('');
  });
});

describe('buildNormalizedSiteKey（表記ゆれの同一判定）', () => {
  it('全角英数と半角英数を同一視する', () => {
    expect(buildNormalizedSiteKey('ＢｉＶｉ新札幌')).toBe(buildNormalizedSiteKey('BiVi新札幌'));
    expect(buildNormalizedSiteKey('現場１２３')).toBe(buildNormalizedSiteKey('現場123'));
  });

  it('大文字小文字を同一視する', () => {
    expect(buildNormalizedSiteKey('BIVI新札幌')).toBe(buildNormalizedSiteKey('bivi新札幌'));
  });

  it('スペース有無を同一視する（半角・全角・連続）', () => {
    const base = buildNormalizedSiteKey('アリオハーベストコート');
    expect(buildNormalizedSiteKey('アリオ ハーベストコート')).toBe(base);
    expect(buildNormalizedSiteKey('アリオ　ハーベストコート')).toBe(base);
    expect(buildNormalizedSiteKey('  アリオ  ハーベストコート  ')).toBe(base);
  });

  it('括弧の全角半角を同一視する（括弧自体は除去される）', () => {
    expect(buildNormalizedSiteKey('イオン厚別（２階）')).toBe(
      buildNormalizedSiteKey('イオン厚別(2階)'),
    );
  });

  it('"+N名" 汚染の有無を同一視する', () => {
    expect(buildNormalizedSiteKey('WB小樽+2名')).toBe(buildNormalizedSiteKey('WB小樽'));
  });

  it('clientName が異なれば別キーになる', () => {
    expect(buildNormalizedSiteKey('会場A', undefined, 'クライアントX')).not.toBe(
      buildNormalizedSiteKey('会場A', undefined, 'クライアントY'),
    );
  });

  it('clientName 未指定と空文字は同一キーになる', () => {
    expect(buildNormalizedSiteKey('会場A')).toBe(buildNormalizedSiteKey('会場A', undefined, ''));
  });

  it('subSiteName が異なれば別キーになる', () => {
    expect(buildNormalizedSiteKey('会場A', '2階')).not.toBe(
      buildNormalizedSiteKey('会場A', '1階'),
    );
  });

  it('subSiteName の空文字・空白のみは「なし」と同一視する', () => {
    const base = buildNormalizedSiteKey('会場A');
    expect(buildNormalizedSiteKey('会場A', '')).toBe(base);
    expect(buildNormalizedSiteKey('会場A', '   ')).toBe(base);
  });

  it('subSiteName ありは subSiteName なしと別キーになる', () => {
    expect(buildNormalizedSiteKey('会場A', '2階')).not.toBe(buildNormalizedSiteKey('会場A'));
  });

  it('siteName と clientName は位置が区別される（結合事故防止）', () => {
    // "AB" + "C" と "A" + "BC" が同一キーにならないこと（\0 区切りの保証）
    expect(buildNormalizedSiteKey('BC', undefined, 'A')).not.toBe(
      buildNormalizedSiteKey('C', undefined, 'AB'),
    );
  });

  it('空文字の siteName でもクラッシュしない', () => {
    expect(() => buildNormalizedSiteKey('')).not.toThrow();
  });

  it('キー形式のスナップショット（意図しない仕様変更の検知）', () => {
    // このスナップショットが変わる変更は既存データとの同一性判定を壊す。
    // キー構造: norm(clientName) + "\0" + norm(siteName) + "\0" + norm(subSiteName)
    expect(buildNormalizedSiteKey('ＢｉＶｉ新札幌（２階）', 'ドラッグ側', 'ティーガイア')).toBe(
      'ティーガイア\u0000bivi新札幌2階\u0000ドラッグ側',
    );
  });
});

describe('buildSiteIdentityKey', () => {
  it('buildNormalizedSiteKey と同一の出力を返す（アルゴリズム共有の保証）', () => {
    const cases: [string, string | undefined, string | undefined][] = [
      ['Bivi新札幌', undefined, undefined],
      ['イオン厚別', '2階ドラッグ側', 'ティーガイア'],
      ['ＷＢ小樽+2名', '', 'クライアント'],
    ];
    for (const [site, sub, client] of cases) {
      expect(buildSiteIdentityKey(site, sub, client)).toBe(
        buildNormalizedSiteKey(site, sub, client),
      );
    }
  });
});
