// 日報の読み取り・照合・集計（report.ts）のテスト。
// 回答のデータは、実際の日報と同じ形（見出し・日付の書き方・「その他」の会場・テスト回答）に似せた架空のもの。
import { describe, expect, it } from 'vitest';
import { Project, ReportSync, Venue } from '../types';
import { emptyLayout } from './layout';
import {
  RawReportRow, columnLetter, contestedReportDays, findReportColumns, findReportSource, hydrateReportSync, isBlankRow, isTestRow, parseReportCount,
  parseReportDate, parseSheetUrl, planReportSync, reportVenue, syncStaleness, unmatchedGaps, usableReportDays, venueKey, venueKeys,
} from './report';
import { rng } from './testkit';
import { mkProject } from './testkit';

// ── テスト用の部品 ───────────────────────────────────────────
const HEADER = [
  'タイムスタンプ', 'メールアドレス', '入力者', '開催日', '天気', '会場', '会場（その他の場合）', 'イベント名', 'イベント内容',
  '参加組数', '参加人数', 'キットの使用数', 'ピークだった時間帯', '内部用メモ',
];
const mkVenue = (id: string, name: string, reportNames?: string[]): Venue =>
  ({ id, name, feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout(), ...(reportNames ? { reportNames } : {}) });
const row = (date: unknown, venue: unknown, count: unknown, other: unknown = '', event: unknown = ''): RawReportRow =>
  ({ date, venue, venueOther: other, event, count });

