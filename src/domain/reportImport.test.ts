// 日報から案件の候補を作る処理（reportImport.ts）のテスト。
// 回答のデータは、実際の日報と同じ形（「その他」の会場・テスト回答・空欄の組数・順不同の回答・同じ会場の別の開催）に似せた、架空のもの。
import { describe, expect, it } from 'vitest';
import { Project, Venue } from '../types';
import { isJcos, jcosEstimate, withJcosDay } from './jcos';
import { emptyLayout } from './layout';
import { RawReportRow, hydrateReportSync, openOutside, planProjectSync, planReportSync, usableReportDays } from './report';
import {
  ImportInput, ImportPlan, dateRanges, groupRuns, importCreates, importName, importNames, looseVenueKey, matchVenue, planReportImport, reportRuns, withSameVenue,
} from './reportImport';
import { mkProject } from './testkit';

// ── テスト用の部品 ───────────────────────────────────────────
const CENTER = '北街モール（中央広場）';
const EAST = '北街モール（東口前）';
const MINATO = 'みなと市場';
const OUTLET = '北街アウトレット前';
const HIKARI = 'ひかり広場（イベントコート）';
const CONTENT = '花の小びんづくり（無料）';
const SOURCE = { spreadsheetId: 'sheet-id-0123456789abcdefghij', gid: 1 };
const NOW = '2026-11-14T09:00:00.000Z';

const mkVenue = (id: string, name: string, reportNames?: string[]): Venue =>
  ({ id, name, feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout(), ...(reportNames ? { reportNames } : {}) });
/** 回答 1 件（会場が「その他」のときは other に会場名） */
const row = (date: unknown, venue: string, count: unknown, opt: { other?: string; event?: string; groups?: unknown; people?: unknown; content?: unknown } = {}): RawReportRow =>
  ({ date, venue, venueOther: opt.other ?? '', event: opt.event ?? '', count, content: opt.content ?? CONTENT, groups: opt.groups ?? '', people: opt.people ?? '' });

/** 実際の日報に似せた回答（上から順） */
const ROWS: RawReportRow[] = [
  row('2026/07/31', 'その他', 13, { other: 'テスト会場', event: '【テスト】通しテスト', groups: 12 }),   // テスト回答
  row('2026/08/01', EAST, 98, { groups: 51, people: 126 }),
  row('2026/08/02', EAST, 88),                                                                   // 組数・人数が空欄
  row('2026/08/03', EAST, 49, { groups: 26, people: 61 }),
  row('2026/08/17', CENTER, 80, { event: '夏の花あそび', groups: 45, people: 105 }),
  row('2026/08/18', CENTER, 78, { event: '夏の花あそび', groups: 43, people: 94 }),
  row('2026/09/11', 'その他', 39, { other: MINATO, groups: 29, people: 48 }),
  row('2026/09/12', 'その他', 48, { other: MINATO, groups: 27, people: 55 }),
  row('2026/09/14', CENTER, 29, { event: '敬老の日', groups: 22, people: 36 }),                    // 同じ会場の、別の開催
  row('2026/09/15', CENTER, 20, { event: '敬老の日', groups: 15, people: 21 }),
  row('2026/10/24', 'その他', 52, { other: OUTLET, event: '秋の花まつり', groups: 25, people: 70 }),
  row('2026/10/23', 'その他', 7, { other: OUTLET, groups: 5, people: 8 }),                          // 回答の順が、開催日の順ではない
  row('2026/10/25', 'その他', 88, { other: OUTLET, groups: 49, people: 147 }),
  row('2026/11/13', HIKARI, 30, { event: '冬を待つ花あそび', groups: 17, people: 29 }),
  row('2026/11/14', HIKARI, 99, { event: '冬を待つ花あそび', groups: 52, people: 121 }),
];

let seq = 0;
const ids = () => { seq = 0; return () => `id-${++seq}`; };
function plan(over: Partial<ImportInput> = {}): ImportPlan {
  return planReportImport({ rows: ROWS, projects: [], venues: [], source: SOURCE, now: NOW, newId: ids(), ...over });
}
const kinds = (p: ImportPlan) => p.items.map((i) => `${i.kind}:${i.venueName}:${i.startDate}〜${i.endDate}`);
const creates = (p: ImportPlan) => p.items.flatMap((i) => (i.kind === 'create' ? [i] : []));
const updates = (p: ImportPlan) => p.items.flatMap((i) => (i.kind === 'update' ? [i] : []));
/** 作成のときに渡す、いまのデータ（plan() に渡したものと同じにする） */
const ctx = (over: { rows?: RawReportRow[]; projects?: Project[]; venues?: Venue[] } = {}) =>
  ({ rows: over.rows ?? ROWS, projects: over.projects ?? [], venues: over.venues ?? [], now: NOW });
const allIds = (p: ImportPlan) => new Set(p.items.map((i) => i.id));
/** 候補をすべて作ったあとのデータ */
function applyAll(p: ImportPlan, over: { rows?: RawReportRow[]; projects?: Project[]; venues?: Venue[] } = {}): { venues: Venue[]; projects: Project[] } {
  const r = importCreates(p, allIds(p), ctx(over));
  return { venues: r.venues, projects: [...(over.projects ?? []), ...r.projects] };
}

// ── 開催日のまとまり ──────────────────────────────────────────
describe('日報を、会場 × 連続した開催日のまとまりに分ける', () => {
  it('会場ごと・連続した日ごとに分かれる。テスト回答は入らない。回答の順は関係しない', () => {
    const r = reportRuns(ROWS);
    expect(r.runs.map((x) => [x.venueName, x.startDate, x.endDate, x.dates.length, x.rows])).toEqual([
      [EAST, '2026-08-01', '2026-08-03', 3, 3],
      [CENTER, '2026-08-17', '2026-08-18', 2, 2],
      [MINATO, '2026-09-11', '2026-09-12', 2, 2],
      [CENTER, '2026-09-14', '2026-09-15', 2, 2],
      [OUTLET, '2026-10-23', '2026-10-25', 3, 3],
      [HIKARI, '2026-11-13', '2026-11-14', 2, 2],
    ]);
    expect([r.rowsRead, r.tests, r.loose]).toEqual([15, 1, []]);
  });
  it('同じ会場で、別の期間に開催したものは、別のまとまりになる（1 つにまとめない）', () => {
    const center = reportRuns(ROWS).runs.filter((x) => x.venueName === CENTER);
    expect(center.map((x) => x.startDate)).toEqual(['2026-08-17', '2026-09-14']);
    expect(center[1].prev).toBeNull();                       // 27 日あいている … 「同じ案件にする」の候補にもならない
  });
  it('会場が「その他」のときは、「会場（その他の場合）」の会場名で分ける', () => {
    expect(reportRuns(ROWS).runs.filter((x) => [MINATO, OUTLET].includes(x.venueName)).length).toBe(2);
  });
  it('イベント名は、まとまりを分けるのに使わない（空欄でも、途中で違っていても、同じまとまり）', () => {
    const rows = [row('2026/11/13', CENTER, 10, { event: 'A' }), row('2026/11/14', CENTER, 10), row('2026/11/15', CENTER, 10, { event: 'B' }), row('2026/11/16', CENTER, 10, { event: 'B' })];
    const r = reportRuns(rows).runs;
    expect(r.length).toBe(1);
    expect([r[0].startDate, r[0].endDate, r[0].eventName]).toEqual(['2026-11-13', '2026-11-16', 'B']);   // 案件名の初期値には、いちばん多い名前
  });
  it('同じイベント名でも、会場が違えば、別のまとまり', () => {
    const rows = [row('2026/10/20', CENTER, 10, { event: '秋の花まつり' }), row('2026/10/20', EAST, 10, { event: '秋の花まつり' })];
    expect(reportRuns(rows).runs.map((x) => x.venueName).sort()).toEqual([CENTER, EAST].sort());
  });
  it('会場名は、全角/半角・空白・英字の大小だけをそろえて同じとみなす。表示は、いちばん多い書き方', () => {
    const rows = [row('2026/11/13', 'Kita Mall（中央）', 1), row('2026/11/14', 'kita mall(中央)', 1), row('2026/11/15', 'kita mall(中央)', 1)];
    const r = reportRuns(rows).runs;
    expect(r.length).toBe(1);
    expect(r[0].venueName).toBe('kita mall(中央)');
  });
  it('同じ会場・同じ日の回答が複数あっても、1 日として数える（回答の数は別に持つ）', () => {
    const r = reportRuns([row('2026/11/13', CENTER, 10), row('2026/11/13', CENTER, 5), row('2026/11/14', CENTER, 7)]).runs;
    expect([r[0].dates, r[0].rows]).toEqual([['2026-11-13', '2026-11-14'], 3]);
  });
  it('開催日か会場名を読み取れない回答は、どのまとまりにも入れず、行番号つきで返す（中身の文字は持たない）', () => {
    const r = reportRuns([row('2026/11/13', CENTER, 10), row('きのう', CENTER, 5), row('2026/11/14', 'その他', 7), row('', '', 3)]);
    expect(r.runs.length).toBe(1);
    expect(r.loose.map((x) => [x.row, x.date, x.items.map((i) => i.field)])).toEqual([
      [3, null, ['開催日']],
      [4, '2026-11-14', ['会場（その他の場合）']],
      [5, null, ['開催日', '会場']],
    ]);
    expect(JSON.stringify(r.loose)).not.toContain('きのう');
  });
});

