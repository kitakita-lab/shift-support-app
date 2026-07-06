import { describe, it, expect } from 'vitest';
import { parseSiteCSV } from './csvImport';

// ─────────────────────────────────────────────────────────────
// parseSiteCSV の列解決仕様を固定するテスト。
//
// 目的は「CSVを読むこと」ではなく「誤ったデータを静かに取り込まないこと」。
// - ヘッダーあり: 名前でのみ解決。必須列欠落はファイルエラー。
//   任意列（clientName/memo）欠落は空扱い（隣の列を絶対に誤読しない）。
// - ヘッダーなし: テンプレート列順の位置解決（既存互換）。
// ─────────────────────────────────────────────────────────────

const HEADER_FULL = 'date,siteName,clientName,startTime,endTime,requiredPeople,memo';

describe('parseSiteCSV: 正常系', () => {
  it('テンプレート形式（ヘッダー付き・全列）を読み込める', () => {
    const csv = [
      HEADER_FULL,
      '2026-05-01,WB小樽,△△株式会社,10:00,18:00,3,通常',
      '2026-05-02,南郷7丁目,○○物流,09:00,17:00,2,',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(2);
    expect(valid[0]).toMatchObject({
      date: '2026-05-01',
      siteName: 'WB小樽',
      clientName: '△△株式会社',
      startTime: '10:00',
      endTime: '18:00',
      requiredPeople: 3,
      memo: '通常',
      source: 'csv',
    });
  });

  it('ヘッダーなし（テンプレート列順のデータのみ）は位置ベースで読める【既存互換】', () => {
    const csv = '2026-05-01,WB小樽,△△株式会社,10:00,18:00,3,通常';
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].siteName).toBe('WB小樽');
    expect(valid[0].clientName).toBe('△△株式会社');
  });

  it('列順が変わってもヘッダー名で正しく解決する', () => {
    const csv = [
      'clientName,requiredPeople,date,endTime,siteName,startTime',
      '△△株式会社,3,2026-05-01,18:00,WB小樽,10:00',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid[0]).toMatchObject({
      date: '2026-05-01',
      siteName: 'WB小樽',
      clientName: '△△株式会社',
      startTime: '10:00',
      endTime: '18:00',
      requiredPeople: 3,
    });
  });

  it('不要な未知列が混ざっていても無視して読める', () => {
    const csv = [
      'demandId,date,siteName,clientName,startTime,endTime,requiredPeople,memo,extraCol',
      'D-001,2026-05-01,WB小樽,△△株式会社,10:00,18:00,3,通常,ignored',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid[0].siteName).toBe('WB小樽');
    expect(valid[0].memo).toBe('通常');
  });
});

describe('parseSiteCSV: 任意列の欠落（誤読防止の核心）', () => {
  it('clientName 列が無い場合、隣の列を誤読せず空文字になる', () => {
    // 旧実装: clientName が位置フォールバック(2) = startTime 列を読み "10:00" が混入していた
    const csv = [
      'date,siteName,startTime,endTime,requiredPeople',
      '2026-05-01,WB小樽,10:00,18:00,3',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].clientName).toBe('');          // "10:00" ではない
    expect(valid[0].startTime).toBe('10:00');
  });

  it('memo 列が無い場合、余剰列を誤読せず空文字になる', () => {
    const csv = [
      'date,siteName,clientName,startTime,endTime,requiredPeople,internalNote',
      '2026-05-01,WB小樽,△△株式会社,10:00,18:00,3,社外秘メモ',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid[0].memo).toBe('');                // "社外秘メモ" を memo として拾わない
  });
});

describe('parseSiteCSV: 必須列の欠落（ファイルエラー）', () => {
  it('siteName 列が無い場合はファイルエラーになり1件も取り込まない', () => {
    const csv = [
      'date,clientName,startTime,endTime,requiredPeople',
      '2026-05-01,△△株式会社,10:00,18:00,3',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(valid).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(1);
    expect(errors[0].message).toContain('siteName');
  });

  it('startTime 列が無い場合はファイルエラーになる', () => {
    const csv = [
      'date,siteName,clientName,endTime,requiredPeople',
      '2026-05-01,WB小樽,△△株式会社,18:00,3',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(valid).toEqual([]);
    expect(errors[0].message).toContain('startTime');
  });

  it('複数の必須列が無い場合は全てエラーメッセージに列挙される', () => {
    const csv = [
      'date,siteName',
      '2026-05-01,WB小樽',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(valid).toEqual([]);
    expect(errors[0].message).toContain('startTime');
    expect(errors[0].message).toContain('endTime');
    expect(errors[0].message).toContain('requiredPeople');
  });
});

describe('parseSiteCSV: 想定外入力', () => {
  it('空文字はクラッシュせず空結果を返す', () => {
    expect(parseSiteCSV('')).toEqual({ valid: [], errors: [] });
  });

  it('空白・改行のみもクラッシュせず空結果を返す', () => {
    expect(parseSiteCSV('  \n\n  \n')).toEqual({ valid: [], errors: [] });
  });

  it('未知ヘッダーのみ（date/siteName を含まない）はデータ行として扱われ行エラーになる', () => {
    // hasHeader 判定に該当しないため位置解釈され、日付検証で弾かれる（静かに通らない）
    const csv = [
      'foo,bar,baz,qux,quux',
      'a,b,c,d,e',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(valid).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('日付が不正');
  });

  it('データ行の列数不足は行エラーとしてスキップされる', () => {
    const csv = [
      HEADER_FULL,
      '2026-05-01,WB小樽',
      '2026-05-02,南郷7丁目,○○物流,09:00,17:00,2,',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('列数不足');
  });
});

describe('parseSiteCSV: 集約仕様の固定', () => {
  it('同一 date+clientName+siteName+時間帯の行は requiredPeople を加算して1件に集約する', () => {
    const csv = [
      HEADER_FULL,
      '2026-05-01,WB小樽,△△株式会社,10:00,18:00,2,前半',
      '2026-05-01,WB小樽,△△株式会社,10:00,18:00,3,後半',
    ].join('\n');
    const { valid, errors } = parseSiteCSV(csv);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].requiredPeople).toBe(5);
    expect(valid[0].memo).toBe('前半, 後半');
  });
});