const CENTER = '北街モール（中央広場）';
const EAST = '北街モール（東口前）';
const venues = [mkVenue('v-center', CENTER), mkVenue('v-east', EAST), mkVenue('v-minato', 'みなと市場')];
/** 北街モール（中央広場）11/13〜11/17 の案件 */
const P = mkProject({ id: 'p1', name: '秋の花まつり', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-17' });
const NOW = '2026-11-14T09:00:00.000Z';
function plan(rows: RawReportRow[], opts: { project?: Project; projects?: Project[]; venues?: Venue[] } = {}): ReportSync {
  const project = opts.project ?? P;
  const r = planReportSync({ project, projects: opts.projects ?? [project], venues: opts.venues ?? venues, rows, now: NOW });
  if (!r.ok) throw new Error(r.message);
  return r.sync;
}
const dayList = (s: ReportSync) => s.days.map((d) => [d.date, d.count, d.rows]);

/** 実際の日報に似せた回答（上から順） */
const ROWS: RawReportRow[] = [
  row('2026/07/31', 'その他', '13', 'テスト会場', '【テスト】通しテスト'),          // テスト回答
  row('2026/11/12', CENTER, '40'),                                                    // 会期の前日
  row('2026/11/13', CENTER, '62', '', '秋の花まつり'),
  row('2026/11/14', CENTER, '58', '', ''),                                            // イベント名が空欄
  row('2026/11/14', EAST, '33', '', '秋の花まつり'),                                  // 同じ日の、別の会場
  row('2026/11/15', 'その他', '21', 'みなと市場', '朝市'),                            // 同じ日の、別の会場（その他）
  row('2026/11/15', CENTER, '70', '', '別のイベント名 '),                              // イベント名が違う・末尾に空白
  row('2026/11/18', CENTER, '55'),                                                    // 会期の翌日
];

// ── 見出し ──────────────────────────────────────────────────
describe('見出しから、取得する列を決める', () => {
  it('実際の日報と同じ見出しなら、開催日＝D・会場＝F・会場（その他の場合）＝G・イベント名＝H・キットの使用数＝L', () => {
    const r = findReportColumns(HEADER);
    expect(r).toEqual({ ok: true, cols: { date: 3, venue: 5, venueOther: 6, event: 7, count: 11 } });
    if (r.ok) expect([r.cols.date, r.cols.venue, r.cols.venueOther, r.cols.event, r.cols.count].map((i) => columnLetter(i!))).toEqual(['D', 'F', 'G', 'H', 'L']);
  });
  it('列の位置が変わっても、見出しの名前で見つける（質問が増えて列がずれた日報から、別の列の数字を取り込まない）', () => {
    const moved = ['タイムスタンプ', 'メールアドレス', '入力者', '新しい質問', ...HEADER.slice(3)];
    expect(findReportColumns(moved)).toEqual({ ok: true, cols: { date: 4, venue: 6, venueOther: 7, event: 8, count: 12 } });
  });
  it('見出しの全角/半角・空白の違いは同じとみなす', () => {
    const r = findReportColumns(['開催日 ', '会場', '会場(その他の場合)', 'キットの 使用数']);
    expect(r).toEqual({ ok: true, cols: { date: 0, venue: 1, venueOther: 2, event: null, count: 3 } });
  });
  it('必要な見出しが無ければエラー（取り込まない）。イベント名・会場（その他の場合）は無くてもよい', () => {
    expect(findReportColumns(['開催日', '会場', '参加人数'])).toEqual({ ok: false, missing: ['キットの使用数'], duplicated: [] });
    expect(findReportColumns([])).toEqual({ ok: false, missing: ['開催日', '会場', 'キットの使用数'], duplicated: [] });
    expect(findReportColumns(['開催日', '会場', 'キットの使用数'])).toEqual({ ok: true, cols: { date: 0, venue: 1, venueOther: null, event: null, count: 2 } });
  });
  it('同じ見出しが 2 つあればエラー（どちらの列か決められない）', () => {
    expect(findReportColumns(['開催日', '会場', 'キットの使用数', 'キットの使用数'])).toEqual({ ok: false, missing: [], duplicated: ['キットの使用数'] });
  });
  it('列名（A1 形式）', () => {
    expect([0, 3, 11, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'D', 'L', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

// ── 1 件の回答の読み取り ───────────────────────────────────────
describe('開催日の読み取り', () => {
  it('年月日の文字列（区切りは / - . 年月日。後ろに曜日・時刻が付いてもよい）', () => {
    for (const s of ['2026/07/31', '2026-07-31', '2026/7/31', '2026.7.31', '2026年7月31日', '２０２６／０７／３１', ' 2026/07/31 ', '2026/07/31 0:00:00', '2026年7月31日（金）', '2026/07/31(金)']) {
      expect(parseReportDate(s), s).toBe('2026-07-31');
    }
  });
  it('スプレッドシートの日付の通し番号', () => {
    expect(parseReportDate(46234)).toBe('2026-07-31');      // 2025-01-01 が 45658
    expect(parseReportDate(45658)).toBe('2025-01-01');
    expect(parseReportDate(46339)).toBe('2026-11-13');
    expect(parseReportDate(46234.75)).toBe('2026-07-31');   // 時刻つきは日付の部分だけ
  });
  it('読み取れないものは null（推測しない）', () => {
    for (const v of ['', '7/31', '7月31日', '07/31/2026', '2026/13/01', '2026/02/30', 'きのう', '20260731', 0, 1, 20260731, -5, Number.NaN, null, undefined, true, {}]) {
      expect(parseReportDate(v), String(v)).toBeNull();
    }
  });
});

describe('キットの使用数の読み取り', () => {
  it('0 以上の整数（数値・文字列・全角・桁区切り）', () => {
    expect(parseReportCount(98)).toBe(98);
    expect(parseReportCount(0)).toBe(0);
    expect(parseReportCount('98')).toBe(98);
    expect(parseReportCount(' 98 ')).toBe(98);
    expect(parseReportCount('９８')).toBe(98);
    expect(parseReportCount('1,234')).toBe(1234);
    expect(parseReportCount('0')).toBe(0);
  });
  it('空欄・数字でない・小数・マイナスは null（0 個として数えない）', () => {
    for (const v of ['', ' ', '約50', '50個', '12.5', 12.5, -1, '-1', '５０くらい', Number.NaN, Infinity, null, undefined, true]) {
      expect(parseReportCount(v), String(v)).toBeNull();
    }
  });
});

describe('会場名', () => {
  it('会場が「その他」のときは「会場（その他の場合）」を使う。会場が空欄でも同じ', () => {
    expect(reportVenue(row('', CENTER, ''))).toEqual({ name: CENTER, key: venueKey(CENTER) });
    expect(reportVenue(row('', 'その他', '', 'みなと市場'))).toEqual({ name: 'みなと市場', key: 'みなと市場' });
    expect(reportVenue(row('', ' その他 ', '', ' みなと市場 '))?.name).toBe('みなと市場');
    expect(reportVenue(row('', '', '', 'みなと市場'))?.name).toBe('みなと市場');
    expect(reportVenue(row('', 'その他', '', ''))).toBeNull();
    expect(reportVenue(row('', '', ''))).toBeNull();
  });
  it('会場に名前があるときは、「会場（その他の場合）」に何か書かれていても会場を使う', () => {
    expect(reportVenue(row('', CENTER, '', 'みなと市場'))?.name).toBe(CENTER);
  });
  it('比べるときにそろえるのは、全角/半角・空白・英字の大小だけ', () => {
    expect(venueKey('北街モール（中央広場）')).toBe(venueKey('北街モール(中央広場)'));
    expect(venueKey('北街モール （中央広場） ')).toBe(venueKey('北街モール（中央広場）'));
    expect(venueKey('ＡＢＣ　Ｍａｌｌ')).toBe(venueKey('abc mall'));
    expect(venueKey('ｻﾞ･ﾋﾞｯｸﾞ')).toBe(venueKey('ザ・ビッグ'));
    // 文字そのものが違うものは、同じにしない
    expect(venueKey('北街モール（中央広場）')).not.toBe(venueKey('北街モール（東口前）'));
    expect(venueKey('北街モール')).not.toBe(venueKey('北街モール（中央広場）'));
    expect(venueKey('みなと市場')).not.toBe(venueKey('港市場'));
  });
});

describe('テスト回答の判定', () => {
  it('会場名かイベント名に「テスト」「test」が入っていれば、テスト回答', () => {
    expect(isTestRow(row('2026/07/31', 'その他', '13', 'テスト会場', '【テスト】通しテスト'))).toBe(true);
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', '【テスト】入力確認'))).toBe(true);
    expect(isTestRow(row('2026/11/13', 'その他', '5', 'ﾃｽﾄ', ''))).toBe(true);
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', 'TEST'))).toBe(true);
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', 'test 送信'))).toBe(true);
  });
  it('ふつうの回答は、テスト回答にしない', () => {
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', '秋の花まつり'))).toBe(false);
    expect(isTestRow(row('2026/11/13', CENTER, '5'))).toBe(false);
    expect(isTestRow(row('2026/11/13', 'その他', '5', 'Contest Hall', 'Latest Flowers'))).toBe(false);   // 単語の一部の test は数えない
  });
});

// ── 照合と集計 ────────────────────────────────────────────────
describe('会場＋会期で照合して、日別に集計する', () => {
  it('会期内（両端を含む）で、会場が一致する回答だけを取り込む。同じ日の別会場・会期の外・テスト回答は入れない', () => {
    const s = plan(ROWS);
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 58, 1], ['2026-11-15', 70, 1]]);
    expect([s.rowsRead, s.rowsUsed, s.tests]).toEqual([8, 3, 1]);
    expect(s.skipped).toEqual([]);
    expect(s.held).toEqual([]);
    expect([s.at, s.venueId, s.startDate, s.endDate]).toEqual([NOW, 'v-center', '2026-11-13', '2026-11-17']);
  });
  it('会期の最初の日と最後の日は含み、その前後は含まない', () => {
    const s = plan([row('2026/11/12', CENTER, '1'), row('2026/11/13', CENTER, '2'), row('2026/11/17', CENTER, '4'), row('2026/11/18', CENTER, '8')]);
    expect(dayList(s)).toEqual([['2026-11-13', 2, 1], ['2026-11-17', 4, 1]]);
  });
  it('イベント名は照合に使わない（空欄でも、名前が違っても、会場と開催日が合えば取り込む）', () => {
    const s = plan([row('2026/11/13', CENTER, '10', '', ''), row('2026/11/14', CENTER, '20', '', '別のイベント'), row('2026/11/15', CENTER, '30', '', '秋の花まつり')]);
    expect(s.days.map((d) => d.count)).toEqual([10, 20, 30]);
  });
  it('同じ会場・同じ日の回答が複数あれば合算し、もとの回答の数を持つ', () => {
    const s = plan([row('2026/11/13', CENTER, '40'), row('2026/11/13', CENTER, '25'), row('2026/11/14', CENTER, '0')]);
    expect(dayList(s)).toEqual([['2026-11-13', 65, 2], ['2026-11-14', 0, 1]]);
  });
  it('通し番号の日付・数値のセルでも同じ結果になる', () => {
    const s = plan([row(46339, CENTER, 62), row(46340, CENTER, 58)]);
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 58, 1]]);
  });
  it('会場が「その他」の回答は、「会場（その他の場合）」の名前で照合する', () => {
    const project = { ...P, venueId: 'v-minato' };
    const s = plan(ROWS, { project });
    expect(dayList(s)).toEqual([['2026-11-15', 21, 1]]);
  });
  it('会期内で会場名が一致しなかった回答は、取り込まずに、会場名・件数・個数・日付を示す（別名を登録する候補）', () => {
    const s = plan(ROWS);
    expect(s.unmatched).toEqual([
      { venue: 'みなと市場', rows: 1, count: 21, dates: ['2026-11-15'] },
      { venue: EAST, rows: 1, count: 33, dates: ['2026-11-14'] },
    ]);
  });
});

describe('会場名の表記ゆれは、明示的な別名で吸収する（あいまい一致はしない）', () => {
  const rows = [
    row('2026/11/13', '北街モール(中央広場)', '10'),            // 半角かっこ
    row('2026/11/14', ' 北街モール （中央広場）', '20'),          // 空白
    row('2026/11/15', '北街モール 中央広場', '30'),              // かっこ無し ＝ 別の表記
    row('2026/11/16', '北街モール', '40'),                       // 一部だけ
    row('2026/11/17', 'その他', '50', '北街モール1F 中央広場'),  // 自由入力の別表記
  ];
  it('全角/半角・空白の違いだけなら、同じ会場として取り込む。それ以外の違いは取り込まない', () => {
    const s = plan(rows);
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1], ['2026-11-14', 20, 1]]);
    expect(s.unmatched.map((u) => u.venue).sort()).toEqual(['北街モール', '北街モール 中央広場', '北街モール1F 中央広場']);
  });
  it('会場に別名を登録すると、その表記の回答も取り込む', () => {
    const vs = [mkVenue('v-center', CENTER, ['北街モール中央広場', '北街モール1F 中央広場']), venues[1], venues[2]];
    const s = plan(rows, { venues: vs });
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1], ['2026-11-14', 20, 1], ['2026-11-15', 30, 1], ['2026-11-17', 50, 1]]);
    expect(s.unmatched).toEqual([{ venue: '北街モール', rows: 1, count: 40, dates: ['2026-11-16'] }]);
    expect([...venueKeys(vs[0])].sort()).toEqual([venueKey('北街モール1F中央広場'), venueKey(CENTER), venueKey('北街モール中央広場')].sort());
  });
  it('別名が空欄・空白だけのものは無視する', () => {
    expect(venueKeys(mkVenue('v', '会場', ['', '  ']))).toEqual(new Set(['会場']));
    expect(venueKeys(undefined).size).toBe(0);
  });
});