describe('連続していない開催日', () => {
  const gapRows = [row('2026/11/13', CENTER, 10), row('2026/11/14', CENTER, 12), row('2026/11/16', CENTER, 9), row('2026/11/17', CENTER, 8)];
  it('1 日でもあいていれば、別のまとまりにする。数日以内なら、「同じ案件にする」の候補になる', () => {
    const r = reportRuns(gapRows).runs;
    expect(r.map((x) => [x.startDate, x.endDate])).toEqual([['2026-11-13', '2026-11-14'], ['2026-11-16', '2026-11-17']]);
    expect(r[1].prev).toEqual({ id: r[0].id, gap: 1 });
  });
  it('あいている日が 3 日までは候補にする。4 日以上は、候補にしない', () => {
    const at = (d: string) => reportRuns([row('2026/11/13', CENTER, 1), row(d, CENTER, 1)]).runs[1].prev?.gap ?? null;
    expect([at('2026/11/15'), at('2026/11/17'), at('2026/11/18')]).toEqual([1, 3, null]);
  });
  it('選ばなければ、別々の案件の候補のまま。選ぶと、1 つの案件になり、間の日は「回答の無い日」として分かる', () => {
    const { runs } = reportRuns(gapRows);
    expect(groupRuns(runs, new Set()).map((g) => [g.startDate, g.endDate, g.gaps])).toEqual([
      ['2026-11-13', '2026-11-14', []],
      ['2026-11-16', '2026-11-17', []],
    ]);
    const joined = groupRuns(runs, new Set([runs[1].id]));
    expect(joined.length).toBe(1);
    expect([joined[0].startDate, joined[0].endDate, joined[0].dates, joined[0].gaps, joined[0].runs.length]).toEqual([
      '2026-11-13', '2026-11-17', ['2026-11-13', '2026-11-14', '2026-11-16', '2026-11-17'], ['2026-11-15'], 2,
    ]);
  });
  it('まとめた案件は、間の日を開催した日として扱わない（請求しない。実績は回答のある日だけ）。アルバイト代は、どの日にも自動では付かない', () => {
    const { runs } = reportRuns(gapRows);
    const p = creates(plan({ rows: gapRows, joins: new Set([runs[1].id]) }))[0].project!;
    expect([p.startDate, p.endDate]).toEqual(['2026-11-13', '2026-11-17']);
    expect(p.jcos!.days).toEqual({ '2026-11-15': { billed: false, partTimers: 0, notHeld: true } });
    expect(p.reportSync!.days.map((d) => d.date)).toEqual(['2026-11-13', '2026-11-14', '2026-11-16', '2026-11-17']);
    const j = jcosEstimate(p);
    expect([j.periodDays, j.heldDays, j.billDays, j.partTimerDays, j.actualDays, j.actualCount, j.basis]).toEqual([5, 4, 4, 0, 4, 39, 'actual']);
    expect(j.days.find((d) => d.date === '2026-11-15')).toMatchObject({ billed: false, billing: 0, partTimerCost: 0, count: 0, gross: 0 });
  });
  it('3 つのまとまりを、順にまとめられる（2 つ目だけ・2 つ目と 3 つ目）', () => {
    const rows = [row('2026/11/13', CENTER, 1), row('2026/11/15', CENTER, 1), row('2026/11/17', CENTER, 1)];
    const { runs } = reportRuns(rows);
    expect(groupRuns(runs, new Set([runs[1].id])).map((g) => [g.startDate, g.endDate])).toEqual([['2026-11-13', '2026-11-15'], ['2026-11-17', '2026-11-17']]);
    expect(groupRuns(runs, new Set([runs[1].id, runs[2].id])).map((g) => [g.startDate, g.endDate, g.gaps])).toEqual([['2026-11-13', '2026-11-17', ['2026-11-14', '2026-11-16']]]);
    // 3 つ目だけを選ぶと、2 つ目と 3 つ目が 1 つになる（1 つ目とは別）
    expect(groupRuns(runs, new Set([runs[2].id])).map((g) => [g.startDate, g.endDate])).toEqual([['2026-11-13', '2026-11-13'], ['2026-11-15', '2026-11-17']]);
  });
});

// ── 会場マスタ ────────────────────────────────────────────────
describe('会場マスタとの照合', () => {
  const venues = [mkVenue('v1', CENTER), mkVenue('v2', 'みなと 市場', ['港の市場'])];
  const key = (s: string) => reportRuns([row('2026/11/13', s, 1)]).runs[0].key;
  it('全角/半角・空白・英字の大小だけが違う会場名は、登録済みの会場を使う', () => {
    expect(matchVenue(key('北街モール(中央広場)'), venues)).toMatchObject({ state: 'known', venue: { id: 'v1' } });
    expect(matchVenue(key('みなと市場'), venues)).toMatchObject({ state: 'known', venue: { id: 'v2' } });
  });
  it('別名で登録してある会場名も、登録済みの会場を使う', () => {
    expect(matchVenue(key('港の市場'), venues)).toMatchObject({ state: 'known', venue: { id: 'v2' } });
  });
  it('名前の前半が同じだけの会場（同じ施設の、別の場所）は、別の会場として新しく登録する（まとめない・確認も求めない）', () => {
    expect(matchVenue(key(EAST), venues)).toEqual({ state: 'new' });
    expect(matchVenue(key('北街モール'), venues)).toEqual({ state: 'new' });
  });
  it('記号・括弧だけが違う会場が登録済みのときは、勝手にまとめずに、確認を求める', () => {
    for (const s of ['北街モール 中央広場', '北街モール・中央広場', '北街モール【中央広場】', '北街モール-中央広場']) {
      expect(matchVenue(key(s), venues), s).toMatchObject({ state: 'similar', candidates: [{ id: 'v1' }] });
    }
    expect(looseVenueKey('北街モール（中央広場）')).toBe(looseVenueKey('北街モール 中央広場'));
  });
  it('長音・濁点・文字そのものが違う会場名は、記号だけの違いとはみなさない', () => {
    expect(matchVenue(key('北街モール（中央ひろば）'), venues)).toEqual({ state: 'new' });
    expect(matchVenue(key('北街モウル（中央広場）'), venues)).toEqual({ state: 'new' });
  });
  it('同じ名前の会場が 2 件登録されていたら、先のものを使い、ほかにもあることを知らせる', () => {
    expect(matchVenue(key(CENTER), [...venues, mkVenue('v9', CENTER)])).toMatchObject({ state: 'known', venue: { id: 'v1' }, others: 1 });
  });
});

