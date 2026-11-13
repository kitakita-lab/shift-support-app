// 日報の読み取り・照合・集計（report.ts）のテスト。
// 回答のデータは、実際の日報と同じ形（見出し・日付の書き方・「その他」の会場・テスト回答）に似せた架空のもの。
import { describe, expect, it } from 'vitest';
import { Project, ReportSync, Venue } from '../types';
import { emptyLayout } from './layout';
import {
  MAX_REPORT_COUNT, RawReportRow, ReportIssue, columnLetter, contestedReportDays, countProblem, dateProblem, findReportColumns, findReportSource, hydrateReportSync,
  isBlankRow, isTestRow, parseReportCount, parseReportDate, parseSheetUrl, planReportSync, reportVenue, rivalClaimedDates, syncStaleness,
  unmatchedGaps, usableReportDays, venueKey, venueKeys, venueProblem,
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
  it('0 以上の整数（数値・文字列・全角・3 桁ごとの桁区切り・前後の空白）', () => {
    expect(parseReportCount(98)).toBe(98);
    expect(parseReportCount(0)).toBe(0);
    expect(parseReportCount('98')).toBe(98);
    expect(parseReportCount(' 98 ')).toBe(98);
    expect(parseReportCount('　９８　')).toBe(98);
    expect(parseReportCount('９８')).toBe(98);
    expect(parseReportCount('1,234')).toBe(1234);
    expect(parseReportCount('１，２３４')).toBe(1234);
    expect(parseReportCount('0')).toBe(0);
    expect(parseReportCount('007')).toBe(7);
    expect([parseReportCount(MAX_REPORT_COUNT), parseReportCount('9,999'), parseReportCount('9999')]).toEqual([9999, 9999, 9999]);
  });
  it('空欄・数字でない・小数・マイナスは null（0 個として数えない）', () => {
    for (const v of ['', ' ', '約50', '50個', '12.5', 12.5, -1, '-1', '５０くらい', Number.NaN, Infinity, null, undefined, true]) {
      expect(parseReportCount(v), String(v)).toBeNull();
    }
  });
  it('途中の空白・改行・区切り方の合わないカンマは null（2 つの数をつなげて読まない。「62 58」を 6258 個にしない）', () => {
    for (const v of ['62 58', '６２　５８', '40\n25', '62,58', '12,5', '1,2,3', ',123', '123,', '1,,234', '1 234', '12,34,567']) {
      expect(parseReportCount(v), JSON.stringify(v)).toBeNull();
    }
  });
  it('1 件の回答で 9,999 個を超える値は null（個数のセルが日付として保存されていると、日付の通し番号が数として届く。それを個数にしない）', () => {
    expect(MAX_REPORT_COUNT).toBe(9999);
    for (const v of [10000, '10000', '10,000', 46315, 46341, 32874, '46315', 9999999, '１２３４５６７８９', '9'.repeat(400)]) {
      expect(parseReportCount(v), String(v).slice(0, 20)).toBeNull();
    }
    // 1990 年以降の日付の通し番号は、すべて上限より大きい（「10-20」「11/15」と入力された個数は、今年の日付＝4 万台になる）
    expect(parseReportDate(32874)).toBe('1990-01-01');
    expect(32874).toBeGreaterThan(MAX_REPORT_COUNT);
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
  it('スプレッドシートのエラーの値（#N/A・#REF! など）は、会場名として扱わない', () => {
    for (const e of ['#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', '#ERROR!', ' #n/a ']) {
      expect(reportVenue(row('', e, '')), e).toBeNull();
      expect(reportVenue(row('', 'その他', '', e)), e).toBeNull();
    }
    expect(reportVenue(row('', '#1 ホール', ''))?.name).toBe('#1 ホール');     // # で始まるだけの名前は、会場名
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
  it('「コンテスト」は、テスト回答の目印にしない（コンテストという催しの本物の回答を、黙って捨てない）', () => {
    for (const event of ['ハロウィン仮装コンテスト', 'フォトコンテスト', 'ﾌｫﾄｺﾝﾃｽﾄ', '花のコンテスト 表彰式']) {
      expect(isTestRow(row('2026/11/13', CENTER, '62', '', event)), event).toBe(false);
    }
    expect(isTestRow(row('2026/11/13', 'その他', '62', 'コンテスト広場', ''))).toBe(false);
    // 「コンテスト」のほかに「テスト」があれば、テスト回答
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', '【テスト】フォトコンテスト'))).toBe(true);
    expect(isTestRow(row('2026/11/13', CENTER, '5', '', 'フォトコンテストのテスト送信'))).toBe(true);
    // 取り込まれることも確かめる（以前は、テスト回答として除かれていた）
    const s = plan([row('2026/11/13', CENTER, '62', '', 'ハロウィン仮装コンテスト')]);
    expect([dayList(s), s.tests]).toEqual([[['2026-11-13', 62, 1]], 0]);
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

// ── 読み取れない回答 ──────────────────────────────────────────
// 方針（Issue #88）: 不正値は同期停止。この案件の回答、または、この案件のものかどうかを決められない回答に、
// 読み取れない項目があれば、同期の全体を止める（一部だけ取り込んだ実績を作らない）。確実にこの案件のものでない回答は、外すだけ。
/** 照合が止まること（ok: false）を確かめて、止めた理由を返す */
function stopped(rows: RawReportRow[], opts: { project?: Project; projects?: Project[]; venues?: Venue[] } = {}): { message: string; issues: ReportIssue[] } {
  const project = opts.project ?? P;
  const r = planReportSync({ project, projects: opts.projects ?? [project], venues: opts.venues ?? venues, rows, now: NOW });
  if (r.ok) throw new Error(`同期が止まっていません（取り込まれました: ${JSON.stringify(r.sync.days)}）`);
  expect('sync' in r).toBe(false);                              // 止めたときは、結果を作らない
  return { message: r.message, issues: r.issues ?? [] };
}
/** 読み取れる回答 2 件（日報の 2 行目・3 行目） */
const GOOD = [row('2026/11/13', CENTER, '62'), row('2026/11/14', CENTER, '58')];
const DATE = '開催日', VENUE_H = '会場', OTHER_H = '会場（その他の場合）', COUNT = 'キットの使用数';

describe('読み取れない回答があるときは、同期の全体を止める（一部だけ取り込まない）', () => {
  // [説明, セルの値, 理由に含まれる文]
  const badCounts: [string, unknown, string][] = [
    ['空欄', '', 'が空欄です'],
    ['空白だけ', ' 　 ', 'が空欄です'],
    ['文字列（約50）', '約50', '数字以外の文字'],
    ['単位つき（80個）', '80個', '数字以外の文字'],
    ['漢数字', '八十', '数字以外の文字'],
    ['スプレッドシートのエラー値', '#N/A', '数字以外の文字'],
    ['2 つの数（途中に空白）', '62 58', '数字以外の文字（空白・区切りを含む）'],
    ['2 つの数（全角の空白）', '６２　５８', '数字以外の文字（空白・区切りを含む）'],
    ['2 つの数（改行）', '40\n25', '数字以外の文字（空白・区切りを含む）'],
    ['区切り方の合わないカンマ', '62,58', '数字以外の文字（空白・区切りを含む）'],
    ['小数点の代わりのカンマ', '12,5', '数字以外の文字（空白・区切りを含む）'],
    ['小数（文字）', '12.5', '整数ではありません'],
    ['小数（数値）', 12.5, '整数ではありません'],
    ['マイナス（文字）', '-3', 'マイナスの値'],
    ['マイナス（全角）', '－３', 'マイナスの値'],
    ['マイナス（数値）', -3, 'マイナスの値'],
    ['大きすぎる（数値）', 10000, '大きすぎます（1 件の回答で 9,999 個まで'],
    ['大きすぎる（文字）', '123456789', '大きすぎます'],
    ['大きすぎる（桁区切りつき）', '10,000', '大きすぎます'],
    ['日付として保存された個数（「10-20」と入力 → 通し番号 46315）', 46315, 'セルが日付の形式になっている場合も'],
    ['日付と時刻として保存された個数', 46315.5, '整数ではありません'],
    ['数でない値（真偽値）', true, '数として読み取れません'],
    ['無限大', Infinity, '数として読み取れません'],
  ];
  for (const [name, value, reason] of badCounts) {
    it(`キットの使用数が ${name}: 止めて、開催日・項目・理由・日報の行番号を示す`, () => {
      const { message, issues } = stopped([...GOOD, row('2026/11/15', CENTER, value)]);
      expect(issues).toEqual([{ row: 4, date: '2026-11-15', items: [{ field: COUNT, reason: expect.stringContaining(reason) }] }]);
      expect(issues[0].items[0].reason).toContain(`「${COUNT}」`);
      expect(message).toContain('読み取れない回答が 1 件');
      expect(message).toContain('取り込みを中止');
    });
  }
  it('読み取れる書き方（0・全角・桁区切り・前後の空白・数値のセル）では止めない', () => {
    const s = plan([row('2026/11/13', CENTER, '0'), row('2026/11/14', CENTER, '１，２３４'), row('2026/11/15', CENTER, ' 12 '), row('2026/11/16', CENTER, 9999), row('2026/11/17', CENTER, 0)]);
    expect(s.days.map((d) => d.count)).toEqual([0, 1234, 12, 9999, 0]);
  });

  const badDates: [string, unknown, string][] = [
    ['空欄', '', 'が空欄です'],
    ['年が無い（11/15）', '11/15', '日付として読み取れません'],
    ['存在しない日（2026/02/30）', '2026/02/30', '日付として読み取れません'],
    ['月日があり得ない（2026/13/40）', '2026/13/40', '日付として読み取れません'],
    ['文字列（きのう）', 'きのう', '日付として読み取れません'],
    ['通し番号として小さすぎる数', 12, '日付として読み取れません'],
    ['通し番号として大きすぎる数', 20261115, '日付として読み取れません'],
    ['数でも文字でもない値', true, '日付として読み取れません'],
  ];
  for (const [name, value, reason] of badDates) {
    it(`会場は一致するが、開催日が ${name}: 会期内かどうかを決められないので、止める`, () => {
      const { issues } = stopped([...GOOD, row(value, CENTER, '30')]);
      expect(issues).toEqual([{ row: 4, date: null, items: [{ field: DATE, reason: expect.stringContaining(reason) }] }]);
    });
  }

  it('開催日は会期内だが、会場名が空欄: この案件の回答かどうかを決められないので、止める（「その他」で会場名が未入力の場合を含む）', () => {
    expect(stopped([...GOOD, row('2026/11/15', '', '30')]).issues)
      .toEqual([{ row: 4, date: '2026-11-15', items: [{ field: VENUE_H, reason: `「${VENUE_H}」が空欄です` }] }]);
    expect(stopped([...GOOD, row('2026/11/15', ' 　', '30')]).issues[0].items).toEqual([{ field: VENUE_H, reason: `「${VENUE_H}」が空欄です` }]);
    expect(stopped([...GOOD, row('2026/11/15', 'その他', '30', '')]).issues)
      .toEqual([{ row: 4, date: '2026-11-15', items: [{ field: OTHER_H, reason: `「${VENUE_H}」が「その他」ですが、会場名（「${OTHER_H}」の列）が入っていません` }] }]);
  });
  it('会場名がエラーの値（#N/A など）: 会場名として読み取れないので、空欄と同じに扱って止める（「会場名が一致しない回答」として別名の候補に出さない）', () => {
    expect(stopped([...GOOD, row('2026/11/15', '#N/A', '30')]).issues)
      .toEqual([{ row: 4, date: '2026-11-15', items: [{ field: VENUE_H, reason: `「${VENUE_H}」がエラーの値です（会場名として読み取れません）` }] }]);
    expect(stopped([...GOOD, row('きのう', 'その他', '30', '#REF!')]).issues[0].items.map((x) => x.field)).toEqual([DATE, OTHER_H]);
    expect(plan([...GOOD, row('2026/12/01', '#N/A', '30')]).unmatched).toEqual([]);      // 会期の外なら、外すだけ
  });
  it('開催日も会場名も読み取れない回答: 止める。読み取れない項目を、すべて挙げる', () => {
    expect(stopped([...GOOD, row('', '', '30')]).issues[0].items.map((x) => x.field)).toEqual([DATE, VENUE_H]);
    expect(stopped([...GOOD, row('きのう', 'その他', 'たくさん', '')]).issues[0].items.map((x) => x.field)).toEqual([DATE, OTHER_H, COUNT]);
    expect(stopped([...GOOD, row('', '', '', '', 'イベント名だけ')]).issues[0].items.map((x) => x.field)).toEqual([DATE, VENUE_H, COUNT]);
    expect(stopped([...GOOD, row('', CENTER, '')]).issues[0].items.map((x) => x.field)).toEqual([DATE, COUNT]);
    expect(stopped([...GOOD, row('2026/11/15', '', 'x')]).issues[0].items.map((x) => x.field)).toEqual([VENUE_H, COUNT]);
  });

  it('止めたときは、読み取れる回答も取り込まない（一部だけの実績を作らない）。日報を直せば、すべて取り込む', () => {
    const rows = [row('2026/11/13', CENTER, '62'), row('2026/11/14', CENTER, '58'), row('2026/11/14', CENTER, '約20'), row('2026/11/15', CENTER, '70')];
    const r = planReportSync({ project: P, projects: [P], venues, rows, now: NOW });
    expect(r.ok).toBe(false);                                     // 11/14 は 58 個だけ、という実績を作らない
    expect(Object.keys(r).sort()).toEqual(['issues', 'message', 'ok']);
    const fixed = rows.map((x) => (x.count === '約20' ? { ...x, count: '20' } : x));
    expect(dayList(plan(fixed))).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 78, 2], ['2026-11-15', 70, 1]]);
  });
  it('読み取れない回答が複数あれば、すべてを日報の行番号の順に挙げる（行番号は、見出しを 1 行目として数える。空行も 1 行）', () => {
    const { message, issues } = stopped([
      row('2026/11/13', CENTER, '62'),          // 2 行目
      row('', '', ''),                          // 3 行目（空行）
      row('2026/11/14', CENTER, ''),            // 4 行目: 個数が空欄
      row('2026/11/12', CENTER, 'x'),           // 5 行目: 会期の外（止める理由にしない）
      row('きのう', CENTER, '10'),              // 6 行目: 開催日
      row('2026/11/16', 'その他', '5', ''),     // 7 行目: 会場名
    ]);
    expect(issues.map((x) => [x.row, x.date, x.items.map((i) => i.field)])).toEqual([
      [4, '2026-11-14', [COUNT]], [6, null, [DATE]], [7, '2026-11-16', [OTHER_H]],
    ]);
    expect(message).toContain('読み取れない回答が 3 件');
  });
  it('止める理由には、回答に書かれていた文字そのものを入れない', () => {
    const { message, issues } = stopped([row('ないしょの日付', CENTER, 'ないしょの個数'), row('2026/11/14', 'その他', 'ないしょ2', '')]);
    expect(JSON.stringify([message, issues])).not.toContain('ないしょ');
  });

  it('別名で一致する回答の読み取れない項目でも、止める。別名に登録していない書き方の回答では、止めない（この案件の回答ではない）', () => {
    const rows = [...GOOD, row('2026/11/15', '北街モール1F 中央広場', '')];
    const s = plan(rows);                                          // 登録していない書き方 ＝ 別の会場名
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 58, 1]]);
    expect(s.unmatched).toEqual([{ venue: '北街モール1F 中央広場', rows: 1, count: 0, dates: ['2026-11-15'] }]);
    const vs = [mkVenue('v-center', CENTER, ['北街モール1F 中央広場']), venues[1], venues[2]];
    expect(stopped(rows, { venues: vs }).issues.map((x) => [x.row, x.items[0].field])).toEqual([[4, COUNT]]);
  });
  it('会期が重なる案件があって、どちらのものか決まっていない日の読み取れない回答では、どちらの案件の同期も止める（両方が決めている場合も同じ）', () => {
    const Q = mkProject({ id: 'p2', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-20' });
    const rows = [...GOOD, row('2026/11/15', CENTER, '30'), row('2026/11/15', CENTER, '')];
    expect(stopped(rows, { projects: [P, Q] }).issues.map((x) => x.row)).toEqual([5]);
    expect(stopped(rows, { project: Q, projects: [P, Q] }).issues.map((x) => x.row)).toEqual([5]);
    const mine = { ...P, reportClaims: ['2026-11-15'] };
    const theirs = { ...Q, reportClaims: ['2026-11-15'] };
    expect(stopped(rows, { project: mine, projects: [mine, theirs] }).issues.map((x) => x.row)).toEqual([5]);
    expect(stopped(rows, { project: theirs, projects: [mine, theirs] }).issues.map((x) => x.row)).toEqual([5]);
  });
  it('一方の案件だけが「自分の実績にする」と決めている日の読み取れない回答では、決めた案件の同期だけを止める（相手の案件にとっては、確実に自分のものでない回答）', () => {
    const Q = mkProject({ id: 'p2', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-20' });
    const rows = [...GOOD, row('2026/11/15', CENTER, '30'), row('2026/11/15', CENTER, ''), row('2026/11/19', CENTER, '50')];
    const mine = { ...P, reportClaims: ['2026-11-15'] };
    // 決めた案件: 自分の回答に読み取れない項目がある → 止める
    expect(stopped(rows, { project: mine, projects: [mine, Q] }).issues.map((x) => [x.row, x.items[0].field])).toEqual([[5, COUNT]]);
    // 相手の案件: その日の回答は「別の案件に割り当て済み」として外すだけ。ほかの日は取り込む
    const t = plan(rows, { project: Q, projects: [mine, Q] });
    expect(dayList(t)).toEqual([['2026-11-19', 50, 1]]);
    expect(t.skipped).toEqual([{ reason: 'other-project', rows: 2, dates: ['2026-11-15'] }]);
    // 相手の案件の日でも、開催日を読み取れない回答は、どの日のものか決められないので、止める
    expect(stopped([...rows, row('きのう', CENTER, '5')], { project: Q, projects: [mine, Q] }).issues.map((x) => [x.row, x.items[0].field])).toEqual([[7, DATE]]);
    // 中止の案件は、決めていても自分のものにできない: 相手（進行中の案件）が決めていれば外すだけ、決めていなければ止める
    const cancelled = { ...P, status: '中止' as const, reportClaims: ['2026-11-15'] };
    expect(dayList(plan(rows, { project: cancelled, projects: [cancelled, { ...Q, reportClaims: ['2026-11-15'] }] }))).toEqual([['2026-11-13', 62, 1], ['2026-11-14', 58, 1]]);
    expect(stopped(rows, { project: cancelled, projects: [cancelled, Q] }).issues.map((x) => x.row)).toEqual([5]);
  });
});

describe('この案件のものでないと確実に言える回答は、読み取れない項目があっても外すだけ（同期を止めない）', () => {
  const base = plan(GOOD);
  const same = (rows: RawReportRow[]) => {
    const s = plan([...GOOD, ...rows]);
    expect(s.days).toEqual(base.days);
    expect([s.held, s.skipped, s.rowsUsed]).toEqual([base.held, base.skipped, base.rowsUsed]);
    return s;
  };
  it('会期の外の回答（会場が一致・空欄のどちらでも。個数が読み取れなくても）', () => {
    const s = same([row('2026/11/20', CENTER, '多数'), row('2026/11/12', CENTER, ''), row('2026/12/01', '', '10'), row('2026/12/01', 'その他', '', '')]);
    expect(s.unmatched).toEqual([]);
  });
  it('別の会場名の回答（開催日・個数が読み取れなくても）。会期内なら、「会場名が一致しない回答」として示す', () => {
    const s = same([row('きのう', EAST, '10'), row('', EAST, 'x'), row('2026/11/14', EAST, ''), row('2026/11/15', 'その他', '約3', 'みなと市場')]);
    expect(s.unmatched).toEqual([
      { venue: 'みなと市場', rows: 1, count: 0, dates: ['2026-11-15'] },
      { venue: EAST, rows: 1, count: 0, dates: ['2026-11-14'] },
    ]);
  });
  it('テスト回答・空行', () => {
    const s = same([row('', 'その他', 'x', 'テスト会場'), row('きのう', CENTER, '', '', '【テスト】送信確認'), row('', '', ''), row(' ', '　', '')]);
    expect([s.tests, s.rowsRead]).toEqual([2, 4]);
  });
});

describe('回答 1 件の扱い（会場 × 開催日 × 個数のすべての組み合わせ）', () => {
  // 期待する扱いを、実装とは別に、表として書く
  type Outcome = '取り込む' | '止める' | '会場名が一致しない回答' | '外す';
  const venueCases: [string, unknown, unknown, 'mine' | 'other' | 'unknown'][] = [
    ['会場名が一致', CENTER, '', 'mine'],
    ['「その他」＋会場名が一致', 'その他', CENTER, 'mine'],
    ['会場が空欄＋「その他の場合」の会場名が一致', '', CENTER, 'mine'],
    ['別の会場名', EAST, '', 'other'],
    ['「その他」＋別の会場名', 'その他', 'みなと市場', 'other'],
    ['会場名が空欄', '', '', 'unknown'],
    ['「その他」＋会場名が空欄', 'その他', '', 'unknown'],
  ];
  const dateCases: [string, unknown, 'in' | 'out' | 'bad'][] = [
    ['会期内', '2026/11/14', 'in'], ['会期内（通し番号）', 46340, 'in'], ['会期の外', '2026/11/20', 'out'], ['読み取れない', 'きのう', 'bad'], ['空欄', '', 'bad'],
  ];
  const countCases: [string, unknown, boolean][] = [['読み取れる', '10', true], ['読み取れる（数値の 0）', 0, true], ['空欄', '', false], ['文字', 'x', false], ['小数', 1.5, false]];
  const expected = (venue: 'mine' | 'other' | 'unknown', date: 'in' | 'out' | 'bad', countOk: boolean): Outcome => {
    if (date === 'out') return '外す';                                        // 会期の外は、何であっても対象外
    if (venue === 'other') return date === 'in' ? '会場名が一致しない回答' : '外す';   // 別の会場名は、この案件の回答ではない
    if (venue === 'unknown') return '止める';                                  // この案件のものかどうかを決められない
    if (date === 'bad') return '止める';                                       // 会場は一致。会期内かどうかを決められない
    return countOk ? '取り込む' : '止める';                                    // この案件の回答
  };
  for (const [vName, venue, other, vKind] of venueCases) {
    for (const [dName, date, dKind] of dateCases) {
      for (const [cName, count, cOk] of countCases) {
        const blank = [venue, other, date, count].every((x) => x === '');
        const want: Outcome = blank ? '外す' : expected(vKind, dKind, cOk);
        it(`${vName}・開催日が${dName}・個数が${cName} → ${want}`, () => {
          const r = planReportSync({ project: P, projects: [P], venues, rows: [row(date, venue, count, other)], now: NOW });
          const got: Outcome = !r.ok ? '止める' : r.sync.days.length > 0 ? '取り込む' : r.sync.unmatched.length > 0 ? '会場名が一致しない回答' : '外す';
          expect(got).toBe(want);
          if (!r.ok) expect(r.issues).toHaveLength(1);
          if (r.ok && want === '取り込む') expect(dayList(r.sync)).toEqual([['2026-11-14', Number(count), 1]]);
        });
      }
    }
  }

  it('無作為に並べた回答でも、表のとおりになる（止める回答が 1 件でもあれば全体を止め、無ければ、取り込む回答だけを日別に合算する）', () => {
    const rand = rng(20261113);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const inDates: [unknown, string][] = [['2026/11/13', '2026-11-13'], ['2026/11/14', '2026-11-14'], [46341, '2026-11-15'], ['2026年11月17日', '2026-11-17']];
    for (let n = 0; n < 400; n++) {
      const rows: RawReportRow[] = [];
      const stops: number[] = [];
      const sums = new Map<string, number>();
      const size = Math.floor(rand() * 12);
      const clean = rand() < 0.5;                                           // 半分は、止める回答を作らない
      for (let i = 0; i < size; i++) {
        const [, venue, other, vKind] = pick(clean ? venueCases.filter((c) => c[3] !== 'unknown') : venueCases);
        const dKind = pick<'in' | 'out' | 'bad'>(clean && vKind === 'mine' ? ['in', 'in', 'out'] : ['in', 'in', 'out', 'bad']);
        const [dateCell, ymd] = dKind === 'in' ? pick(inDates) : dKind === 'out' ? ['2026/11/18', ''] : [pick<unknown>(['', '11/14', 'x']), ''];
        const cOk = clean && vKind === 'mine' && dKind === 'in' ? true : rand() < 0.7;
        const count = cOk ? Math.floor(rand() * 90) : pick<unknown>(['', '約10', -1, 2.5]);
        const blank = [venue, other, dateCell, count].every((x) => x === '');
        rows.push(row(dateCell, venue, count, other));
        const want = blank ? '外す' : expected(vKind, dKind, cOk);
        if (want === '止める') stops.push(i + 2);
        if (want === '取り込む') sums.set(ymd, (sums.get(ymd) ?? 0) + (count as number));
      }
      const r = planReportSync({ project: P, projects: [P], venues, rows, now: NOW });
      if (stops.length > 0) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect((r.issues ?? []).map((x) => x.row)).toEqual(stops);
      } else {
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.sync.days.map((d) => [d.date, d.count])).toEqual([...sums.entries()].sort((a, b) => a[0].localeCompare(b[0])));
      }
    }
  });
});

describe('読み取れない理由の文（利用者にそのまま見せる）', () => {
  it('読み取れる値には、理由を返さない', () => {
    expect([dateProblem('2026/11/14'), dateProblem(46340), countProblem('0'), countProblem(12), venueProblem(row('', CENTER, '')), venueProblem(row('', 'その他', '', CENTER))])
      .toEqual([null, null, null, null, null, null]);
  });
  it('理由には、直す項目の見出し名が入る', () => {
    expect(dateProblem('')).toBe('「開催日」が空欄です');
    expect(dateProblem('きのう')).toContain('「開催日」を日付として読み取れません');
    expect(countProblem('')).toBe('「キットの使用数」が空欄です');
    expect(countProblem('80個')).toContain('「キットの使用数」に数字以外の文字（空白・区切りを含む）が入っています');
    expect(venueProblem(row('', '', ''))).toEqual({ field: '会場', reason: '「会場」が空欄です' });
    expect(venueProblem(row('', 'その他', '', ''))).toEqual({ field: '会場（その他の場合）', reason: '「会場」が「その他」ですが、会場名（「会場（その他の場合）」の列）が入っていません' });
    expect(venueProblem(row('', '#N/A', ''))).toEqual({ field: '会場', reason: '「会場」がエラーの値です（会場名として読み取れません）' });
    expect(venueProblem(row('', '', '', '#REF!'))).toEqual({ field: '会場（その他の場合）', reason: '「会場（その他の場合）」がエラーの値です（会場名として読み取れません）' });
    expect(countProblem('62 58')).toContain('数字以外の文字（空白・区切りを含む）');
    expect(countProblem(46315)).toContain('1 件の回答で 9,999 個まで');
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
  it('相手の案件が決めている日（保留の日の説明に使う）: 重なる日のうち、相手が「自分の実績にする」と決めた日だけ。中止の相手・重ならない日・別の会場の決定は数えない', () => {
    const ctx = (projects: Project[]) => ({ projects, venues });
    expect(rivalClaimedDates(P, ctx([P, Q]))).toEqual(new Set());
    // 相手の 11/15 は重なる日。11/19 は相手の会期内だが、この案件の会期の外
    expect(rivalClaimedDates(P, ctx([P, { ...Q, reportClaims: ['2026-11-15', '2026-11-19'] }]))).toEqual(new Set(['2026-11-15']));
    // この案件だけが決めている日は、入らない（＝この案件の決定は、次の同期で反映される）
    const mine = { ...P, reportClaims: ['2026-11-15'] };
    expect(rivalClaimedDates(mine, ctx([mine, Q]))).toEqual(new Set());
    expect(rivalClaimedDates(mine, ctx([mine, { ...Q, reportClaims: ['2026-11-15'] }]))).toEqual(new Set(['2026-11-15']));
    // 中止の相手の決定・別の会場の案件の決定は数えない
    expect(rivalClaimedDates(P, ctx([P, { ...Q, status: '中止', reportClaims: ['2026-11-15'] }]))).toEqual(new Set());
    expect(rivalClaimedDates(P, ctx([P, { ...Q, venueId: 'v-east', reportClaims: ['2026-11-15'] }]))).toEqual(new Set());
    // 会場・会期が決まっていない案件では、空
    expect(rivalClaimedDates({ ...P, venueId: '' }, ctx([P, { ...Q, reportClaims: ['2026-11-15'] }]))).toEqual(new Set());
    expect(rivalClaimedDates({ ...P, startDate: '' }, ctx([P, { ...Q, reportClaims: ['2026-11-15'] }]))).toEqual(new Set());
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