describe('会場名が一致しない回答のうち、確認を求めるもの', () => {
  it('同じ会期に、別の会場の回答があるだけなら、確認を求めない（この案件の実績がその日にある）', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', CENTER, '58'), row('2026/11/14', EAST, '33')]);
    expect(s.unmatched.map((u) => u.venue)).toEqual([EAST]);
    expect(unmatchedGaps(s)).toEqual([]);
  });
  it('この案件の実績が無い日に、別の書き方の会場名の回答があれば、確認を求める（書き方が違うだけかもしれない）', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '58', '北街モール1F 中央広場'), row('2026/11/13', EAST, '33')]);
    expect(unmatchedGaps(s).map((u) => u.venue)).toEqual(['北街モール1F 中央広場']);
  });
  it('1 件も取り込めていないときは、会期内の別の会場名の回答すべてについて確認を求める', () => {
    const s = plan([row('2026/11/13', 'その他', '62', '北街モール中央'), row('2026/11/14', EAST, '33')]);
    expect(unmatchedGaps(s).map((u) => u.venue).sort()).toEqual([EAST, '北街モール中央'].sort());
  });
  it('保留にした日（会期が重なる案件がある日）は、実績が無い日として扱わない', () => {
    const Q = mkProject({ id: 'p2', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-14', endDate: '2026-11-14' });
    const s = plan([row('2026/11/14', CENTER, '58'), row('2026/11/14', EAST, '33')], { projects: [P, Q] });
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-14']);
    expect(unmatchedGaps(s)).toEqual([]);
  });
  it('同期していない案件', () => {
    expect(unmatchedGaps(undefined)).toEqual([]);
  });
});