// ── 新しい案件の候補 ──────────────────────────────────────────
describe('日報から、新しい案件を作る', () => {
  it('案件も会場も無い状態では、開催ごとに 1 件ずつ、新しい案件の候補になる', () => {
    const p = plan();
    expect(kinds(p)).toEqual([
      `create:${EAST}:2026-08-01〜2026-08-03`,
      `create:${CENTER}:2026-08-17〜2026-08-18`,
      `create:${MINATO}:2026-09-11〜2026-09-12`,
      `create:${CENTER}:2026-09-14〜2026-09-15`,
      `create:${OUTLET}:2026-10-23〜2026-10-25`,
      `create:${HIKARI}:2026-11-13〜2026-11-14`,
    ]);
    expect([p.rowsRead, p.tests, p.span]).toEqual([15, 1, { startDate: '2026-08-01', endDate: '2026-11-14' }]);
    expect(creates(p).every((c) => c.blocked === null && c.project)).toBe(true);
  });
  it('作る案件: 会場・開催日・実績が入り、JCOS 案件・実施済になる。日報の場所と、日報から決めた会期の控えを持つ', () => {
    const c = creates(plan())[0];
    const p = c.project!;
    expect([p.name, p.startDate, p.endDate, p.status, isJcos(p)]).toEqual([`${EAST}（8/1〜8/3）`, '2026-08-01', '2026-08-03', '実施済', true]);
    expect(p.venueId).toBe(c.venuePlan!.use.id);
    expect(p.reportSource).toEqual(SOURCE);
    expect(p.reportPeriod).toEqual({ startDate: '2026-08-01', endDate: '2026-08-03' });
    expect(p.reportSync!.days).toEqual([
      { date: '2026-08-01', count: 98, rows: 1, keys: [c.key], groups: 51, people: 126, contents: [{ label: CONTENT, count: 98 }] },
      { date: '2026-08-02', count: 88, rows: 1, keys: [c.key], contents: [{ label: CONTENT, count: 88 }] },   // 組数・人数は未入力（0 とはみなさない）
      { date: '2026-08-03', count: 49, rows: 1, keys: [c.key], groups: 26, people: 61, contents: [{ label: CONTENT, count: 49 }] },
    ]);
    expect(c.totals).toEqual({ days: 3, count: 235, groups: 77, groupsMissing: 1, people: 187, peopleMissing: 1 });
    expect(p.reportSync!.contents).toEqual([{ label: CONTENT, rows: 3, count: 235 }]);
  });
  it('日報に無い項目は、推測で埋めない（予定個数・スタッフ配置・その他実費・追加の請求は空。メモも空）', () => {
    const p = creates(plan())[0].project!;
    expect([p.contents, p.assignments, p.otherCosts, p.jcos!.extraBillings, p.memo, p.actualsManual, p.reportClaims]).toEqual([[], [], [], [], '', undefined, undefined]);
  });
  it('案件名の初期値は、日報のイベント名。無ければ「会場名（開催日）」。1 日だけなら、その日', () => {
    const p = plan();
    expect(creates(p).map((c) => c.name)).toEqual([`${EAST}（8/1〜8/3）`, '夏の花あそび', `${MINATO}（9/11〜9/12）`, '敬老の日', '秋の花まつり', '冬を待つ花あそび']);
    expect(importName({ eventName: '', venueName: CENTER, startDate: '2026-11-13', endDate: '2026-11-13' })).toBe(`${CENTER}（11/13）`);
  });
  it('イベント名が空欄の開催も、案件になる', () => {
    const rows = [row('2026/11/13', CENTER, 10), row('2026/11/14', CENTER, 12)];
    const c = creates(plan({ rows }));
    expect([c.length, c[0].project!.reportSync!.days.length, c[0].name]).toEqual([1, 2, `${CENTER}（11/13〜11/14）`]);
  });
  it('収支: 実績個数が、材料原価と粗利に入る（請求 4 万円/日 − 220 円 × 個数）。アルバイト代は、自動では計上しない（配置した日・人数を入れたときだけ）', () => {
    const p = creates(plan())[0].project!;                       // 3 日・235 個
    const t = jcosEstimate(p).current;
    expect([t.billing, t.partTimerCost, t.materialCost, t.cost, t.gross]).toEqual([120000, 0, 51700, 51700, 68300]);
    expect(jcosEstimate(p).basis).toBe('actual');
    expect(p.jcos!.days).toEqual({});                            // 日ごとの設定は、空（アルバイトの人数を、推測で入れない）
    // 2 日に 1 人ずつ配置すると、その分だけ計上される（請求は変わらない）
    const placed = { ...p, jcos: withJcosDay(withJcosDay(p.jcos!, '2026-08-01', { partTimers: 1 }), '2026-08-03', { partTimers: 1 }) };
    const u = jcosEstimate(placed).current;
    expect([u.billing, u.partTimerCost, u.gross]).toEqual([120000, 30000, 38300]);
    // 内容ごとの内訳（日報の「イベント内容」）: 指定が無いので、案件の標準（220 円）
    expect(jcosEstimate(p).materials.map((m) => [m.label, m.count, m.unitCost, m.custom])).toEqual([[CONTENT, 235, 220, false]]);
  });
});