describe('何度同期しても二重計上しない・修正と削除を反映する', () => {
  it('同じ日報をもう一度同期しても、結果は同じ（前回の結果に足し込まない）', () => {
    const first = plan(ROWS);
    const again = plan(ROWS, { project: { ...P, reportSync: first } });
    expect(again.days).toEqual(first.days);
    expect(again).toEqual(first);
    const third = plan(ROWS, { project: { ...P, reportSync: again } });
    expect(third.days.reduce((s, d) => s + d.count, 0)).toBe(62 + 58 + 70);
  });
  it('日報の回答が修正されたら、修正後の値になる', () => {
    const first = plan(ROWS);
    const edited = ROWS.map((r) => (r.date === '2026/11/14' && r.venue === CENTER ? { ...r, count: '85' } : r));
    const s = plan(edited, { project: { ...P, reportSync: first } });
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 85, 1], ['2026-11-15', 70, 1]]);
  });
  it('日報の回答が消されたら、その日の実績も無くなる（行ごと削除・中身だけ消した空行のどちらでも）', () => {
    const first = plan(ROWS);
    const removed = ROWS.filter((r) => !(r.date === '2026/11/13' && r.venue === CENTER));
    expect(dayList(plan(removed, { project: { ...P, reportSync: first } }))).toEqual([['2026-11-14', 58, 1], ['2026-11-15', 70, 1]]);
    const blanked = ROWS.map((r) => (r.date === '2026/11/13' && r.venue === CENTER ? row('', '', '') : r));
    const s = plan(blanked, { project: { ...P, reportSync: first } });
    expect(dayList(s)).toEqual([['2026-11-14', 58, 1], ['2026-11-15', 70, 1]]);
    expect(s.rowsRead).toBe(7);                                  // 空行は「読んだ回答」に数えない
  });
  it('回答が増えたら、増えた日が加わる', () => {
    const s = plan([...ROWS, row('2026/11/16', CENTER, '44')]);
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
  });
  it('回答が 1 件も無い日報でも、結果は作れる（実績 0 日）', () => {
    const s = plan([]);
    expect([s.days, s.rowsRead, s.rowsUsed]).toEqual([[], 0, 0]);
  });
  it('入力（案件・回答）を書き換えない', () => {
    const rows = ROWS.map((r) => Object.freeze({ ...r }));
    const project = Object.freeze({ ...P });
    const before = JSON.stringify([rows, project, venues]);
    plan(rows as RawReportRow[], { project });
    expect(JSON.stringify([rows, project, venues])).toBe(before);
  });
});

describe('テスト回答を実績に混ぜない', () => {
  it('会場と開催日が案件と一致していても、イベント名に「テスト」とあれば取り込まない', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/13', CENTER, '5', '', '【テスト】送信確認')]);
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1]]);
    expect([s.rowsRead, s.rowsUsed, s.tests]).toEqual([2, 1, 1]);
  });
  it('テスト会場の回答は、会期内でも「会場名が一致しない回答」に出さない', () => {
    const s = plan([row('2026/11/13', 'その他', '13', 'テスト会場', '')]);
    expect([s.tests, s.unmatched, s.days]).toEqual([1, [], []]);
  });
});

describe('読み取れない回答は、取り込まずに理由を示す', () => {
  it('会場と開催日は合うが、キットの使用数を読み取れない（空欄を含む）', () => {
    const s = plan([row('2026/11/13', CENTER, ''), row('2026/11/13', CENTER, '約50'), row('2026/11/14', CENTER, '12.5'), row('2026/11/15', CENTER, '30')]);
    expect(dayList(s)).toEqual([['2026-11-15', 30, 1]]);
    expect(s.skipped).toEqual([{ reason: 'bad-count', rows: 3, dates: ['2026-11-13', '2026-11-14'] }]);
    expect(s.rowsUsed).toBe(1);
  });
  it('会場は合うが、開催日を読み取れない', () => {
    const s = plan([row('11/13', CENTER, '62'), row('', CENTER, '10'), row('きのう', EAST, '10')]);
    expect(s.skipped).toEqual([{ reason: 'bad-date', rows: 2, dates: [] }]);   // 別の会場の回答は、この案件の問題として数えない
    expect(s.days).toEqual([]);
  });
  it('開催日は会期内だが、会場名が空欄', () => {
    const s = plan([row('2026/11/13', 'その他', '62', ''), row('2026/11/14', '', '10'), row('2026/12/01', '', '10')]);
    expect(s.skipped).toEqual([{ reason: 'no-venue', rows: 2, dates: ['2026-11-13', '2026-11-14'] }]);
  });
});

describe('どの案件の実績か決められないときは、取り込まずに確認を求める', () => {
  // 同じ会場で、会期が 11/15〜11/17 で重なる別の案件
  const Q = mkProject({ id: 'p2', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-20' });
  const rows = [row('2026/11/13', CENTER, '10'), row('2026/11/14', CENTER, '20'), row('2026/11/15', CENTER, '30'), row('2026/11/15', CENTER, '5'), row('2026/11/17', CENTER, '40'), row('2026/11/19', CENTER, '50')];

  it('重なっている日は保留し、相手の案件名・日付・個数を示す。重なっていない日は取り込む', () => {
    const s = plan(rows, { projects: [P, Q] });
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1], ['2026-11-14', 20, 1]]);
    expect(s.held).toEqual([
      { date: '2026-11-15', count: 35, rows: 2, others: ['週末フェア'] },
      { date: '2026-11-17', count: 40, rows: 1, others: ['週末フェア'] },
    ]);
    expect(s.rowsUsed).toBe(2);
    // 相手の案件から見ても同じ（どちらにも黙って入れない）
    const t = plan(rows, { project: Q, projects: [P, Q] });
    expect(dayList(t)).toEqual([['2026-11-19', 50, 1]]);
    expect(t.held.map((h) => [h.date, h.others])).toEqual([['2026-11-15', ['秋の花まつり']], ['2026-11-17', ['秋の花まつり']]]);
  });
  it('「この案件の実績にする」と決めた日は取り込む。相手の案件では、その日を取り込まない', () => {
    const mine = { ...P, reportClaims: ['2026-11-15'] };
    const s = plan(rows, { project: mine, projects: [mine, Q] });
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1], ['2026-11-14', 20, 1], ['2026-11-15', 35, 2]]);
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-17']);
    const t = plan(rows, { project: Q, projects: [mine, Q] });
    expect(dayList(t)).toEqual([['2026-11-19', 50, 1]]);
    expect(t.skipped).toEqual([{ reason: 'other-project', rows: 2, dates: ['2026-11-15'] }]);
    expect(t.held.map((h) => h.date)).toEqual(['2026-11-17']);
  });
  it('両方の案件が同じ日を自分の実績にすると決めていたら、どちらにも取り込まない（確認を求める）', () => {
    const mine = { ...P, reportClaims: ['2026-11-15'] };
    const theirs = { ...Q, reportClaims: ['2026-11-15'] };
    expect(plan(rows, { project: mine, projects: [mine, theirs] }).held.map((h) => h.date)).toEqual(['2026-11-15', '2026-11-17']);
    expect(plan(rows, { project: theirs, projects: [mine, theirs] }).held.map((h) => h.date)).toEqual(['2026-11-15', '2026-11-17']);
  });
  it('中止の案件は相手にしない', () => {
    const s = plan(rows, { projects: [P, { ...Q, status: '中止' }] });
    expect(s.held).toEqual([]);
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-17']);
  });
  it('同じ会場でも会期が重ならない案件、会期が重なっても別の会場の案件は相手にしない', () => {
    const later = { ...Q, startDate: '2026-11-18', endDate: '2026-11-20' };
    const elsewhere = { ...Q, venueId: 'v-east' };
    const s = plan(rows, { projects: [P, later, elsewhere] });
    expect(s.held).toEqual([]);
    expect(s.days.length).toBe(4);
  });
  it('会場マスタは別でも、同じ日報の会場名（別名）を持つ案件は相手になる', () => {
    const vs = [venues[0], mkVenue('v-east', EAST, [CENTER]), venues[2]];
    const other = { ...Q, venueId: 'v-east', startDate: '2026-11-13', endDate: '2026-11-13' };
    const s = plan(rows, { projects: [P, other], venues: vs });
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-13']);
  });
  it('同じ案件が一覧に入っていても、自分自身は相手にしない', () => {
    expect(plan(rows, { projects: [P, { ...P }] }).held).toEqual([]);
  });
  it('3 件の案件が重なる日は、相手の名前をすべて示す', () => {
    const R = mkProject({ id: 'p3', name: '', venueId: 'v-center', startDate: '2026-11-17', endDate: '2026-11-17' });
    const s = plan(rows, { projects: [P, Q, R] });
    expect(s.held.find((h) => h.date === '2026-11-17')!.others).toEqual(['週末フェア', '（名称未設定）']);
  });
});