describe('会場マスタへの自動登録', () => {
  it('日報にあって、会場マスタに無い会場は、新しく登録する。同じ会場の開催が複数あっても、登録は 1 件', () => {
    const p = plan();
    const r = importCreates(p, allIds(p), ctx());
    expect(r.addedVenues.map((v) => v.name).sort()).toEqual([CENTER, EAST, MINATO, OUTLET, HIKARI].sort());
    const center = r.projects.filter((x) => r.venues.find((v) => v.id === x.venueId)?.name === CENTER);
    expect(center.length).toBe(2);
    expect(new Set(center.map((x) => x.venueId)).size).toBe(1);
  });
  it('登録する会場名は、日報の表記そのまま。同じ表記を別名にも持たせる（あとで会場名を変えても、照合が切れない）', () => {
    const p = plan();
    const v = importCreates(p, allIds(p), ctx()).addedVenues.find((x) => x.name === OUTLET)!;
    expect(v.reportNames).toEqual([OUTLET]);
    // 会場名を変えたあとも、同じ日報で、同じ案件に実績が入る
    const { venues, projects } = applyAll(p);
    const renamed = venues.map((x) => (x.id === v.id ? { ...x, name: 'アウトレット（短い名前）' } : x));
    const mine = projects.find((x) => x.venueId === v.id)!;
    expect([...usableReportDays(mine, { projects, venues: renamed }).keys()]).toEqual(['2026-10-23', '2026-10-24', '2026-10-25']);
    expect(updates(plan({ projects, venues: renamed })).length).toBe(6);
  });
  it('登録済みの会場は、そのまま使う（重複して登録しない）。会場費の既定値・雛形も、その会場のものが入る', () => {
    const venues = [{ ...mkVenue('v-center', CENTER), feePerDay: 5000 }, mkVenue('v-minato', 'みなと市場')];
    const p = plan({ venues });
    const r = importCreates(p, allIds(p), ctx({ venues }));
    expect(r.addedVenues.map((v) => v.name).sort()).toEqual([EAST, OUTLET, HIKARI].sort());
    expect(r.venues.filter((v) => v.name === CENTER).length).toBe(1);
    const c = creates(p).find((x) => x.venueName === CENTER)!;
    expect([c.venue.state, c.project!.venueId, c.project!.venueFeePerDay]).toEqual(['known', 'v-center', 5000]);
  });
  it('選んだ候補の会場だけを登録する（選ばなかった候補の会場は、登録しない）', () => {
    const p = plan();
    const one = creates(p).find((x) => x.venueName === HIKARI)!;
    const r = importCreates(p, new Set([one.id]), ctx());
    expect([r.addedVenues.map((v) => v.name), r.projects.length]).toEqual([[HIKARI], 1]);
  });
  it('記号だけが違う会場が登録済みのとき: 決めるまでは作れない。「別の会場」なら新しく登録する', () => {
    const venues = [mkVenue('v-center', '北街モール 中央広場')];
    const rows = [row('2026/11/13', CENTER, 10), row('2026/11/14', CENTER, 12)];
    const c0 = creates(plan({ rows, venues }))[0];
    expect([c0.venue, c0.blocked, c0.project]).toEqual([{ state: 'similar', candidates: [venues[0]], pending: [], choiceNew: 'new:v-center' }, { reason: 'venue' }, null]);
    expect(importCreates(plan({ rows, venues }), new Set([c0.id]), ctx({ rows, venues })).projects).toEqual([]);
    // 選択は、比べた相手つきで覚える。別の相手と比べたときの選択は、使わない（もう一度確かめる）
    expect(creates(plan({ rows, venues, venueChoice: { [c0.key]: 'new:another-venue' } }))[0].blocked).toEqual({ reason: 'venue' });

    const asNew = plan({ rows, venues, venueChoice: { [c0.key]: 'new:v-center' } });
    const r1 = importCreates(asNew, new Set([c0.id]), ctx({ rows, venues }));
    expect([r1.addedVenues.map((v) => v.name), r1.projects.length, r1.venues.length]).toEqual([[CENTER], 1, 2]);
  });
  it('「同じ会場」と決めたら、会場マスタに別名を足す。以後は、登録済みの会場として、そのまま候補になる（会場は増えない）', () => {
    const venues = [mkVenue('v-center', '北街モール 中央広場')];
    const rows = [row('2026/11/13', CENTER, 10), row('2026/11/14', CENTER, 12)];
    const same = withSameVenue(venues, { venueId: 'v-center' }, CENTER);
    expect(same).toEqual([{ ...venues[0], reportNames: [CENTER] }]);
    expect(withSameVenue(same, { venueId: 'v-center' }, '北街モール(中央広場)')).toBe(same);          // すでに同じ会場 … 変えない
    const c = creates(plan({ rows, venues: same }))[0];
    expect([c.venue.state, c.blocked, c.venuePlan?.isNew, c.project!.venueId, c.venueName]).toEqual(['known', null, false, 'v-center', '北街モール 中央広場']);
    const r = importCreates(plan({ rows, venues: same }), new Set([c.id]), ctx({ rows, venues: same }));
    expect([r.addedVenues, r.venues, r.projects[0].reportSync!.days.map((d) => d.count)]).toEqual([[], same, [10, 12]]);
  });
  it('「同じ会場」と決めた会場に、その日を会期に含む案件があれば、新しい案件にはせず、その案件の更新になる', () => {
    const venues = [mkVenue('v-center', '北街モール 中央広場')];
    const rows = [row('2026/11/13', CENTER, 10), row('2026/11/14', CENTER, 12)];
    const existing = mkProject({ id: 'p-center', name: '中央広場の開催', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-14', contents: [], assignments: [] });
    // 決める前: 日報の書き方は登録されていないので、新しい候補（会場の確認待ち）
    expect(kinds(plan({ rows, venues, projects: [existing] }))).toEqual([`create:${CENTER}:2026-11-13〜2026-11-14`]);
    const after = plan({ rows, venues: withSameVenue(venues, { venueId: 'v-center' }, CENTER), projects: [existing] });
    expect(kinds(after)).toEqual(['update:北街モール 中央広場:2026-11-13〜2026-11-14']);
    expect(updates(after)[0].preview).toMatchObject({ ok: true, totals: { days: 2, count: 22 } });
  });
  it('登録済みの会場は、会場名でも別名でも、同じ会場の開催としてまとめる（日によって書き方が違っても、候補を分けない）', () => {
    const venues = [mkVenue('v-center', CENTER, ['北街モール 中央広場'])];
    const rows = [row('2026/11/13', CENTER, 10), row('2026/11/14', 'その他', 12, { other: '北街モール 中央広場' }), row('2026/11/15', CENTER, 9)];
    const r = reportRuns(rows, venues).runs;
    expect(r.map((x) => [x.venueId, x.startDate, x.endDate, x.keys.length, x.rows])).toEqual([['v-center', '2026-11-13', '2026-11-15', 2, 3]]);
    const c = creates(plan({ rows, venues }));
    expect(c.map((x) => [x.venueName, x.startDate, x.endDate, x.totals?.count, x.venue.state])).toEqual([[CENTER, '2026-11-13', '2026-11-15', 31, 'known']]);
    // 会場マスタを渡さなければ（登録が無ければ）、書き方ごとに分かれる
    expect(reportRuns(rows).runs.length).toBe(3);
  });
  it('同じ日報の中に、記号だけが違う会場名が 2 つあって、どちらも未登録のとき: 回答の多い書き方はそのまま候補にし、少ない書き方は確認を求める（勝手にまとめず、勝手に 2 つ登録しない）', () => {
    const alt = 'ひかり広場 イベントコート';
    const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/14', HIKARI, 99), row('2026/11/20', 'その他', 12, { other: alt })];
    const p = plan({ rows });
    const [main, other] = creates(p);
    expect([main.venueName, main.blocked, main.venue]).toEqual([HIKARI, null, { state: 'new' }]);
    expect([other.venueName, other.blocked, other.venue]).toEqual([alt, { reason: 'venue' }, { state: 'similar', candidates: [], pending: [{ key: main.key, name: HIKARI }], choiceNew: `new:${main.key}` }]);
    expect(importCreates(p, allIds(p), ctx({ rows })).addedVenues.map((v) => v.name)).toEqual([HIKARI]);
    // 「別の会場」… それぞれ登録する
    const asNew = plan({ rows, venueChoice: { [other.key]: (other.venue as { choiceNew: string }).choiceNew } });
    expect(importCreates(asNew, allIds(asNew), ctx({ rows })).addedVenues.map((v) => v.name)).toEqual([HIKARI, alt]);
    // 「同じ会場」… 回答の多い書き方で登録して、少ない書き方は別名にする。以後は、どちらの書き方も、同じ会場
    const venues = withSameVenue([], { name: HIKARI }, alt, () => 'v-new');
    expect(venues.map((v) => [v.id, v.name, v.reportNames])).toEqual([['v-new', HIKARI, [HIKARI, alt]]]);
    const same = plan({ rows, venues });
    expect(creates(same).map((c) => [c.venueName, c.venue.state, c.blocked, c.project!.venueId])).toEqual([[HIKARI, 'known', null, 'v-new'], [HIKARI, 'known', null, 'v-new']]);
    expect(importCreates(same, allIds(same), ctx({ rows, venues })).addedVenues).toEqual([]);
    // 先に、回答の多い書き方の案件だけを作った場合も、残りの書き方は、登録済みの会場との確認になる
    const first = importCreates(p, new Set([main.id]), ctx({ rows }));
    const rest = creates(plan({ rows, venues: first.venues, projects: first.projects }));
    expect(rest.map((c) => [c.venueName, c.venue.state, c.venue.state === 'similar' && c.venue.candidates.map((v) => v.name)])).toEqual([[alt, 'similar', [HIKARI]]]);
  });
  it('同じ日・同じ回答数なら、先に開催した書き方を基準にする（何度読んでも、同じ結果）', () => {
    const rows = [row('2026/11/20', '北街モール・中央広場', 1), row('2026/11/13', CENTER, 1)];
    const p = creates(plan({ rows }));
    expect(p.map((c) => [c.venueName, c.blocked?.reason ?? null])).toEqual([[CENTER, null], ['北街モール・中央広場', 'venue']]);
  });
});

// ── 既存の案件との対応づけ ─────────────────────────────────────
describe('既存の案件があるとき', () => {
  const venues = [mkVenue('v-hikari', HIKARI), mkVenue('v-center', CENTER)];
  const planned = mkProject({ id: 'p-plan', name: '冬の開催（予定）', venueId: 'v-hikari', startDate: '2026-11-13', endDate: '2026-11-17', contents: [], assignments: [] });
  it('会場名が合い、会期に開催日を含む案件があれば、新しく作らずに、その案件の更新にする', () => {
    const p = plan({ projects: [planned], venues });
    expect(kinds(p).filter((k) => k.includes(HIKARI))).toEqual([`update:${HIKARI}:2026-11-13〜2026-11-14`]);
    const u = updates(p)[0];
    expect([u.projectId, u.outside, u.widenTo]).toEqual(['p-plan', [], null]);
    expect(u.preview).toMatchObject({ ok: true, changed: true, period: null, totals: { days: 2, count: 129, groups: 69, people: 150 } });
  });
  it('対応づけに、イベント名は使わない（案件名が日報のイベント名と違っていても、空欄でも、同じ案件）', () => {
    for (const name of ['まったく別の名前', '']) {
      expect(updates(plan({ projects: [{ ...planned, name }], venues })).map((u) => u.projectId)).toEqual(['p-plan']);
    }
  });
  it('同じ会場でも、会期が重ならない案件には入れない（別の開催として、新しい候補になる）', () => {
    const other = mkProject({ id: 'p-aug', name: '8 月の開催', venueId: 'v-center', startDate: '2026-08-17', endDate: '2026-08-18', contents: [], assignments: [] });
    const p = plan({ projects: [other], venues });
    expect(kinds(p).filter((k) => k.includes(CENTER))).toEqual([`create:${CENTER}:2026-09-14〜2026-09-15`, `update:${CENTER}:2026-08-17〜2026-08-18`]);
  });
  it('同じ会場・重なる会期の案件が 2 件あるときは、どちらにも入れずに、確認を求める（新しい案件も作らない）', () => {
    const twin = { ...planned, id: 'p-twin', name: '重なる案件' };
    const p = plan({ projects: [planned, twin], venues });
    const item = p.items.find((i) => i.venueName === HIKARI)!;
    expect(item).toMatchObject({ kind: 'ambiguous', projects: [{ id: 'p-plan', name: '冬の開催（予定）' }, { id: 'p-twin', name: '重なる案件' }] });
    expect(importCreates(p, allIds(p), ctx({ projects: [planned, twin], venues })).projects.some((x) => x.venueId === 'v-hikari')).toBe(false);
  });
  it('中止の案件は、対応づけの相手にしない（新しい候補になり、重なっている中止の案件名を示す）', () => {
    const p = plan({ projects: [{ ...planned, status: '中止' }], venues });
    const c = creates(p).find((x) => x.venueName === HIKARI)!;
    expect([c.kind, c.cancelled, c.blocked]).toEqual(['create', ['冬の開催（予定）'], null]);
  });
});

describe('何度取り込んでも、二重にならない', () => {
  it('候補をすべて作ったあとで、同じ日報をもう一度読むと、新しい候補は 0 件。どの案件も「変更なし」', () => {
    const { venues, projects } = applyAll(plan());
    const again = plan({ projects, venues });
    expect(creates(again)).toEqual([]);
    expect(updates(again).map((u) => (u.preview.ok ? u.preview.changed : null))).toEqual([false, false, false, false, false, false]);
    expect(importCreates(again, allIds(again), ctx({ projects, venues }))).toMatchObject({ projects: [], addedVenues: [] });
    expect(venues.length).toBe(5);
  });
  it('日報の個数が修正されたら、その案件だけ「変更あり」になり、同期すると、修正後の個数で置き換わる（足し込まない）', () => {
    const { venues, projects } = applyAll(plan());
    const fixed = ROWS.map((r) => (r.date === '2026/11/14' ? { ...r, count: 90 } : r));
    const again = plan({ rows: fixed, projects, venues });
    const changed = updates(again).filter((u) => u.preview.ok && u.preview.changed);
    expect(changed.map((u) => u.venueName)).toEqual([HIKARI]);
    expect(changed[0].preview).toMatchObject({ ok: true, totals: { count: 120 } });
    const p = projects.find((x) => x.id === changed[0].projectId)!;
    const r = planReportSync({ project: p, projects, venues, rows: fixed, now: NOW });
    expect(r.ok && r.sync.days.map((d) => d.count)).toEqual([30, 90]);
  });
  it('日報の回答が削除されたら、「変更あり」になる', () => {
    const { venues, projects } = applyAll(plan());
    const again = plan({ rows: ROWS.filter((r) => r.date !== '2026/08/02'), projects, venues });
    // 8/2 の回答が無くなると、8/1 と 8/3 は連続しない。案件（8/1〜8/3）の会期には両方とも入っているので、同じ案件の更新のまま（1 件にまとめる）
    const east = updates(again).filter((u) => u.venueName === EAST);
    expect(east.map((u) => [u.dates, u.gaps, u.runs.length, u.joinPrev, u.preview.ok && u.preview.changed])).toEqual([[['2026-08-01', '2026-08-03'], ['2026-08-02'], 2, null, true]]);
    expect(creates(again)).toEqual([]);
  });
});

describe('以前の版（Version 5）で同期した案件（日別の、内容ごとの個数を持たない実績）', () => {
  it('同じ日報でも、1 回だけ「変更あり」になり（内容ごとの個数が入る）、同期したあとは「変更なし」に戻る。個数・金額は変わらない', () => {
    const { venues, projects } = applyAll(plan());
    // Version 5 の同期の結果の形にする（日別の内訳を外す）
    const old: Project[] = projects.map((p) => ({ ...p, reportSync: { ...p.reportSync!, days: p.reportSync!.days.map(({ contents: _c, ...d }) => d) } }));
    expect(old.every((p) => p.reportSync!.days.every((d) => !('contents' in d)))).toBe(true);
    const first = plan({ projects: old, venues });
    expect(creates(first)).toEqual([]);
    expect(updates(first).map((u) => [u.gone, u.preview.ok && u.preview.changed])).toEqual(Array(6).fill([undefined, true]));
    // 金額は、同期の前後で同じ（内容の指定が無いので、どちらも 個数 × 標準）
    const before = old.map((p) => jcosEstimate(p).current);
    const synced: Project[] = old.map((p) => { const r = planProjectSync({ project: p, projects: first.projected, venues, rows: ROWS, now: NOW }); return r.plan.ok ? { ...p, reportSync: r.plan.sync } : p; });
    expect(synced.map((p) => jcosEstimate(p).current)).toEqual(before);
    expect(synced.every((p) => p.reportSync!.days.every((d) => (d.contents ?? []).reduce((n, c) => n + c.count, 0) === d.count))).toBe(true);
    const second = plan({ projects: synced, venues });
    expect(updates(second).map((u) => u.preview.ok && u.preview.changed)).toEqual(Array(6).fill(false));
  });
});

describe('前にこの日報で同期した案件の回答が、日報から 1 件も無くなったとき', () => {
  const made = () => {
    const { venues, projects } = applyAll(plan());
    return { venues, projects, hikari: projects.find((p) => p.startDate === '2026-11-13')! };
  };
  const without = ROWS.filter((r) => r.venue !== HIKARI);
  it('その案件を、既存の案件の更新として出す（前の実績を、黙って残さない）。自動では外さない印（gone）と、外れる実績の日数・個数を付ける', () => {
    const { venues, projects, hikari } = made();
    expect(hikari.reportSync?.days.map((d) => d.count)).toEqual([30, 99]);
    const again = plan({ rows: without, projects, venues });
    const u = updates(again).find((x) => x.projectId === hikari.id)!;
    expect(u).toBeDefined();
    expect(u.preview).toMatchObject({ ok: true, changed: true, period: null, totals: { days: 0, count: 0 } });
    expect([u.gone, u.dates, u.rows, u.runs, u.outside, u.widenTo, u.startDate, u.endDate]).toEqual([{ days: 2, count: 129 }, [], 0, [], [], null, '2026-11-13', '2026-11-14']);
    // ほかの案件は、これまでどおり（変更なし）。新しい候補は出ない
    expect(updates(again).filter((x) => x.projectId !== hikari.id).map((x) => [x.gone, x.preview.ok && x.preview.changed])).toEqual(Array(5).fill([undefined, false]));
    expect(creates(again)).toEqual([]);
    // 同期すると、実績が空になり、次からは「変更なし」（印も付かない）
    const r = planProjectSync({ project: hikari, projects: again.projected, venues, rows: without, now: NOW });
    expect(r.plan.ok && r.plan.sync.days).toEqual([]);
    const after = projects.map((p) => (p.id === hikari.id && r.plan.ok ? { ...p, reportSync: r.plan.sync } : p));
    const third = updates(plan({ rows: without, projects: after, venues })).find((x) => x.projectId === hikari.id)!;
    expect([third.gone, third.preview.ok && third.preview.changed, third.dates]).toEqual([undefined, false, []]);
  });
  it('回答が 1 件も無い日報でも、同じ（どの案件も、更新として出る）', () => {
    const { venues, projects } = made();
    const again = plan({ rows: [], projects, venues });
    expect(updates(again).map((u) => [!!u.gone, u.preview.ok && u.preview.changed])).toEqual(Array(6).fill([true, true]));
    expect([creates(again), again.span]).toEqual([[], null]);
  });
  it('別の日報（スプレッドシート）で同期した案件・一度も同期していない案件・中止の案件は、相手にしない', () => {
    const { venues, projects, hikari } = made();
    const other = projects.map((p) => (p.id === hikari.id ? { ...p, reportSource: { spreadsheetId: 'another-sheet-id-0123456789abcd', gid: 1 } } : p));
    expect(updates(plan({ rows: without, projects: other, venues })).some((u) => u.projectId === hikari.id)).toBe(false);
    const never = projects.map((p) => { if (p.id !== hikari.id) return p; const { reportSync: _s, ...rest } = p; return rest as Project; });
    expect(updates(plan({ rows: without, projects: never, venues })).some((u) => u.projectId === hikari.id)).toBe(false);
    const cancelled = projects.map((p) => (p.id === hikari.id ? { ...p, status: '中止' as const } : p));
    expect(updates(plan({ rows: without, projects: cancelled, venues })).some((u) => u.projectId === hikari.id)).toBe(false);
  });
  it('回答が、同じ会場の、離れた日に直されたとき: 直された日は新しい候補になり、もとの案件は「実績になる回答が無い」として出る（勝手に付け替えない）', () => {
    const { venues, projects, hikari } = made();
    const moved = ROWS.map((r) => (r.venue === HIKARI ? { ...r, date: r.date === '2026/11/13' ? '2026/11/27' : '2026/11/28' } : r));
    const again = plan({ rows: moved, projects, venues });
    expect(creates(again).map((c) => [c.venueName, c.startDate, c.endDate, c.near.length])).toEqual([[HIKARI, '2026-11-27', '2026-11-28', 0]]);
    expect(updates(again).find((u) => u.projectId === hikari.id)).toMatchObject({ gone: { days: 2, count: 129 }, dates: [] });
  });
  it('会期が重なって決められない案件は、決められない開催として示すだけ（ここでは、更新にしない）', () => {
    const venues = [mkVenue('v-hikari', HIKARI)];
    const rows = ROWS.filter((r) => r.venue === HIKARI);
    const a = mkProject({ id: 'p-a', name: 'A', venueId: 'v-hikari', startDate: '2026-11-13', endDate: '2026-11-14', contents: [], assignments: [] });
    const first = planReportSync({ project: a, projects: [a], venues, rows, now: NOW });
    const synced = { ...a, reportSync: first.ok ? first.sync : undefined, reportSource: SOURCE };
    const b = mkProject({ id: 'p-b', name: 'B', venueId: 'v-hikari', startDate: '2026-11-13', endDate: '2026-11-14', contents: [], assignments: [] });
    const again = plan({ rows, projects: [synced, b], venues });
    expect(again.items.map((i) => i.kind)).toEqual(['ambiguous']);
  });
});

describe('開催中の案件（日報に、連続する日が増えていく）', () => {
  const first = ROWS.filter((r) => r.venue !== HIKARI || r.date === '2026/11/13');   // 11/13 の回答まで
  it('日報から作った案件は、次の日の回答が増えたら、会期が自動で伸びる（更新として扱い、新しい案件は作らない）', () => {
    const { venues, projects } = applyAll(plan({ rows: first }), { rows: first });
    const mine = projects.find((p) => p.startDate === '2026-11-13')!;
    expect([mine.endDate, mine.reportPeriod]).toEqual(['2026-11-13', { startDate: '2026-11-13', endDate: '2026-11-13' }]);
    const again = plan({ projects, venues });
    const u = updates(again).find((x) => x.projectId === mine.id)!;
    expect([u.outside, u.widenTo]).toEqual([[], null]);
    expect(u.preview).toMatchObject({ ok: true, changed: true, period: { startDate: '2026-11-13', endDate: '2026-11-14' }, totals: { days: 2, count: 129 } });
    expect(creates(again)).toEqual([]);
  });
  it('会期を手で決めた案件は、自動では伸ばさない。会期の外の日を示し、利用者が選んだときだけ、会期を広げて取り込む', () => {
    const venues = [mkVenue('v-hikari', HIKARI)];
    const manual = mkProject({ id: 'p-manual', name: '手で作った案件', venueId: 'v-hikari', startDate: '2026-11-13', endDate: '2026-11-13', contents: [], assignments: [] });
    const u = updates(plan({ projects: [manual], venues })).find((x) => x.projectId === 'p-manual')!;
    expect([u.outside, u.widenTo]).toEqual([['2026-11-14'], { startDate: '2026-11-13', endDate: '2026-11-14' }]);
    expect(u.preview).toMatchObject({ ok: true, period: null, totals: { days: 1, count: 30 } });      // 選ぶまでは、会期の中の日だけ
  });
  it('既存の案件の会期のすぐ近くにある開催は、新しい候補にしつつ、「その案件の会期を広げて取り込む」先を示す（どちらにするかは、利用者が選ぶ）', () => {
    const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/14', HIKARI, 99), row('2026/11/16', HIKARI, 40)];
    const { venues, projects } = applyAll(plan({ rows: rows.slice(0, 2) }), { rows: rows.slice(0, 2) });
    const { runs } = reportRuns(rows, venues);
    const separate = plan({ rows, projects, venues });
    expect(kinds(separate)).toEqual([`create:${HIKARI}:2026-11-16〜2026-11-16`, `update:${HIKARI}:2026-11-13〜2026-11-14`]);
    const c = creates(separate)[0];
    expect(c.near).toEqual([{ projectId: projects[0].id, projectName: projects[0].name, startDate: '2026-11-13', endDate: '2026-11-14', widenTo: { startDate: '2026-11-13', endDate: '2026-11-16' } }]);
    // 「前の開催と同じ案件にする」は、新しい候補どうしのときだけ（既存の案件につなぐときは、上の「会期を広げて取り込む」）
    expect(c.joinPrev).toBeNull();
    // 広げて同期すると、3 日分になり、間の日は「開催していない日」
    const wide = planProjectSync({ project: projects[0], projects, venues, rows, now: NOW, period: c.near[0].widenTo });
    expect(wide.change).toEqual({ from: { startDate: '2026-11-13', endDate: '2026-11-14' }, to: { startDate: '2026-11-13', endDate: '2026-11-16' }, notHeld: ['2026-11-15'] });
    expect(wide.plan.ok && wide.plan.sync.days.map((d) => d.count)).toEqual([30, 99, 40]);
    // 画面で「同じ案件にする」を選んであった開催が、あとから既存の案件につながった場合も、その案件の「会期の外の回答」として示す
    const joined = plan({ rows, projects, venues, joins: new Set([runs[1].id]) });
    expect(kinds(joined)).toEqual([`update:${HIKARI}:2026-11-13〜2026-11-16`]);
    const u = updates(joined)[0];
    expect([u.outside, u.widenTo, u.gaps]).toEqual([['2026-11-16'], { startDate: '2026-11-13', endDate: '2026-11-16' }, ['2026-11-15']]);
    expect(u.preview).toMatchObject({ ok: true, period: null, totals: { days: 2, count: 129 } });
  });
  it('4 日以上離れた開催・別の会場の案件・中止の案件は、「近くの案件」にしない', () => {
    const venues = [mkVenue('v-hikari', HIKARI), mkVenue('v-center', CENTER)];
    const near = (project: Project, date: string) => creates(plan({ rows: [row(date, HIKARI, 5)], projects: [project], venues }))[0].near.length;
    const base = mkProject({ id: 'p', name: '予定の案件', venueId: 'v-hikari', startDate: '2026-11-14', endDate: '2026-11-17', contents: [], assignments: [] });
    expect([near(base, '2026/11/13'), near(base, '2026/11/10'), near(base, '2026/11/09'), near(base, '2026/11/21'), near(base, '2026/11/22')]).toEqual([1, 1, 0, 1, 0]);
    expect([near({ ...base, venueId: 'v-center' }, '2026/11/13'), near({ ...base, status: '中止' }, '2026/11/13')]).toEqual([0, 0]);
  });
  it('すでに別々の案件になっている開催どうしには、「同じ案件にする」を出さない（案件を 1 つにはできない）', () => {
    const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/14', HIKARI, 99), row('2026/11/16', HIKARI, 40)];
    const first = plan({ rows });
    expect(creates(first).map((c) => !!c.joinPrev)).toEqual([false, true]);            // 候補のうちは、まとめられる
    const { venues, projects } = applyAll(first, { rows });
    const again = plan({ rows, projects, venues });
    expect(updates(again).map((u) => [u.startDate, u.joinPrev, u.preview.ok && u.preview.changed])).toEqual([['2026-11-13', null, false], ['2026-11-16', null, false]]);
  });
  it('会期を手で決めた案件に、開催が 2 つ入っているとき: 更新は案件 1 件にまとめ、会期の外に残る日を示す', () => {
    const venues = [mkVenue('v-hikari', HIKARI)];
    const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/14', HIKARI, 99), row('2026/11/16', HIKARI, 40), row('2026/11/17', HIKARI, 41)];
    const manual = mkProject({ id: 'p-manual', name: '手で作った案件', venueId: 'v-hikari', startDate: '2026-11-13', endDate: '2026-11-16', contents: [], assignments: [] });
    const p = plan({ rows, projects: [manual], venues });
    expect(kinds(p)).toEqual([`update:${HIKARI}:2026-11-13〜2026-11-17`]);
    const u = updates(p)[0];
    expect([u.runs.length, u.outside, u.widenTo, u.joinPrev]).toEqual([2, ['2026-11-17'], { startDate: '2026-11-13', endDate: '2026-11-17' }, null]);
    expect(u.preview).toMatchObject({ ok: true, totals: { days: 3, count: 169 } });
  });
});

describe('開催日 1 日ごとに、どの案件のものかを決める（開催のまとまりが、2 つ以上の案件にまたがるとき）', () => {
  const venues = [mkVenue('v-hikari', HIKARI)];
  const mk = (id: string, startDate: string, endDate: string, patch: Partial<Project> = {}) =>
    mkProject({ id, name: id, venueId: 'v-hikari', startDate, endDate, contents: [], assignments: [], ...patch });
  const days = (...ds: [string, number][]) => ds.map(([d, n]) => row(d, HIKARI, n));
  it('会期が隣り合う 2 つの案件: 連続した開催日が両方にまたがっても、日ごとに、それぞれの案件の更新になる（「決められない」にしない）', () => {
    // 手で作った案件（11/14〜17）の前日 11/13 を、別の案件として作ってある
    const planned = mk('planned', '2026-11-14', '2026-11-17');
    const early = mk('early', '2026-11-13', '2026-11-13', { reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-13' } });
    const p = plan({ rows: days(['2026/11/13', 30], ['2026/11/14', 99], ['2026/11/15', 40]), projects: [planned, early], venues });
    expect(p.items.map((i) => [i.kind, i.kind === 'update' && i.projectId, i.dates])).toEqual([
      ['update', 'early', ['2026-11-13']], ['update', 'planned', ['2026-11-14', '2026-11-15']],
    ]);
    expect(updates(p).map((u) => u.preview.ok && [u.preview.totals.days, u.preview.totals.count, u.preview.period])).toEqual([[1, 30, null], [2, 139, null]]);
  });
  it('日報から決めた会期の 2 つの案件に挟まれた日は、どちらにも自動では入れず、両方の案件に「会期を広げて取り込む」を出す', () => {
    const a = mk('a', '2026-11-13', '2026-11-13', { reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-13' } });
    const b = mk('b', '2026-11-15', '2026-11-15', { reportPeriod: { startDate: '2026-11-15', endDate: '2026-11-15' } });
    const p = plan({ rows: days(['2026/11/13', 30], ['2026/11/14', 99], ['2026/11/15', 40]), projects: [a, b], venues });
    expect(p.items.map((i) => i.kind)).toEqual(['update', 'update']);
    expect(updates(p).map((u) => [u.projectId, u.outside, u.widenTo, u.preview.ok && u.preview.period])).toEqual([
      ['a', ['2026-11-14'], { startDate: '2026-11-13', endDate: '2026-11-14' }, null],
      ['b', ['2026-11-14'], { startDate: '2026-11-14', endDate: '2026-11-15' }, null],
    ]);
    // 片方の会期を広げると、もう片方からは消える
    const wide = { ...a, endDate: '2026-11-14', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-14' } };
    expect(updates(plan({ rows: days(['2026/11/13', 30], ['2026/11/14', 99], ['2026/11/15', 40]), projects: [wide, b], venues })).map((u) => [u.projectId, u.outside])).toEqual([['a', []], ['b', []]]);
  });
  it('会期が重なる日だけが「決められない」。重ならない日は、それぞれの案件の更新。「この案件の実績にする」と決めてあれば、その案件のもの', () => {
    const p1 = mk('p1', '2026-11-13', '2026-11-15');
    const p2 = mk('p2', '2026-11-15', '2026-11-17');
    const rows = days(['2026/11/13', 1], ['2026/11/14', 2], ['2026/11/15', 4], ['2026/11/16', 8], ['2026/11/17', 16]);
    const open = plan({ rows, projects: [p1, p2], venues });
    expect(open.items.map((i) => [i.kind, i.dates])).toEqual([
      ['update', ['2026-11-13', '2026-11-14']], ['update', ['2026-11-16', '2026-11-17']], ['ambiguous', ['2026-11-15']],
    ]);
    expect(open.items[2]).toMatchObject({ projects: [{ id: 'p1' }, { id: 'p2' }] });
    // p1 が、11/15 を自分の実績と決めた
    const claimed = plan({ rows, projects: [{ ...p1, reportClaims: ['2026-11-15'] }, p2], venues });
    expect(claimed.items.map((i) => [i.kind, i.dates])).toEqual([['update', ['2026-11-13', '2026-11-14', '2026-11-15']], ['update', ['2026-11-16', '2026-11-17']]]);
    expect(updates(claimed).map((u) => u.preview.ok && u.preview.totals.count)).toEqual([7, 24]);
    // 両方が決めた・どちらも決めていない日は、決められないまま
    expect(plan({ rows, projects: [{ ...p1, reportClaims: ['2026-11-15'] }, { ...p2, reportClaims: ['2026-11-15'] }], venues }).items.map((i) => i.kind)).toEqual(['update', 'update', 'ambiguous']);
  });
  it('会期の外の回答を取り込むための「広げたあとの会期」は、ほかの進行中の案件の会期を越えない', () => {
    const p1 = mk('p1', '2026-11-13', '2026-11-13');
    const p2 = mk('p2', '2026-11-15', '2026-11-15');
    const p = plan({ rows: days(['2026/11/13', 1], ['2026/11/14', 2], ['2026/11/15', 4], ['2026/11/16', 8]), projects: [p1, p2], venues });
    expect(updates(p).map((u) => [u.projectId, u.outside, u.widenTo])).toEqual([
      ['p1', ['2026-11-14'], { startDate: '2026-11-13', endDate: '2026-11-14' }],
      ['p2', ['2026-11-14', '2026-11-16'], { startDate: '2026-11-14', endDate: '2026-11-16' }],
    ]);
  });
  it('間の日に、ほかの進行中の案件の会期が入っている 2 つの開催は、「同じ案件にする」でまとめない（まとめると、会期が重なる）', () => {
    const between = mk('between', '2026-11-14', '2026-11-14');
    const rows = days(['2026/11/13', 1], ['2026/11/15', 4]);
    const { runs } = reportRuns(rows, venues);
    const p = plan({ rows, projects: [between], venues, joins: new Set([runs[1].id]) });
    expect(creates(p).map((c) => [c.startDate, c.endDate, c.joinPrev, c.near.map((n) => n.projectId)])).toEqual([
      ['2026-11-13', '2026-11-13', null, ['between']], ['2026-11-15', '2026-11-15', null, ['between']],
    ]);
    // 間の案件が中止なら、まとめられる
    const ok = plan({ rows, projects: [{ ...between, status: '中止' }], venues, joins: new Set([runs[1].id]) });
    expect(creates(ok).map((c) => [c.startDate, c.endDate])).toEqual([['2026-11-13', '2026-11-15']]);
  });
});

describe('同じ取得で、ほかの案件の会期が変わるとき（見込みの会期で計画する）', () => {
  const base = [row('2026/11/10', HIKARI, 1), row('2026/11/11', HIKARI, 2), row('2026/11/14', HIKARI, 4), row('2026/11/15', HIKARI, 8)];
  it('隣の案件が、この取得で伸びて取る日を、「会期のすぐ外の回答」として記録しない（1 回の更新で、どちらの案件も「日報と同じ内容」になる）', () => {
    const { venues, projects } = applyAll(plan({ rows: base }), { rows: base });       // 11/10〜11 の案件と、11/14〜15 の案件
    const rows = [...base, row('2026/11/12', HIKARI, 16)];                              // 11/12 の回答が、あとから入った
    const p = plan({ rows, projects, venues });
    const [a, b] = updates(p);
    expect([a.preview, b.preview]).toMatchObject([{ ok: true, changed: true, period: { startDate: '2026-11-10', endDate: '2026-11-12' } }, { ok: true, changed: false, period: null }]);
    expect(p.projected.map((x) => [x.startDate, x.endDate])).toEqual([['2026-11-10', '2026-11-12'], ['2026-11-14', '2026-11-15']]);
    // 書く内容（見込みの一覧で計画したもの）を、それぞれ書いたあとで、もう一度計画しても、どちらも「変更なし」
    const write = (q: Project): Project => {
      const r = planProjectSync({ project: q, projects: p.projected.map((x) => (x.id === q.id ? q : x)), venues, rows, now: NOW });
      if (!r.plan.ok) throw new Error('unexpected');
      return { ...q, reportSync: r.plan.sync, ...(r.change ? { startDate: r.change.to.startDate, endDate: r.change.to.endDate, reportPeriod: r.change.to } : {}) };
    };
    const after = projects.map(write);
    expect(after.map((x) => x.reportSync!.outside)).toEqual([undefined, undefined]);
    expect(updates(plan({ rows, projects: after, venues })).map((u) => u.preview.ok && u.preview.changed)).toEqual([false, false]);
  });
});

describe('「変更なし」の判定は、保存して読み直した結果とも一致する', () => {
  /** オブジェクトのキーを、名前の順に並べ直す（共有データから読み直した形を模す） */
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  it('同じ日に回答が 2 件あり、組数・人数が、片方は入力・片方は空欄のとき（項目の並びが、作ったときと読み直したときで違う）', () => {
    const rows = [row('2026/11/13', HIKARI, 30, { groups: 17, people: 29 }), row('2026/11/13', HIKARI, 12), row('2026/11/14', HIKARI, 99, { groups: 52 })];
    const { venues, projects } = applyAll(plan({ rows }), { rows });
    expect(projects[0].reportSync!.days[0]).toMatchObject({ count: 42, rows: 2, groups: 17, groupsBlank: 1, people: 29, peopleBlank: 1 });
    const again = (sync: unknown) => updates(plan({ rows, venues, projects: [{ ...projects[0], reportSync: sync as Project['reportSync'] }] }))[0].preview;
    expect(again(projects[0].reportSync)).toMatchObject({ ok: true, changed: false });
    expect(again(hydrateReportSync(JSON.parse(JSON.stringify(projects[0].reportSync))))).toMatchObject({ ok: true, changed: false });
    expect(again(sorted(projects[0].reportSync))).toMatchObject({ ok: true, changed: false });
    // 中身が違えば、「変更あり」
    expect(again({ ...projects[0].reportSync!, days: projects[0].reportSync!.days.map((d, i) => (i === 0 ? { ...d, count: 41 } : d)) })).toMatchObject({ ok: true, changed: true });
  });
});

describe('候補の id は、会場の登録の有無で変わらない（先に 1 件だけ作っても、残りの候補の選択が外れない）', () => {
  it('未登録の会場の 2 つの開催: 片方を作って会場が登録されたあとも、残りの候補の id は同じ', () => {
    const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/20', HIKARI, 40)];
    const first = plan({ rows });
    const [a, b] = creates(first);
    const done = importCreates(first, new Set([a.id]), ctx({ rows }));
    const rest = creates(plan({ rows, projects: done.projects, venues: done.venues }));
    expect(rest.map((c) => [c.id, c.venue.state])).toEqual([[b.id, 'known']]);
    expect(reportRuns(rows).runs.map((r) => r.id)).toEqual(reportRuns(rows, done.venues).runs.map((r) => r.id));
  });
});

describe('記号だけが違う会場名が 3 つ以上あるとき', () => {
  const R = mkVenue('v-r', '北街モール 中央広場');
  const A = CENTER;                       // 北街モール（中央広場）… 回答 2 件
  const B = '北街モール・中央広場';       // 回答 1 件
  const rows = [row('2026/11/13', A, 1), row('2026/11/14', A, 1), row('2026/11/20', 'その他', 1, { other: B })];
  const choice = (c: { venue: { state: string } }) => (c.venue as unknown as { choiceNew: string }).choiceNew;
  it('登録済みの会場と「別の会場」と答えた書き方どうしも、比べる（相手が増えたら、もう一度確かめる）', () => {
    const [a0, b0] = creates(plan({ rows, venues: [R] }));
    expect([a0.blocked, b0.blocked, a0.venue, b0.venue]).toMatchObject([{ reason: 'venue' }, { reason: 'venue' }, { candidates: [R], pending: [] }, { candidates: [R], pending: [] }]);
    // 少ない書き方（B）を、先に「別の会場」と答えた
    const onlyB = creates(plan({ rows, venues: [R], venueChoice: { [b0.key]: choice(b0) } }));
    expect(onlyB.map((c) => c.blocked?.reason ?? null)).toEqual(['venue', null]);
    // 多い書き方（A）も「別の会場」と答えると、B は、A とも比べる必要が出るので、もう一度確かめる
    const both = creates(plan({ rows, venues: [R], venueChoice: { [b0.key]: choice(b0), [a0.key]: choice(a0) } }));
    expect(both.map((c) => c.blocked?.reason ?? null)).toEqual([null, 'venue']);
    expect(both[1].venue).toMatchObject({ state: 'similar', candidates: [R], pending: [{ key: a0.key, name: A }] });
    // B が、A とも「別の会場」と答えたら、それぞれ登録する
    const all = plan({ rows, venues: [R], venueChoice: { [a0.key]: choice(a0), [b0.key]: choice(both[1]) } });
    expect(importCreates(all, allIds(all), ctx({ rows, venues: [R] })).addedVenues.map((v) => v.name)).toEqual([A, B]);
  });
  it('どれも未登録のとき: 回答の多い順に見る。2 番目が「別の会場」なら、3 番目は、1 番目・2 番目の両方と比べる', () => {
    const C = '北街モール【中央広場】';
    const three = [...rows, row('2026/11/27', 'その他', 1, { other: C }), row('2026/11/20', 'その他', 1, { other: B })];
    const [a, b, c] = creates(plan({ rows: three })).sort((x, y) => y.rows - x.rows);
    expect([a.blocked, b.venue, c.venue]).toMatchObject([null, { pending: [{ name: A }] }, { pending: [{ name: A }] }]);
    const next = creates(plan({ rows: three, venueChoice: { [b.key]: choice(b) } })).find((x) => x.key === c.key)!;
    expect(next.venue).toMatchObject({ state: 'similar', pending: [{ name: A }, { name: B }] });
    expect(next.blocked).toEqual({ reason: 'venue' });
  });
});

describe('1 件の案件にできない開催', () => {
  it('366 日を超えて連続する開催は、作成できない旨を示す（途中までの実績で、黙って作らない）', () => {
    const start = Date.UTC(2025, 0, 1);
    const rows = Array.from({ length: 400 }, (_, i) => row(new Date(start + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'), HIKARI, 1));
    const c = creates(plan({ rows }))[0];
    expect([c.dates.length, c.project]).toEqual([400, null]);
    expect(c.blocked).toMatchObject({ reason: 'setup', message: expect.stringContaining('400 日') });
  });
});

describe('近い日に開催した、同じ会場の案件を、一緒に作る・別々に作る', () => {
  const rows = [row('2026/11/13', HIKARI, 30), row('2026/11/16', HIKARI, 40)];
  it('一緒に作ると、どちらの案件にも「会期のすぐ外にある、取り込んでいない回答」は残らない（作った直後に、日報と違うと見えない）', () => {
    const p = plan({ rows });
    // 候補の段階（まだ相手の案件が無い）では、相手の開催日が「会期のすぐ外」に見えている
    expect(creates(p).map((c) => c.project!.reportSync!.outside?.map((o) => o.date))).toEqual([['2026-11-16'], ['2026-11-13']]);
    const { venues, projects } = applyAll(p, { rows });
    expect(projects.map((x) => x.reportSync!.outside)).toEqual([undefined, undefined]);
    expect(updates(plan({ rows, projects, venues })).map((u) => u.preview.ok && u.preview.changed)).toEqual([false, false]);
  });
  it('1 件だけ先に作ると、残りの開催日は「会期のすぐ外」として残る。あとから残りを作ると、先の案件は「変更あり」になり、同期し直すまでの間も、広げる候補としては出さない', () => {
    const p = plan({ rows });
    const one = importCreates(p, new Set([creates(p)[0].id]), ctx({ rows }));
    expect(one.projects.map((x) => x.reportSync!.outside?.map((o) => o.date))).toEqual([['2026-11-16']]);
    expect(openOutside(one.projects[0], { projects: one.projects, venues: one.venues }).map((o) => o.date)).toEqual(['2026-11-16']);
    const next = plan({ rows, projects: one.projects, venues: one.venues });
    const two = importCreates(next, allIds(next), ctx({ rows, projects: one.projects, venues: one.venues }));
    const projects = [...one.projects, ...two.projects];
    expect(two.projects.map((x) => x.reportSync!.outside)).toEqual([undefined]);
    // 先の案件に保存してある記録は古いまま。いまの案件と照らして、出さない
    expect(openOutside(projects[0], { projects, venues: two.venues })).toEqual([]);
    expect(updates(plan({ rows, projects, venues: two.venues })).map((u) => u.preview.ok && u.preview.changed)).toEqual([true, false]);
  });
});

describe('案件名の初期値', () => {
  const g = (eventName: string, venueName: string, startDate: string, endDate = startDate) => ({ eventName, venueName, startDate, endDate });
  it('同じイベント名の開催が複数あるときは、開催日を添えて見分けられるようにする（1 つだけなら、イベント名のまま）', () => {
    expect(importNames([g('花あそび', CENTER, '2026-09-14'), g('花あそび', CENTER, '2026-09-16', '2026-09-17'), g('秋まつり', EAST, '2026-10-01')], new Set()))
      .toEqual(['花あそび（9/14）', '花あそび（9/16〜9/17）', '秋まつり']);
  });
  it('いまある案件と同じ名前になるときも、開催日を添える（先に作った案件が、開催日を添えた名前のときも。付け方をそろえる）', () => {
    expect(importNames([g('花あそび', CENTER, '2026-09-14')], new Set(['花あそび']))).toEqual(['花あそび（9/14）']);
    expect(importNames([g('花あそび', CENTER, '2026-09-16')], new Set(['花あそび（9/14）']))).toEqual(['花あそび（9/16）']);
    expect(importNames([g('花あそび', CENTER, '2026-09-16')], new Set(['花あそびの会', '秋の花あそび']))).toEqual(['花あそび']);
  });
  it('同じイベント名・同じ開催日で、会場が違うときは、会場名も添える', () => {
    expect(importNames([g('花あそび', CENTER, '2026-09-14'), g('花あそび', EAST, '2026-09-14')], new Set())).toEqual([`花あそび（${CENTER}・9/14）`, `花あそび（${EAST}・9/14）`]);
  });
  it('いまの案件と、まったく同じ名前になるとき（別の年の、同じ会場・同じ日付の開催）は、年も添える', () => {
    expect(importNames([g('花あそび', CENTER, '2027-09-14')], new Set(['花あそび（9/14）']))).toEqual(['花あそび（2027/9/14）']);
    expect(importNames([g('', CENTER, '2027-09-14', '2027-09-15')], new Set([`${CENTER}（9/14〜9/15）`]))).toEqual([`${CENTER}（2027/9/14〜9/15）`]);
  });
  it('イベント名が無い開催は「会場名（開催日）」（会場と開催日が同じ開催は、1 つしか無い）', () => {
    expect(importNames([g('', CENTER, '2026-09-14'), g('', CENTER, '2026-09-16')], new Set())).toEqual([`${CENTER}（9/14）`, `${CENTER}（9/16）`]);
  });
  it('候補の案件名にも反映される（同じ会場で、同じイベント名の開催が 2 回あるとき）', () => {
    const rows = [row('2026/09/14', CENTER, 29, { event: '敬老の日' }), row('2026/09/16', CENTER, 20, { event: '敬老の日' })];
    expect(creates(plan({ rows })).map((c) => [c.name, c.project!.name])).toEqual([['敬老の日（9/14）', '敬老の日（9/14）'], ['敬老の日（9/16）', '敬老の日（9/16）']]);
  });
  it('登録済みの会場の開催は、会場マスタの会場名を使う（日報での書き方が別名でも）', () => {
    const venues = [mkVenue('v1', '北街モール 中央広場（1F）', [CENTER])];
    expect(creates(plan({ rows: [row('2026/11/13', CENTER, 10)], venues }))[0].name).toBe('北街モール 中央広場（1F）（11/13）');
  });
});

describe('読み取れない回答があるとき', () => {
  it('その開催の候補だけ、作成できない（どの回答の、どの項目かを示す）。ほかの開催の候補は、作成できる', () => {
    const rows = [...ROWS.slice(0, 14), row('2026/11/14', HIKARI, '99個', { groups: 52, people: 121 })];
    const p = plan({ rows });
    const bad = creates(p).find((c) => c.venueName === HIKARI)!;
    expect(bad.blocked).toMatchObject({ reason: 'rows', issues: [{ row: 16, date: '2026-11-14', items: [{ field: 'キットの使用数' }] }] });
    expect(bad.project).toBeNull();
    expect(creates(p).filter((c) => c.blocked === null).length).toBe(5);
    expect(importCreates(p, allIds(p), ctx({ rows })).projects.length).toBe(5);
    // 画面に出す文は、この画面のボタン名で案内する
    expect(bad.blocked).toMatchObject({ message: expect.stringContaining('「日報から案件を作成・更新」') });
  });
  it('参加人数に、数字以外が入っている回答があるときも、その開催の候補は作成できない（空欄なら作成できる）', () => {
    const bad = [row('2026/11/13', CENTER, 30, { groups: 17, people: '約 30 人' })];
    expect(creates(plan({ rows: bad }))[0].blocked).toMatchObject({ reason: 'rows', issues: [{ row: 2, items: [{ field: '参加人数' }] }] });
    expect(creates(plan({ rows: [row('2026/11/13', CENTER, 30, { groups: 17 })] }))[0].blocked).toBeNull();
  });
  it('会場名が空欄の回答は、その日を会期に含む開催の候補を、止める（どの開催のものか、決められないため）', () => {
    const rows = [row('2026/11/13', CENTER, 30), row('2026/11/13', '', 12), row('2026/12/01', EAST, 5)];
    const p = plan({ rows });
    expect(p.loose.map((x) => x.row)).toEqual([3]);
    expect(creates(p).map((c) => [c.venueName, c.blocked?.reason ?? null])).toEqual([[CENTER, 'rows'], [EAST, null]]);
  });
});

describe('表示用の部品', () => {
  it('日付の一覧を、連続する範囲にまとめる', () => {
    expect(dateRanges(['2026-11-16', '2026-11-13', '2026-11-14', '2026-11-14', '2026-11-18'])).toEqual([
      ['2026-11-13', '2026-11-14'], ['2026-11-16', '2026-11-16'], ['2026-11-18', '2026-11-18'],
    ]);
    expect(dateRanges([])).toEqual([]);
  });
});