describe('保存してある実績は、使うたびに、いまの状況と照らす（同じ回答を 2 つの案件で数えない）', () => {
  // 同じ会場で、11/14・11/15 が重なる 2 つの案件
  const A = mkProject({ id: 'pa', name: '秋の花まつり', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-15' });
  const B = mkProject({ id: 'pb', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-14', endDate: '2026-11-16' });
  const rows = [row('2026/11/13', CENTER, '10'), row('2026/11/14', CENTER, '20'), row('2026/11/15', CENTER, '100'), row('2026/11/16', CENTER, '40')];
  const sync = (p: Project, all: Project[]) => ({ ...p, reportSync: plan(rows, { project: p, projects: all }) });
  const used = (p: Project, all: Project[]) => [...usableReportDays(p, { projects: all, venues }).values()].map((d) => [d.date, d.count]);
  const total = (all: Project[]) => all.reduce((s, p) => s + used(p, all).reduce((t, [, c]) => t + (c as number), 0), 0);

  it('取り込んだ実績には、もとになった回答の会場名（照合用の形）を持つ', () => {
    expect(plan(rows, { project: A }).days.map((d) => d.keys)).toEqual([[venueKey(CENTER)], [venueKey(CENTER)], [venueKey(CENTER)]]);
  });

  it('「この案件の実績にする」を取り消したあとの同期が失敗しても、取り消した日の実績は使わない。相手の案件が取り込んでも、二重には数えない', () => {
    // A が 11/15 を自分の実績と決めて同期（100 個を取り込む）
    let a: Project = sync({ ...A, reportClaims: ['2026-11-15'] }, [{ ...A, reportClaims: ['2026-11-15'] }, B]);
    let b: Project = sync(B, [a, B]);
    expect(used(a, [a, b])).toEqual([['2026-11-13', 10], ['2026-11-15', 100]]);
    expect(used(b, [a, b])).toEqual([['2026-11-16', 40]]);
    // A が取り消す。続く同期は失敗（＝同期の結果は前のまま残る）
    a = { ...a, reportClaims: [] };
    expect(a.reportSync!.days.map((d) => d.date)).toContain('2026-11-15');          // 保存してある結果には、まだ入っている
    expect(used(a, [a, b])).toEqual([['2026-11-13', 10]]);                           // が、使わない
    expect(contestedReportDays(a, { projects: [a, b], venues })).toEqual([{ date: '2026-11-15', count: 100, rows: 1, others: ['週末フェア'], state: 'held' }]);
    // その間に、相手の B が同じ日を自分の実績と決めて同期する
    b = sync({ ...b, reportClaims: ['2026-11-15'] }, [a, { ...b, reportClaims: ['2026-11-15'] }]);
    expect(used(b, [a, b])).toEqual([['2026-11-15', 100], ['2026-11-16', 40]]);
    expect(used(a, [a, b])).toEqual([['2026-11-13', 10]]);
    expect(total([a, b])).toBe(10 + 100 + 40);                                       // 100 個は 1 回だけ（11/14 の 20 個は、どちらも決めていないので保留）
    // A から見ると、11/15 は「相手の案件が決めた日」になる
    expect(contestedReportDays(a, { projects: [a, b], venues }).map((h) => [h.date, h.state])).toEqual([['2026-11-15', 'theirs']]);
  });

  it('同期のあとで、同じ会場・重なる会期の案件が増えたら、重なる日の実績は使わない（決めれば、また使う）', () => {
    const a = sync(A, [A]);                                                          // 相手がいない間に、3 日とも取り込んだ
    expect(used(a, [a])).toEqual([['2026-11-13', 10], ['2026-11-14', 20], ['2026-11-15', 100]]);
    expect(used(a, [a, B])).toEqual([['2026-11-13', 10]]);                           // B ができた
    expect(contestedReportDays(a, { projects: [a, B], venues }).map((h) => h.date)).toEqual(['2026-11-14', '2026-11-15']);
    const claimed = { ...a, reportClaims: ['2026-11-14', '2026-11-15'] };
    expect(used(claimed, [claimed, B])).toEqual([['2026-11-13', 10], ['2026-11-14', 20], ['2026-11-15', 100]]);
    // 相手も同じ日を決めたら、どちらも使わない
    const b = { ...B, reportClaims: ['2026-11-15'] };
    expect(used(claimed, [claimed, b])).toEqual([['2026-11-13', 10], ['2026-11-14', 20]]);
    // 相手が中止になった・会期が重ならなくなったら、また使う
    expect(used(a, [a, { ...B, status: '中止' }]).length).toBe(3);
    expect(used(a, [a, { ...B, startDate: '2026-11-16' }]).length).toBe(3);
  });

  it('会場の別名を共有しているだけの案件は、その別名で書かれた回答の日だけが相手になる', () => {
    const vs = [mkVenue('v-center', CENTER, ['北街モール']), mkVenue('v-east', EAST, ['北街モール']), venues[2]];
    const east = mkProject({ id: 'pe', name: '東口の催事', venueId: 'v-east', startDate: '2026-11-13', endDate: '2026-11-15' });
    const mixed = [row('2026/11/13', CENTER, '10'), row('2026/11/14', '北街モール', '20')];
    const s = plan(mixed, { project: A, projects: [A, east], venues: vs });
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1]]);                             // 「北街モール」とだけ書かれた 11/14 は、どちらの会場か決められない
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-14']);
    const a = { ...A, reportSync: s };
    expect([...usableReportDays(a, { projects: [a, east], venues: vs }).keys()]).toEqual(['2026-11-13']);   // 正式な会場名の日は、相手がいても使える
  });

  it('以前の版で同期した実績（会場名の記録が無い）は、案件の会場名すべてを使って確かめる', () => {
    const a = sync(A, [A]);
    const old = { ...a, reportSync: { ...a.reportSync!, days: a.reportSync!.days.map(({ keys: _keys, ...d }) => d) } };
    expect(used(old, [old])).toHaveLength(3);
    expect(used(old, [old, B])).toEqual([['2026-11-13', 10]]);
    expect(hydrateReportSync(old.reportSync)!.days.every((d) => !('keys' in d))).toBe(true);
    expect(hydrateReportSync(a.reportSync)!.days[0].keys).toEqual([venueKey(CENTER)]);
  });

  it('案件と会場の一覧を渡さないとき（1 件の案件だけを見る計算）は、会場と会期だけで決める', () => {
    const a = sync(A, [A]);
    expect([...usableReportDays(a).keys()]).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
  });

  it('中止の案件は、重なる日の実績を自分のものにできない（決定があっても数えない）。進行中の案件は、中止の案件を相手にしない', () => {
    const a = sync(A, [A]);
    const cancelled = { ...a, status: '中止' as const, reportClaims: ['2026-11-14', '2026-11-15'] };
    expect(used(cancelled, [cancelled])).toHaveLength(3);                            // 相手がいなければ、中止でも保存してある実績は見える
    const b = sync(B, [cancelled, B]);                                               // 進行中の B は、中止の A を相手にしないので、重なる日も取り込む
    expect(used(b, [cancelled, b])).toEqual([['2026-11-14', 20], ['2026-11-15', 100], ['2026-11-16', 40]]);
    expect(used(cancelled, [cancelled, b])).toEqual([['2026-11-13', 10]]);           // 中止の A は、決定があっても、重なる日を使わない
    expect(total([cancelled, b])).toBe(10 + 20 + 100 + 40);
    // 中止の案件どうしが重なる日は、どちらも使わない
    const b2 = { ...b, status: '中止' as const };
    expect(used(cancelled, [cancelled, b2])).toEqual([['2026-11-13', 10]]);
    expect(used(b2, [cancelled, b2])).toEqual([['2026-11-16', 40]]);
    // 中止の案件を同期しても、相手がいる日は取り込まない（決定は数えない）
    const s = plan(rows, { project: cancelled, projects: [cancelled, B] });
    expect(dayList(s)).toEqual([['2026-11-13', 10, 1]]);
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-14', '2026-11-15']);
  });

  it('同期のあとで会場名・別名を変えたら、変わった名前で取り込んだ日の実績は使わない（同期し直すまで）', () => {
    const vs = [mkVenue('v-center', CENTER, ['北街モール1F']), venues[1], venues[2]];
    const data = [row('2026/11/13', CENTER, '10'), row('2026/11/14', '北街モール1F', '20'), row('2026/11/15', CENTER, '30'), row('2026/11/15', '北街モール1F', '5')];
    const a = { ...A, reportSync: plan(data, { project: A, venues: vs }) };
    const days = (v: Venue[]) => [...usableReportDays(a, { projects: [a], venues: v }).keys()];
    expect(days(vs)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
    expect(syncStaleness(a, { projects: [a], venues: vs }).names).toBe(false);
    // 別名を外す → その別名の回答が入っている日（11/14・11/15）は使わない
    expect(days(venues)).toEqual(['2026-11-13']);
    expect(syncStaleness(a, { projects: [a], venues }).names).toBe(true);
    expect(contestedReportDays(a, { projects: [a], venues })).toEqual([]);            // 相手がいるわけではないので、「重なる案件」としては示さない
    // 会場名そのものを変える → 元の名前で取り込んだ日は、どれも使わない
    const renamed = [mkVenue('v-center', '北街モール 新館', ['北街モール1F']), venues[1], venues[2]];
    expect(days(renamed)).toEqual(['2026-11-14']);
    // 会場がマスタから消えた → 使わない
    expect(days([venues[1], venues[2]])).toEqual([]);
    // 別名を戻せば、また使う
    expect(days(vs)).toHaveLength(3);
  });

  it('どんな順番で、決定の変更・同期（成功／失敗）・会期や会場や別名の変更・中止が起きても、同じ会場名・同じ日の回答を 2 つの案件が同時に使うことはない', () => {
    const r = rng(89);
    const int = (n: number) => Math.floor(r() * n);
    const DAYS = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];
    const NAMES = [CENTER, EAST, '北街モール'];                                        // 3 つ目は、どちらの会場の別名にもなりうる名前
    const data = DAYS.flatMap((d, i) => NAMES.map((name, k) => row(d.replace(/-/g, '/'), name, String(10 * (i + 1) + k))));
    let checked = 0;
    let inUse = 0;                                                                  // 実績として使われていた回数（確認が空回りしていないことを見る）
    for (let round = 0; round < 400; round += 1) {
      let alias = [int(2) === 0, int(2) === 0];                                       // 中央広場・東口前が、それぞれ「北街モール」を別名に持つか
      const vs = () => [mkVenue('v-center', CENTER, alias[0] ? ['北街モール'] : []), mkVenue('v-east', EAST, alias[1] ? ['北街モール'] : []), venues[2]];
      let ps: Project[] = [0, 1, 2].map((i) => mkProject({
        id: `p${i}`, name: `案件${i}`, venueId: int(2) ? 'v-center' : 'v-east', startDate: DAYS[int(3)], endDate: DAYS[2 + int(3)],
      }));
      for (let step = 0; step < 30; step += 1) {
        const i = int(3);
        const op = int(8);
        const cur = ps[i];
        let next = cur;
        if (op === 0 || op === 1) {                                 // 同期（成功）
          const res = planReportSync({ project: cur, projects: ps, venues: vs(), rows: data, now: NOW });
          if (res.ok) next = { ...cur, reportSync: res.sync };
        } else if (op === 2) {                                      // 決める（続く同期は失敗＝結果は前のまま）
          next = { ...cur, reportClaims: [...new Set([...(cur.reportClaims ?? []), DAYS[int(5)]])] };
        } else if (op === 3) {                                      // 取り消す（続く同期は失敗＝結果は前のまま）
          const d = DAYS[int(5)];
          next = { ...cur, reportClaims: (cur.reportClaims ?? []).filter((x) => x !== d) };
        } else if (op === 4) {                                      // 会期を変える
          next = { ...cur, startDate: DAYS[int(3)], endDate: DAYS[2 + int(3)] };
        } else if (op === 5) {                                      // 中止にする／戻す
          next = { ...cur, status: cur.status === '中止' ? '計画中' : '中止' };
        } else if (op === 6) {                                      // 会場を変える
          next = { ...cur, venueId: cur.venueId === 'v-center' ? 'v-east' : 'v-center' };
        } else {                                                    // 会場の別名を付ける／外す
          const k = int(2);
          alias = alias.map((v, x) => (x === k ? !v : v));
        }
        ps = ps.map((p, k) => (k === i ? next : p));
        const ctx = { projects: ps, venues: vs() };
        const usable = ps.map((p) => usableReportDays(p, ctx));
        for (const d of DAYS) for (const name of NAMES) {
          const users = ps.filter((_, k) => usable[k].get(d)?.keys?.includes(venueKey(name)));
          expect(users.length, `round ${round} step ${step} ${d} ${name}: ${users.map((p) => p.id).join(',')}`).toBeLessThanOrEqual(1);
          checked += 1;
          inUse += users.length;
        }
      }
    }
    expect(checked).toBe(400 * 30 * DAYS.length * NAMES.length);
    expect(inUse).toBeGreaterThan(10000);
  });
});

describe('照合できない案件は、エラーにして何も作らない', () => {
  const run = (project: Project, vs = venues) => planReportSync({ project, projects: [project], venues: vs, rows: ROWS, now: NOW });
  it('会場が未選択・会場がマスタから削除されている', () => {
    expect(run({ ...P, venueId: '' })).toMatchObject({ ok: false });
    expect(run({ ...P, venueId: 'v-deleted' })).toMatchObject({ ok: false });
  });
  it('会場名が未入力', () => {
    expect(run(P, [mkVenue('v-center', ' ')])).toMatchObject({ ok: false });
  });
  it('会期が未入力・終了日が開始日より前', () => {
    expect(run({ ...P, startDate: '' })).toMatchObject({ ok: false });
    expect(run({ ...P, startDate: '2026-11-17', endDate: '2026-11-13' })).toMatchObject({ ok: false });
  });
});

// ── 同期の結果の使い方 ─────────────────────────────────────────
describe('同期の結果を、いまの案件に使えるか', () => {
  const synced = { ...P, reportSync: plan(ROWS) };
  it('会場・会期が同期のときのままなら、そのまま使える', () => {
    expect([...usableReportDays(synced).keys()]).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
    expect(syncStaleness(synced)).toEqual({ venue: false, period: false, names: false });
  });
  it('会場を変えたら使わない', () => {
    const moved = { ...synced, venueId: 'v-east' };
    expect(usableReportDays(moved).size).toBe(0);
    expect(syncStaleness(moved)).toEqual({ venue: true, period: false, names: false });
  });
  it('会期を変えたら、会期内の日だけ使う（同期のやり直しを勧める）', () => {
    const shorter = { ...synced, startDate: '2026-11-14' };
    expect([...usableReportDays(shorter).keys()]).toEqual(['2026-11-14', '2026-11-15']);
    expect(syncStaleness(shorter)).toEqual({ venue: false, period: true, names: false });
  });
  it('同期していない案件', () => {
    expect(usableReportDays(P).size).toBe(0);
    expect(syncStaleness(P)).toEqual({ venue: false, period: false, names: false });
  });
  it('空行だけの行', () => {
    expect(isBlankRow(row('', '', ''))).toBe(true);
    expect(isBlankRow(row(null, undefined, ' '))).toBe(true);
    expect(isBlankRow(row('', '', 0))).toBe(false);
  });
});

// ── 日報の場所 ────────────────────────────────────────────────
describe('日報の場所（貼り付けた URL から取り出す）', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
  it('スプレッドシートの URL（編集画面・タブ指定つき）と、ID だけ', () => {
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toEqual({ spreadsheetId: ID, gid: null });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1622532141#gid=1622532141`)).toEqual({ spreadsheetId: ID, gid: 1622532141 });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toEqual({ spreadsheetId: ID, gid: 0 });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?usp=sharing`)).toEqual({ spreadsheetId: ID, gid: null });
    expect(parseSheetUrl(`  ${ID}  `)).toEqual({ spreadsheetId: ID, gid: null });
  });
  it('スプレッドシートの URL でないもの・公開用のリンクは受け付けない', () => {
    for (const s of ['', 'abc', 'https://example.com/spreadsheets/d/' + ID, `http://docs.google.com/spreadsheets/d/${ID}/edit`,
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml', `https://docs.google.com/document/d/${ID}/edit`]) {
      expect(parseSheetUrl(s), s).toBeNull();
    }
  });
  it('案件に場所の記録があればそれを使い、無ければ、ほかの案件が最後に使った場所を使う', () => {
    const a = { spreadsheetId: 'sheet-A' }, b = { spreadsheetId: 'sheet-B' };
    const older = { ...P, id: 'q1', reportSource: a, reportSync: { ...plan(ROWS), at: '2026-11-01T00:00:00.000Z' } };
    const newer = { ...P, id: 'q2', reportSource: b, reportSync: { ...plan(ROWS), at: '2026-11-10T00:00:00.000Z' } };
    expect(findReportSource({ ...P, reportSource: a }, [older, newer])).toEqual(a);
    expect(findReportSource(P, [older, newer])).toEqual(b);
    expect(findReportSource(P, [newer, older])).toEqual(b);
    expect(findReportSource(P, [P])).toBeNull();
  });
});
