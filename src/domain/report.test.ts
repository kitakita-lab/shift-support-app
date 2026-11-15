// 日報の読み取り・照合・集計（report.ts）のテスト。
// 回答のデータは、実際の日報と同じ形（見出し・日付の書き方・「その他」の会場・テスト回答）に似せた架空のもの。
import { describe, expect, it } from 'vitest';
import { Project, ReportSync, Venue } from '../types';
import { emptyLayout } from './layout';
import {
  MAX_REPORT_COUNT, NEAR_GAP_DAYS, REPORT_HEADERS, RawReportRow, ReportIssue, clampedPeriod, columnLetter, contestedReportDays, countProblem, dateProblem, findReportColumns,
  findReportSource, fittedPeriod, grownPeriod, hasAutoPeriod, hydrateReportSync,
  isBlankRow, isTestRow, openOutside, parseReportCount, parseReportDate, parseReportTally, parseSheetUrl, periodLabel, planProjectSync, planReportSync, renamedForPeriod, reportVenue,
  rivalClaimedDates, syncStaleness,
  tallyProblem, unmatchedGaps, usableReportDays, venueKey, venueKeys, venueProblem, venueReportDates, widenTarget, contentKey,
  aliasEvidence, checkAlias, classifyUnmatched, looseVenueKey, registeredElsewhere, rivalVenue, shownStatus, withVenueAlias, REPORT_LAG_DAYS,
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

// ── 会場の「別の書き方」かどうか（別名を勧める根拠） ─────────────────
// 実機での確認（2026-11-16）で見つかった問題: 同じ日に、別の会場で開催した回答に、「別名として登録して同期」が出ていた。
// 同じ日・同じ会期、というだけでは、別名の候補にしない。会場名は、どれも架空のもの。
describe('会場の別の書き方だと言える根拠（aliasEvidence）', () => {
  const center = mkVenue('v-center', CENTER);
  it('記号・括弧だけが違う名前は、表記ゆれ（variant）', () => {
    for (const name of ['北街モール【中央広場】', '北街モール・中央広場', '北街モール-中央広場', '北街モール/中央広場', '「北街モール」中央広場']) {
      expect(aliasEvidence(name, center), name).toBe('variant');
    }
  });
  it('片方が、もう片方から文字を省いた形は、略称・書き足し（short）', () => {
    for (const name of ['北街モール', '北街モール1F 中央広場', '中央広場', '北街モール（中央広場）特設会場', '北街中央広場']) {
      expect(aliasEvidence(name, center), name).toBe('short');
    }
  });
  it('名前に共通点が無い会場・文字を省いた形でない会場は、根拠なし（同じ建物の、別の場所も）', () => {
    for (const name of [EAST, '南港アウトレット ゲート前', 'みなと市場', '北街モール（東口前）特設会場', '中央公園広場', '東街モール（中央広場）']) {
      expect(aliasEvidence(name, center), name).toBeNull();
    }
  });
  it('短すぎる名前（2 文字以下）は、多くの会場名に含まれるので、根拠にしない', () => {
    for (const name of ['北街', '広場', '中', '（）', '']) expect(aliasEvidence(name, center), name).toBeNull();
    expect(aliasEvidence('モール', center)).toBe('short');     // 3 文字からは、候補（登録の前に、利用者が確かめる）
  });
  it('すでに一致する名前（会場名・登録済みの別名。全角/半角・空白・英字の大小だけの違い）は、候補ではない', () => {
    for (const name of [CENTER, '北街モール(中央広場)', ' 北街モール （中央広場） ']) expect(aliasEvidence(name, center), name).toBeNull();
    const withAlias = mkVenue('v-center', CENTER, ['KITA MALL 1F']);
    expect(aliasEvidence('kita mall 1f', withAlias)).toBeNull();
  });
  it('登録済みの別名との比較でも、同じように見る', () => {
    const withAlias = mkVenue('v-center', CENTER, ['KITA MALL 1F']);
    expect(aliasEvidence('KITA-MALL 1F', withAlias)).toBe('variant');
    expect(aliasEvidence('KITA MALL', withAlias)).toBe('short');
    expect(aliasEvidence('SOUTH PORT OUTLET', withAlias)).toBeNull();
  });
  it('会場が無いとき・名前が空のときは、根拠なし', () => {
    expect(aliasEvidence('北街モール', undefined)).toBeNull();
    expect(aliasEvidence(null, center)).toBeNull();
    expect(looseVenueKey('北街モール（中央広場）')).toBe('北街モール中央広場');
  });
});

describe('別名として登録してよいか（checkAlias。登録する直前に通す）', () => {
  const SOUTH = '南港アウトレット ゲート前';
  const master = [mkVenue('v-center', CENTER, ['北街モール1F']), mkVenue('v-east', EAST), mkVenue('v-south', SOUTH, ['南港アウトレット'])];
  it('ほかの会場として登録済みの名前（会場名・別名）は、登録させない（別の会場の実績が混ざる）', () => {
    for (const name of [SOUTH, '南港アウトレット  ゲート前', '南港アウトレット', EAST, '北街モール(東口前)']) {
      const c = checkAlias(name, 'v-center', master);
      expect(c.ok, name).toBe(false);
      expect(!c.ok && c.reason, name).toBe('other-venue');
    }
    expect(registeredElsewhere(SOUTH, 'v-center', master)?.id).toBe('v-south');
    expect(registeredElsewhere(SOUTH, 'v-south', master)).toBeNull();        // 自分の会場の名前は、「ほかの会場」ではない
    expect(registeredElsewhere('', 'v-center', master)).toBeNull();
  });
  it('この会場の名前・登録済みの別名・空の名前・無い会場は、登録しない', () => {
    expect(checkAlias(CENTER, 'v-center', master)).toEqual({ ok: false, reason: 'already' });
    expect(checkAlias('北街モール1f', 'v-center', master)).toEqual({ ok: false, reason: 'already' });
    expect(checkAlias('  ', 'v-center', master)).toEqual({ ok: false, reason: 'empty' });
    expect(checkAlias('北街モール', 'v-none', master)).toEqual({ ok: false, reason: 'no-venue' });
  });
  it('この会場の別の書き方だと言える根拠があり、ほかの会場には当たらない名前だけ、登録できる', () => {
    expect(checkAlias('北街モール・中央広場', 'v-center', master)).toEqual({ ok: true, evidence: 'variant' });
    expect(checkAlias('中央広場', 'v-center', master)).toEqual({ ok: true, evidence: 'short' });
    expect(checkAlias('北街モール1F 中央広場', 'v-center', master)).toEqual({ ok: true, evidence: 'short' });
  });
  it('根拠の無い名前は、登録しない（登録するなら、「会場」タブで、意図して入れる）', () => {
    expect(checkAlias('駅前ひろば', 'v-center', master)).toEqual({ ok: false, reason: 'no-evidence' });
    expect(checkAlias('北街', 'v-center', master)).toEqual({ ok: false, reason: 'no-evidence' });          // 短すぎる名前
  });
  it('ほかの登録済みの会場にも、同じか、より強い根拠がある名前は、登録しない（同じ施設の、別の場所。どの会場の回答か、決められない）', () => {
    // 「北街モール」は、中央広場にも、東口前にも、略称として当たる
    const c = checkAlias('北街モール', 'v-center', master);
    expect(c).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(!c.ok && c.other?.id).toBe('v-east');
    expect(checkAlias('北街モール', 'v-east', master)).toMatchObject({ ok: false, reason: 'ambiguous' });   // 東口前の側から見ても、同じ
    expect(rivalVenue('北街モール', 'v-center', master, 'short')?.id).toBe('v-east');
    // 東口前が登録されていなければ、中央広場の略称として登録できる
    expect(checkAlias('北街モール', 'v-center', master.filter((v) => v.id !== 'v-east'))).toEqual({ ok: true, evidence: 'short' });
    // 記号だけが違う名前（強い根拠）は、ほかの会場に、略称としてだけ当たっても、登録できる
    const annex = [...master, mkVenue('v-annex', '北街モール（中央広場）別館')];
    expect(checkAlias('北街モール・中央広場', 'v-center', annex)).toEqual({ ok: true, evidence: 'variant' });
    expect(rivalVenue('北街モール・中央広場', 'v-center', annex, 'variant')).toBeNull();
    // 記号だけが違う名前が、2 つの会場に当たるとき（会場マスタの重複）は、登録しない
    const twin = [...master, mkVenue('v-twin', '北街モール 中央広場')];
    expect(checkAlias('北街モール・中央広場', 'v-center', twin)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
  it('書き込み（withVenueAlias）: 登録してよい名前だけ、その会場の別名に足す。足せないときは、会場マスタを変えない', () => {
    const okay = withVenueAlias(master, 'v-center', ' 北街モール・中央広場 ');
    expect(okay.ok && okay.venues.find((v) => v.id === 'v-center')!.reportNames).toEqual(['北街モール1F', '北街モール・中央広場']);
    expect(okay.ok && okay.venues.filter((v) => v.id !== 'v-center')).toEqual(master.filter((v) => v.id !== 'v-center'));   // ほかの会場は、そのまま
    expect(master.find((v) => v.id === 'v-center')!.reportNames).toEqual(['北街モール1F']);                                 // 元の一覧は、書き換えない
    for (const [name, reason] of [[SOUTH, 'other-venue'], ['南港アウトレット', 'other-venue'], ['駅前ひろば', 'no-evidence'], ['北街モール', 'ambiguous'], [CENTER, 'already'], ['  ', 'empty']] as const) {
      const r = withVenueAlias(master, 'v-center', name);
      expect(r.ok, name).toBe(false);
      expect(!r.ok && r.check.reason, name).toBe(reason);
    }
    expect(withVenueAlias(master, 'v-none', '北街モール')).toMatchObject({ ok: false, check: { reason: 'no-venue' } });
  });
});

describe('会場名が一致しなかった回答の分け方（classifyUnmatched）', () => {
  const SOUTH = '南港アウトレット ゲート前';
  const master = [mkVenue('v-center', CENTER), mkVenue('v-east', EAST), mkVenue('v-south', SOUTH)];
  const names = (v: { venue: string }[]) => v.map((u) => u.venue);
  it('実機で見つかった場面: 同じ日に、登録済みの別の会場の回答がある → 別名の候補にしない・確認も求めない', () => {
    // この案件（中央広場）は、4 日とも実績がある。最終日に、別の会場（南港）でも開催していた
    // （会場名・日付・個数は、架空のもの）
    const p = mkProject({ id: 'p1', name: '秋の花まつり', venueId: 'v-center', startDate: '2026-10-06', endDate: '2026-10-09' });
    const s = plan([
      row('2026/10/06', CENTER, '61'), row('2026/10/07', CENTER, '47'), row('2026/10/08', CENTER, '52'), row('2026/10/09', CENTER, '58'),
      row('2026/10/09', 'その他', '6', SOUTH),
    ], { project: p, venues: master });
    expect(dayList(s)).toEqual([['2026-10-06', 61, 1], ['2026-10-07', 47, 1], ['2026-10-08', 52, 1], ['2026-10-09', 58, 1]]);   // 別の会場の 6 個は、入らない
    expect(s.unmatched).toEqual([{ venue: SOUTH, rows: 1, count: 6, dates: ['2026-10-09'] }]);
    const view = classifyUnmatched(s, master);
    expect(view.candidates).toEqual([]);
    expect(view.others).toEqual([{ venue: SOUTH, rows: 1, count: 6, dates: ['2026-10-09'], registered: true, gap: false }]);
    expect(unmatchedGaps(s, master)).toEqual([]);
  });
  it('登録済みの別の会場は、この案件の実績が無い日の回答でも、別名の候補にしない', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '40', SOUTH), row('2026/11/15', EAST, '33')], { venues: master });
    const view = classifyUnmatched(s, master);
    expect(view.candidates).toEqual([]);
    expect(view.others.map((u) => [u.venue, u.registered, u.gap])).toEqual([[EAST, true, true], [SOUTH, true, true]]);
    expect(unmatchedGaps(s, master)).toEqual([]);
  });
  it('名前に共通点の無い、未登録の会場名は、別名の候補にしない（実績の無い日の回答なら、知らせるだけ）', () => {
    const only = [mkVenue('v-center', CENTER)];
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/13', 'その他', '7', SOUTH), row('2026/11/14', 'その他', '40', '駅前ひろば')], { venues: only });
    const view = classifyUnmatched(s, only);
    expect(view.candidates).toEqual([]);
    expect(view.others.map((u) => [u.venue, u.registered, u.gap]).sort()).toEqual([[SOUTH, false, false], ['駅前ひろば', false, true]].sort());
    expect(names(unmatchedGaps(s, only))).toEqual(['駅前ひろば']);          // 同じ日（11/13）の別の会場は、知らせない
  });
  it('記号だけが違う名前は、実績のある日でも、別名の候補（表記ゆれ）', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/13', 'その他', '9', '北街モール・中央広場')], { venues: master });
    expect(classifyUnmatched(s, master).candidates).toEqual([{ venue: '北街モール・中央広場', rows: 1, count: 9, dates: ['2026-11-13'], evidence: 'variant' }]);
    expect(names(unmatchedGaps(s, master))).toEqual(['北街モール・中央広場']);
  });
  it('略称・書き足しの名前は、この案件の実績が無い日の回答だけ、別名の候補にする（実績のある日なら、同じ日の、別の場所の開催とみなす）', () => {
    const only = [mkVenue('v-center', CENTER), mkVenue('v-south', SOUTH)];
    const sameDay = plan([row('2026/11/13', CENTER, '62'), row('2026/11/13', 'その他', '9', '北街モール')], { venues: only });
    expect(classifyUnmatched(sameDay, only)).toEqual({ candidates: [], others: [{ venue: '北街モール', rows: 1, count: 9, dates: ['2026-11-13'], registered: false, gap: false }] });
    expect(unmatchedGaps(sameDay, only)).toEqual([]);
    const gapDay = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '9', '北街モール')], { venues: only });
    expect(classifyUnmatched(gapDay, only).candidates.map((u) => [u.venue, u.evidence])).toEqual([['北街モール', 'short']]);
  });
  it('略称・書き足しの名前が、実績のある日にも、無い日にも出ているときは、候補にしない（登録すると、実績のある日の、別の場所の個数も入ってしまう）', () => {
    const only = [mkVenue('v-center', CENTER), mkVenue('v-south', SOUTH)];
    const p = mkProject({ id: 'p1', name: '秋の花まつり', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-15' });
    // 中央広場の実績は 11/13・11/14。「北街モール」は 11/14（中央広場と同じ日）と 11/15
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', CENTER, '58'), row('2026/11/14', 'その他', '9', '北街モール'), row('2026/11/15', 'その他', '11', '北街モール')], { project: p, venues: only });
    expect(classifyUnmatched(s, only)).toEqual({ candidates: [], others: [{ venue: '北街モール', rows: 2, count: 20, dates: ['2026-11-14', '2026-11-15'], registered: false, gap: true }] });
    expect(names(unmatchedGaps(s, only))).toEqual(['北街モール']);            // 実績の無い日（11/15）があるので、知らせる（ボタンは出さない）
    // 記号だけが違う名前は、これまでどおり、日を問わず候補
    const v = plan([row('2026/11/13', CENTER, '62'), row('2026/11/13', 'その他', '9', '北街モール・中央広場'), row('2026/11/15', 'その他', '11', '北街モール・中央広場')], { project: p, venues: only });
    expect(classifyUnmatched(v, only).candidates.map((u) => [u.venue, u.evidence])).toEqual([['北街モール・中央広場', 'variant']]);
  });
  it('ほかの登録済みの会場にも当たる略称（同じ施設の、別の場所が両方登録してある）は、候補にしない。どの会場に似ているかを示す', () => {
    // master には、中央広場と東口前の両方がある
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '9', '北街モール')], { venues: master });
    expect(classifyUnmatched(s, master)).toEqual({ candidates: [], others: [{ venue: '北街モール', rows: 1, count: 9, dates: ['2026-11-14'], registered: false, gap: true, similar: EAST }] });
    expect(names(unmatchedGaps(s, master))).toEqual(['北街モール']);
  });
  it('同期のあとで、案件の会場を変えたときは、何も勧めない（保存してある「一致しなかった回答」は、前の会場から見たもの）', () => {
    const only = [mkVenue('v-center', CENTER), mkVenue('v-south', SOUTH)];
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '9', '北街モール・中央広場'), row('2026/11/14', 'その他', '40', SOUTH)], { venues: only });
    expect(names(classifyUnmatched(s, only, 'v-center').candidates)).toEqual(['北街モール・中央広場']);       // 会場が同じなら、これまでどおり
    expect(classifyUnmatched(s, only, 'v-south')).toEqual({ candidates: [], others: [] });                    // 会場を、南港に変えた
    expect(unmatchedGaps(s, only, 'v-south')).toEqual([]);
    expect(names(classifyUnmatched(s, only).candidates)).toEqual(['北街モール・中央広場']);                   // 会場を渡さなければ、同期のときの会場で見る
  });
  it('同期のあとで、その名前の会場が登録されたら、その時点から、別の会場として扱う（候補から外れる）', () => {
    const before = [mkVenue('v-center', CENTER)];
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '9', '北街モール')], { venues: before });
    expect(names(classifyUnmatched(s, before).candidates)).toEqual(['北街モール']);
    const after = [...before, mkVenue('v-mall', '北街モール')];
    expect(classifyUnmatched(s, after)).toEqual({ candidates: [], others: [{ venue: '北街モール', rows: 1, count: 9, dates: ['2026-11-14'], registered: true, gap: true }] });
    expect(unmatchedGaps(s, after)).toEqual([]);
  });
  it('誤って別名に登録した場合に起きること（＝登録の前に止める理由）: 別の会場の個数が、この案件の実績に混ざる', () => {
    const p = mkProject({ id: 'p1', name: '秋の花まつり', venueId: 'v-center', startDate: '2026-10-09', endDate: '2026-10-09' });
    const rows = [row('2026/10/09', CENTER, '58'), row('2026/10/09', 'その他', '6', SOUTH)];
    const wrong = [mkVenue('v-center', CENTER, [SOUTH])];                      // 南港を、中央広場の別名にしてしまった会場マスタ
    expect(dayList(plan(rows, { project: p, venues: wrong }))).toEqual([['2026-10-09', 64, 2]]);
    // 登録の前の確認（checkAlias）は、南港が会場として登録されていれば、これを止める
    expect(checkAlias(SOUTH, 'v-center', master)).toMatchObject({ ok: false, reason: 'other-venue' });
  });
});

// ── 一覧・見出しに出す「状態」（会期中は「開催中」。保存してある状態は、変えない） ─────────
// 実機での確認（2026-11-16）で見つかった場面: 日報から作った案件（会期は、日報の最新の回答の日まで）が、開催が続いているのに「実施済」と出ていた。
describe('一覧に出す状態（shownStatus）', () => {
  const base = { startDate: '2026-11-13', endDate: '2026-11-15' };
  /** 会期を、日報に合わせている案件（日報から作った案件は、こうなる） */
  const auto = { ...base, reportPeriod: { ...base } };
  const label = (p: Parameters<typeof shownStatus>[0], today: string) => shownStatus(p, today).label;
  it('実機での場面: 日報から作った案件（実施済）は、最新の回答の日の翌日まで「開催中」（今日の回答は、まだ出ていないだけかもしれない）', () => {
    const p = { ...auto, status: '実施済' as const };
    expect(label(p, '2026-11-12')).toBe('実施済');     // 会期の前（ふつうは起きない）
    expect(label(p, '2026-11-13')).toBe('開催中');
    expect(label(p, '2026-11-15')).toBe('開催中');     // 最新の回答の日
    expect(label(p, '2026-11-16')).toBe('開催中');     // その翌日（実機で確認した日）
    expect(label(p, '2026-11-17')).toBe('実施済');     // 2 日あと: 新しい回答が無ければ、終わったものとして出す
    expect(REPORT_LAG_DAYS).toBe(1);
    expect(shownStatus(p, '2026-11-16').note).toContain('保存してある状態は「実施済」のままです');
    expect(shownStatus(p, '2026-11-17').note).toBe('');
  });
  it('新しい回答で会期が延びれば、延びた会期で見る', () => {
    const grown = { startDate: '2026-11-13', endDate: '2026-11-16', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-16' }, status: '実施済' as const };
    expect(label(grown, '2026-11-17')).toBe('開催中');
    expect(label(grown, '2026-11-18')).toBe('実施済');
  });
  it('会期を手で決めた案件の「実施済」は、利用者が決めたものなので、会期中でも、そのまま出す', () => {
    const manual = { ...base, status: '実施済' as const };
    for (const today of ['2026-11-13', '2026-11-15', '2026-11-16']) expect(label(manual, today), today).toBe('実施済');
    // 日報から作ったあとで、会期を手で変えた案件も、同じ（日報に合わせた会期ではなくなっている）
    const edited = { startDate: '2026-11-13', endDate: '2026-11-17', reportPeriod: { ...base }, status: '実施済' as const };
    expect(label(edited, '2026-11-16')).toBe('実施済');
  });
  it('「確定」の案件は、会期中だけ「開催中」（会期の前・あとは、そのまま。手で決めた会期には、翌日の猶予を付けない）', () => {
    const p = { ...base, status: '確定' as const };
    expect(label(p, '2026-11-12')).toBe('確定');       // 開催予定
    expect(label(p, '2026-11-13')).toBe('開催中');
    expect(label(p, '2026-11-15')).toBe('開催中');
    expect(label(p, '2026-11-16')).toBe('確定');       // 過去（状態を「実施済」にするのは、利用者）
    expect(shownStatus(p, '2026-11-14').note).toContain('保存してある状態は「確定」のままです');
  });
  it('「計画中」「中止」は、会期中でも、そのまま出す（開催が決まっていない・中止した案件を、日付だけで「開催中」と出さない）', () => {
    for (const status of ['計画中', '中止'] as const) {
      for (const today of ['2026-11-12', '2026-11-14', '2026-11-16', '2026-11-20']) {
        expect(shownStatus({ ...auto, status }, today), `${status} ${today}`).toEqual({ label: status, note: '' });
        expect(shownStatus({ ...base, status }, today), `${status} ${today}`).toEqual({ label: status, note: '' });
      }
    }
  });
  it('会期が未入力・正しくない・今日の日付が読めないときは、保存してある状態のまま', () => {
    for (const p of [{ startDate: '', endDate: '' }, { startDate: '2026-11-15', endDate: '2026-11-13' }, { startDate: '2026-02-30', endDate: '2026-03-02' }]) {
      expect(shownStatus({ ...p, status: '確定' }, '2026-11-14')).toEqual({ label: '確定', note: '' });
    }
    expect(shownStatus({ ...base, status: '確定' }, '')).toEqual({ label: '確定', note: '' });
    expect(shownStatus({ ...base, status: '確定' }, 'きょう')).toEqual({ label: '確定', note: '' });
  });
  it('どの日付でも、「開催中」以外は、保存してある状態と同じ（勝手に別の状態にしない）', () => {
    const statuses = ['計画中', '確定', '実施済', '中止'] as const;
    for (let d = 1; d <= 30; d++) {
      const today = `2026-11-${String(d).padStart(2, '0')}`;
      for (const status of statuses) for (const p of [{ ...base, status }, { ...auto, status }]) {
        const v = shownStatus(p, today);
        if (v.label !== '開催中') expect(v, `${status} ${today}`).toEqual({ label: status, note: '' });
        else expect(v.note, `${status} ${today}`).not.toBe('');
      }
    }
  });
});

// ── 見出し ──────────────────────────────────────────────────
describe('見出しから、取得する列を決める', () => {
  it('実際の日報と同じ見出しなら、開催日＝D・会場＝F・会場（その他の場合）＝G・イベント名＝H・イベント内容＝I・参加組数＝J・参加人数＝K・キットの使用数＝L', () => {
    const r = findReportColumns(HEADER);
    expect(r).toEqual({ ok: true, cols: { date: 3, venue: 5, venueOther: 6, event: 7, count: 11, content: 8, groups: 9, people: 10 } });
    if (r.ok) {
      expect([r.cols.date, r.cols.venue, r.cols.venueOther, r.cols.event, r.cols.content, r.cols.groups, r.cols.people, r.cols.count].map((i) => columnLetter(i!)))
        .toEqual(['D', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
    }
  });
  it('取得する列は、この 8 つだけ（メールアドレス・入力者・メモ・自由記述・エピソードの見出しは、取得する列に入らない）', () => {
    expect(Object.values(REPORT_HEADERS).sort()).toEqual(['イベント内容', 'イベント名', 'キットの使用数', '会場', '会場（その他の場合）', '参加人数', '参加組数', '開催日'].sort());
  });
  it('列の位置が変わっても、見出しの名前で見つける（質問が増えて列がずれた日報から、別の列の数字を取り込まない）', () => {
    const moved = ['タイムスタンプ', 'メールアドレス', '入力者', '新しい質問', ...HEADER.slice(3)];
    expect(findReportColumns(moved)).toEqual({ ok: true, cols: { date: 4, venue: 6, venueOther: 7, event: 8, count: 12, content: 9, groups: 10, people: 11 } });
  });
  it('見出しの全角/半角・空白の違いは同じとみなす', () => {
    const r = findReportColumns(['開催日 ', '会場', '会場(その他の場合)', 'キットの 使用数']);
    expect(r).toEqual({ ok: true, cols: { date: 0, venue: 1, venueOther: 2, event: null, count: 3, content: null, groups: null, people: null } });
  });
  it('必要な見出しが無ければエラー（取り込まない）。イベント名・会場（その他の場合）・イベント内容・参加組数・参加人数は無くてもよい', () => {
    expect(findReportColumns(['開催日', '会場', '参加人数'])).toEqual({ ok: false, missing: ['キットの使用数'], duplicated: [] });
    expect(findReportColumns([])).toEqual({ ok: false, missing: ['開催日', '会場', 'キットの使用数'], duplicated: [] });
    expect(findReportColumns(['開催日', '会場', 'キットの使用数']))
      .toEqual({ ok: true, cols: { date: 0, venue: 1, venueOther: null, event: null, count: 2, content: null, groups: null, people: null } });
  });
  it('参加組数・参加人数の見出しが 2 つあれば、エラー（どちらの列か決められない）', () => {
    expect(findReportColumns(['開催日', '会場', 'キットの使用数', '参加人数', '参加人数'])).toEqual({ ok: false, missing: [], duplicated: ['参加人数'] });
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
    expect(unmatchedGaps(s, venues)).toEqual([]);
  });
  it('この案件の実績が無い日に、別の書き方の会場名の回答があれば、確認を求める（書き方が違うだけかもしれない）', () => {
    const s = plan([row('2026/11/13', CENTER, '62'), row('2026/11/14', 'その他', '58', '北街モール1F 中央広場'), row('2026/11/13', EAST, '33')]);
    expect(unmatchedGaps(s, venues).map((u) => u.venue)).toEqual(['北街モール1F 中央広場']);
  });
  it('1 件も取り込めていないときも、ほかの会場として登録済みの会場名の回答は、確認の対象にしない（別の会場の開催と分かっている）', () => {
    const s = plan([row('2026/11/13', 'その他', '62', '北街モール中央'), row('2026/11/14', EAST, '33')]);
    expect(s.unmatched.map((u) => u.venue).sort()).toEqual([EAST, '北街モール中央'].sort());
    expect(unmatchedGaps(s, venues).map((u) => u.venue)).toEqual(['北街モール中央']);
    // 会場マスタに無い名前なら、どの回答も、確認の対象（会場を登録する前の状態）
    expect(unmatchedGaps(s, [mkVenue('v-center', CENTER)]).map((u) => u.venue).sort()).toEqual([EAST, '北街モール中央'].sort());
  });
  it('保留にした日（会期が重なる案件がある日）は、実績が無い日として扱わない', () => {
    const Q = mkProject({ id: 'p2', name: '週末フェア', venueId: 'v-center', startDate: '2026-11-14', endDate: '2026-11-14' });
    const s = plan([row('2026/11/14', CENTER, '58'), row('2026/11/14', EAST, '33')], { projects: [P, Q] });
    expect(s.held.map((h) => h.date)).toEqual(['2026-11-14']);
    expect(unmatchedGaps(s, venues)).toEqual([]);
  });
  it('同期していない案件', () => {
    expect(unmatchedGaps(undefined, venues)).toEqual([]);
    expect(classifyUnmatched(undefined, venues)).toEqual({ candidates: [], others: [] });
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
    // 参加組数・参加人数・イベント内容だけが入った行（手で足した合計の行など）は、空行として外す（Version 4 と同じ判定。同期を止めない）
    expect(isBlankRow({ date: '', venue: '', venueOther: '', event: '', count: '', groups: 120, people: 300, content: '合計' })).toBe(true);
    expect(isBlankRow({ date: '2026/11/13', venue: '', venueOther: '', event: '', count: '', groups: '', people: '', content: '' })).toBe(false);
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

// ── Version 5: 参加組数・参加人数・イベント内容 ──────────────────────
/** 回答 1 件（参加組数・参加人数・イベント内容つき） */
const full = (date: unknown, venue: unknown, count: unknown, groups: unknown = '', people: unknown = '', content: unknown = '花の小びんづくり（無料）'): RawReportRow =>
  ({ date, venue, venueOther: '', event: '', count, groups, people, content });

describe('参加組数・参加人数の読み取り', () => {
  it('数（0 以上の整数。文字で届いてもよい）は読む。空欄は「未入力」、それ以外は「読み取れない」', () => {
    expect([12, 0, '12', ' １２ ', '1,234'].map((v) => parseReportTally(v))).toEqual([12, 0, 12, 12, 1234].map((value) => ({ kind: 'ok', value })));
    expect(['', '   ', null, undefined].map((v) => parseReportTally(v).kind)).toEqual(['blank', 'blank', 'blank', 'blank']);
    expect(['約30', '30組', '3 0', -1, 1.5, 46339, '十', '#N/A'].map((v) => parseReportTally(v).kind)).toEqual(Array(8).fill('bad'));
  });
  it('読み取れない理由（空欄・読み取れる値には、理由が無い）', () => {
    expect(['', 12, '12'].map((v) => tallyProblem('参加人数', v))).toEqual([null, null, null]);
    expect(tallyProblem('参加人数', '約 30 人')).toContain('「参加人数」に数字以外の文字');
    expect(tallyProblem('参加組数', -3)).toBe('「参加組数」がマイナスの値です');
    expect(tallyProblem('参加組数', 2.5)).toBe('「参加組数」が整数ではありません（小数です）');
    expect(tallyProblem('参加人数', 46339)).toContain('「参加人数」が大きすぎます');
  });
});

describe('同期の結果に、参加組数・参加人数・イベント内容が入る', () => {
  it('日ごとに合計する。同じ日の回答が複数あれば、足す', () => {
    const s = plan([full('2026/11/13', CENTER, 62, 30, 71), full('2026/11/13', CENTER, 8, 4, 9), full('2026/11/14', CENTER, 58, 28, 66)]);
    expect(s.days.map((d) => [d.date, d.count, d.groups, d.people, d.groupsBlank, d.peopleBlank])).toEqual([
      ['2026-11-13', 70, 34, 80, undefined, undefined],
      ['2026-11-14', 58, 28, 66, undefined, undefined],
    ]);
  });
  it('空欄の回答は、未入力として進める（0 とはみなさない。同期は止めない）。一部だけ未入力の日は、未入力の件数を持つ', () => {
    const s = plan([full('2026/11/13', CENTER, 62), full('2026/11/14', CENTER, 58, 28, ''), full('2026/11/14', CENTER, 5, '', 9)]);
    const BIN = '花の小びんづくり（無料）';                                                                      // full() の、内容の初期値
    expect(s.days[0]).toEqual({ date: '2026-11-13', count: 62, rows: 1, keys: [venueKey(CENTER)], contents: [{ label: BIN, count: 62 }] });   // どちらも未入力 … 項目そのものを持たない
    expect(s.days[1]).toEqual({ date: '2026-11-14', count: 63, rows: 2, keys: [venueKey(CENTER)], groups: 28, groupsBlank: 1, people: 9, peopleBlank: 1, contents: [{ label: BIN, count: 63 }] });
  });
  it('0 と入力された回答は、0 として数える（未入力とは区別する）', () => {
    const s = plan([full('2026/11/13', CENTER, 0, 0, 0)]);
    expect(s.days[0]).toMatchObject({ count: 0, groups: 0, people: 0 });
    expect(s.days[0].groupsBlank).toBeUndefined();
  });
  it('参加組数・参加人数の列が無い日報（以前の形）でも、これまでと同じ結果になる', () => {
    const s = plan(ROWS);
    expect(s.days.every((d) => d.groups === undefined && d.people === undefined && d.groupsBlank === undefined && d.peopleBlank === undefined)).toBe(true);
    expect([s.contents, s.outside?.map((o) => o.date)]).toEqual([undefined, ['2026-11-12', '2026-11-18']]);
  });
  it('空欄でないのに数として読み取れない回答が、この案件のものなら、同期の全体を止める（項目名と理由を示す。書かれていた文字は持たない）', () => {
    const r = planReportSync({ project: P, projects: [P], venues, rows: [full('2026/11/13', CENTER, 62, 30, 71), full('2026/11/14', CENTER, 58, '28組', '約66')], now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([{ row: 3, date: '2026-11-14', items: [
        { field: '参加組数', reason: expect.stringContaining('「参加組数」に数字以外の文字') },
        { field: '参加人数', reason: expect.stringContaining('「参加人数」に数字以外の文字') },
      ] }]);
      expect(JSON.stringify(r)).not.toContain('約66');
    }
  });
  it('ほかの会場・会期の外の回答の、読み取れない参加人数では、この案件の同期は止まらない', () => {
    const s = plan([full('2026/11/13', CENTER, 62, 30, 71), full('2026/11/13', EAST, 9, 'たくさん', 'いっぱい'), full('2026/12/24', CENTER, 5, '多数', '')]);
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1]]);
  });
  it('イベント内容ごとの、回答の数と個数（取り込んだ回答だけ。多い順）', () => {
    const s = plan([
      full('2026/11/13', CENTER, 62, 30, 71, '花の小びんづくり（無料）'), full('2026/11/14', CENTER, 58, 28, 66, ' 花の小びんづくり（無料） '),
      full('2026/11/15', CENTER, 12, 6, 12, '花の袋づくり'), full('2026/11/16', CENTER, 3, 1, 2, ''), full('2026/11/14', EAST, 99, 1, 1, '別の会場の内容'),
    ]);
    expect(s.contents).toEqual([{ label: '花の小びんづくり（無料）', rows: 2, count: 120 }, { label: '花の袋づくり', rows: 1, count: 12 }]);
  });
  it('日別にも、内容ごとの個数を持つ（内容ごとの材料原価の計算に使う）。記載の無い回答の個数は入れない。並びは、回答の順に依らない', () => {
    const rows = [
      full('2026/11/13', CENTER, 30, 1, 1, '花の袋づくり'), full('2026/11/13', CENTER, 62, 1, 1, '花の小びんづくり（無料）'), full('2026/11/13', CENTER, 8, 1, 1, ' 花の小びんづくり（無料）'),
      full('2026/11/13', CENTER, 5, 1, 1, ''),                                                       // 内容の記載なし（合計には入る）
      full('2026/11/14', CENTER, 3, 1, 1, ''),                                                       // 記載のある回答が 1 件も無い日 … 項目そのものを持たない
      full('2026/11/15', CENTER, 4, 1, 1, 'ＦＬＯＷＥＲ　ＢＡＧ'), full('2026/11/15', CENTER, 6, 1, 1, 'flower bag'),   // 全角/半角・空白・大小だけが違う書き方は、同じ内容
    ];
    const s = plan(rows);
    expect(s.days.map((d) => [d.date, d.count, d.contents])).toEqual([
      ['2026-11-13', 105, [{ label: '花の小びんづくり（無料）', count: 70 }, { label: '花の袋づくり', count: 30 }]],
      ['2026-11-14', 3, undefined],
      ['2026-11-15', 10, [{ label: 'ＦＬＯＷＥＲ　ＢＡＧ', count: 10 }]],
    ]);
    // 回答の順を逆にしても、日別の内訳の並びと個数は同じ（同じ内容の書き方が複数あるときの、表示用の書き方だけが変わる）
    const reversed = plan([...rows].reverse());
    expect(reversed.days.map((d) => d.contents?.map((c) => [contentKey(c.label), c.count]))).toEqual(s.days.map((d) => d.contents?.map((c) => [contentKey(c.label), c.count])));
    // 内容の列が無い日報（以前の形）では、どの日も、内訳を持たない
    expect(plan(ROWS).days.every((d) => d.contents === undefined)).toBe(true);
  });
  it('保存してある結果を読み直しても、同じ形のまま（形の合わない値は落とす）', () => {
    const s = plan([full('2026/11/13', CENTER, 62, 30, ''), full('2026/11/13', CENTER, 1, '', 5), full('2026/11/18', CENTER, 55, 1, 1)]);
    expect(hydrateReportSync(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const broken = { ...s, days: [{ ...s.days[0], groups: '30', people: -1, groupsBlank: null }], contents: [{ label: 5 }, { label: 'x', rows: 'a' }], outside: 'x' };
    const h = hydrateReportSync(broken)!;
    expect(h.days[0]).toEqual({ date: '2026-11-13', count: 63, rows: 2, keys: [venueKey(CENTER)], peopleBlank: 1, contents: [{ label: '花の小びんづくり（無料）', count: 63 }] });
    expect([h.contents, h.outside]).toEqual([[{ label: 'x', rows: 0, count: 0 }], undefined]);
    // 日別の内訳: 名前と、0 以上の個数がそろっているものだけを残す
    const brokenDay = { ...s, days: [{ ...s.days[0], contents: [{ label: 'ok', count: 3 }, { label: '', count: 1 }, { label: 'neg', count: -1 }, { label: 'str', count: '5' }, 'x'] }, { date: '2026-11-14', count: 1, rows: 1, contents: 'x' }] };
    expect(hydrateReportSync(brokenDay)!.days.map((d) => d.contents)).toEqual([[{ label: 'ok', count: 3 }], undefined]);
  });
});

// ── Version 5: 会期と、会期の外の回答 ──────────────────────────────
describe('会期のすぐ外にある、この会場の回答（取り込まないが、知らせる）', () => {
  it('会期の前後の、連続する日・数日以内の日にある回答を、日付・件数・個数で示す。取り込む実績には入れない', () => {
    const s = plan([full('2026/11/10', CENTER, 7), full('2026/11/12', CENTER, 40), full('2026/11/13', CENTER, 62), full('2026/11/18', CENTER, 55), full('2026/11/18', CENTER, 5), full('2026/11/21', CENTER, 9)]);
    expect(dayList(s)).toEqual([['2026-11-13', 62, 1]]);
    expect(s.outside).toEqual([
      { date: '2026-11-10', rows: 1, count: 7 }, { date: '2026-11-12', rows: 1, count: 40 },
      { date: '2026-11-18', rows: 2, count: 60 }, { date: '2026-11-21', rows: 1, count: 9 },
    ]);
  });
  it(`回答の無い日が ${NEAR_GAP_DAYS} 日を超えて離れた回答・別の会場の回答・テスト回答は、示さない`, () => {
    const s = plan([full('2026/11/13', CENTER, 62), full('2026/11/22', CENTER, 55), full('2026/11/18', EAST, 9), { ...full('2026/11/18', CENTER, 9), event: 'テスト' }]);
    expect(s.outside).toBeUndefined();
  });
  it('ほかの進行中の案件（同じ会場）の会期に入っている日は、示さない（その案件の実績）', () => {
    const next = mkProject({ id: 'p2', name: '次の開催', venueId: 'v-center', startDate: '2026-11-18', endDate: '2026-11-19' });
    const s = plan([full('2026/11/13', CENTER, 62), full('2026/11/18', CENTER, 55)], { projects: [P, next] });
    expect(s.outside).toBeUndefined();
    // 中止の案件の会期は、妨げにならない
    expect(plan([full('2026/11/13', CENTER, 62), full('2026/11/18', CENTER, 55)], { projects: [P, { ...next, status: '中止' }] }).outside?.length).toBe(1);
  });
});

describe('会期のすぐ外にある回答の記録は、使うたびに、いまの案件と照らす', () => {
  const one = mkProject({ id: 'p1', name: '1 日目の案件', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-13' });
  const rows = [full('2026/11/13', CENTER, 62), full('2026/11/15', CENTER, 55)];
  const synced = { ...one, reportSync: plan(rows, { project: one }) };
  it('同期のあとで変わっていなければ、記録のまま', () => {
    expect(openOutside(synced, { projects: [synced], venues })).toEqual([{ date: '2026-11-15', rows: 1, count: 55 }]);
    expect(openOutside(one, { projects: [one], venues })).toEqual([]);                    // まだ同期していない
  });
  it('同期のあとで、その日を会期に含む案件（同じ会場）ができたら、出さない。別の会場の案件・中止の案件なら、出したまま', () => {
    const next = mkProject({ id: 'p2', name: '別の開催', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-16' });
    expect(openOutside(synced, { projects: [synced, next], venues })).toEqual([]);
    expect(openOutside(synced, { projects: [synced, { ...next, venueId: 'v-east' }], venues }).length).toBe(1);
    expect(openOutside(synced, { projects: [synced, { ...next, status: '中止' }], venues }).length).toBe(1);
  });
  it('この案件の会期を手で広げて、その日が会期に入ったら、出さない（「会期が変わっています」として、同期し直しを勧める）', () => {
    const wide = { ...synced, endDate: '2026-11-15' };
    expect(openOutside(wide, { projects: [wide], venues })).toEqual([]);
  });
});

describe('会期の書き方と、会期が変わったときの案件名', () => {
  const p = (startDate: string, endDate: string) => ({ startDate, endDate });
  it('1 日だけなら、その日。2 日以上なら、開始日〜終了日（月と日。0 は付けない）', () => {
    expect([periodLabel('2026-08-01', '2026-08-01'), periodLabel('2026-08-01', '2026-08-03'), periodLabel('2026-11-30', '2026-12-02')]).toEqual(['8/1', '8/1〜8/3', '11/30〜12/2']);
  });
  it('案件名の末尾が、前の会期の書き方のままなら、新しい会期に合わせる（日報から作った案件の名前）', () => {
    expect(renamedForPeriod(`${CENTER}（11/13）`, p('2026-11-13', '2026-11-13'), p('2026-11-13', '2026-11-14'))).toBe(`${CENTER}（11/13〜11/14）`);
    expect(renamedForPeriod('秋の花まつり（11/13〜11/14）', p('2026-11-13', '2026-11-14'), p('2026-11-12', '2026-11-16'))).toBe('秋の花まつり（11/12〜11/16）');
    expect(renamedForPeriod(`秋の花まつり（${CENTER}・11/13）`, p('2026-11-13', '2026-11-13'), p('2026-11-13', '2026-11-14'))).toBe(`秋の花まつり（${CENTER}・11/13〜11/14）`);
  });
  it('利用者が付けた名前（末尾が、前の会期の書き方ではない）は、変えない', () => {
    const from = p('2026-11-13', '2026-11-13');
    const to = p('2026-11-13', '2026-11-14');
    for (const name of ['秋の花まつり', '', '秋の花まつり（11/14）', '秋の花まつり 11/13）', '11/13）', '秋の花まつり（11/13）ほか']) {
      expect(renamedForPeriod(name, from, to), name).toBe(name);
    }
  });
});

describe('会期を、日報に合わせて広げる', () => {
  const short = mkProject({ id: 'p1', name: '開催中', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-14' });
  const ctx = { projects: [short], venues };
  const rows = [full('2026/11/12', CENTER, 1), full('2026/11/13', CENTER, 1), full('2026/11/15', CENTER, 1), full('2026/11/16', CENTER, 1), full('2026/11/18', CENTER, 1), full('2026/11/23', CENTER, 1)];
  it('連続する日だけ（回答の無い日を挟まない）', () => {
    expect(grownPeriod(short, rows, ctx, 0)).toEqual({ startDate: '2026-11-12', endDate: '2026-11-16', added: ['2026-11-12', '2026-11-15', '2026-11-16'], gaps: [] });
  });
  it('回答の無い日を、指定した日数まで挟む。挟んだ日は「回答の無い日」として返す', () => {
    expect(grownPeriod(short, rows, ctx, 1)).toEqual({
      startDate: '2026-11-12', endDate: '2026-11-18', added: ['2026-11-12', '2026-11-15', '2026-11-16', '2026-11-18'], gaps: ['2026-11-17'],
    });
    expect(grownPeriod(short, rows, ctx, 4)?.endDate).toBe('2026-11-23');
  });
  it('広げる日が無ければ null。別の会場の回答・テスト回答では、広げない', () => {
    expect(grownPeriod(short, [full('2026/11/13', CENTER, 1), full('2026/11/15', EAST, 1), { ...full('2026/11/15', CENTER, 1), event: '【テスト】' }], ctx, 0)).toBeNull();
    expect(grownPeriod(short, [], ctx, 3)).toBeNull();
  });
  it('ほかの進行中の案件（同じ会場）の会期に当たったら、そこで止まる（その先へも広げない）', () => {
    const other = mkProject({ id: 'p2', name: '次の開催', venueId: 'v-center', startDate: '2026-11-16', endDate: '2026-11-16' });
    expect(grownPeriod(short, rows, { projects: [short, other], venues }, 3)).toEqual({ startDate: '2026-11-12', endDate: '2026-11-15', added: ['2026-11-12', '2026-11-15'], gaps: [] });
  });
  it('中止の案件・会場や会期が決まっていない案件は、広げない', () => {
    expect(grownPeriod({ ...short, status: '中止' }, rows, ctx, 0)).toBeNull();
    expect(grownPeriod({ ...short, venueId: '' }, rows, ctx, 0)).toBeNull();
    expect(grownPeriod({ ...short, endDate: '' }, rows, ctx, 0)).toBeNull();
  });
  it('この会場名の回答がある日（別名を含む。テスト回答・読み取れない回答は除く）', () => {
    const keys = venueKeys(mkVenue('v', CENTER, ['中央']));
    expect([...venueReportDates([full('2026/11/13', CENTER, 1), full('2026/11/14', '中央', 1), full('2026/11/15', EAST, 1), full('きのう', CENTER, 1)], keys)].sort()).toEqual(['2026-11-13', '2026-11-14']);
  });
});

describe('会期の変更をともなう同期（planProjectSync）', () => {
  const rows = [full('2026/11/13', CENTER, 30, 17, 29), full('2026/11/14', CENTER, 99, 52, 121), full('2026/11/16', CENTER, 40, 20, 41)];
  const auto = mkProject({ id: 'p1', name: '日報から作った案件', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-13', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-13' } });
  const input = (project: Project, period?: { startDate: string; endDate: string }) => ({ project, projects: [project], venues, rows, now: NOW, period });
  it('日報から決めた会期のままの案件は、連続する日へ、自動で会期を伸ばして照合する', () => {
    expect(hasAutoPeriod(auto)).toBe(true);
    const r = planProjectSync(input(auto));
    expect(r.change).toEqual({ from: { startDate: '2026-11-13', endDate: '2026-11-13' }, to: { startDate: '2026-11-13', endDate: '2026-11-14' }, notHeld: [] });
    expect(r.plan.ok && [r.plan.sync.startDate, r.plan.sync.endDate, dayList(r.plan.sync)]).toEqual(['2026-11-13', '2026-11-14', [['2026-11-13', 30, 1], ['2026-11-14', 99, 1]]]);
    // 回答の無い日（11/15）を挟んだ先の 11/16 へは、自動では伸ばさない（「会期のすぐ外の回答」として示す）
    expect(r.plan.ok && r.plan.sync.outside).toEqual([{ date: '2026-11-16', rows: 1, count: 40 }]);
  });
  it('会期を手で変えた案件（控えと違う）・手で作った案件は、自動では伸ばさない', () => {
    const edited = { ...auto, endDate: '2026-11-13', reportPeriod: { startDate: '2026-11-12', endDate: '2026-11-13' } };
    const manual = { ...auto, reportPeriod: undefined };
    for (const p of [edited, manual]) {
      expect(hasAutoPeriod(p)).toBe(false);
      const r = planProjectSync(input(p));
      expect(r.change).toBeNull();
      expect(r.plan.ok && dayList(r.plan.sync)).toEqual([['2026-11-13', 30, 1]]);
    }
  });
  it('利用者が選んだ会期へ広げる。新しく入る日のうち、回答の無い日は「開催していない日」として返す', () => {
    const manual = { ...auto, reportPeriod: undefined };
    const r = planProjectSync(input(manual, { startDate: '2026-11-13', endDate: '2026-11-16' }));
    expect(r.change).toEqual({ from: { startDate: '2026-11-13', endDate: '2026-11-13' }, to: { startDate: '2026-11-13', endDate: '2026-11-16' }, notHeld: ['2026-11-15'] });
    expect(r.plan.ok && dayList(r.plan.sync)).toEqual([['2026-11-13', 30, 1], ['2026-11-14', 99, 1], ['2026-11-16', 40, 1]]);
  });
  it('指定は「ここまで広げる」として使う（狭めない）。同じ会期・狭い会期・逆転した指定・日付でない指定では、会期は変えない', () => {
    const two = { ...auto, endDate: '2026-11-14', reportPeriod: undefined };
    for (const period of [{ startDate: '2026-11-13', endDate: '2026-11-14' }, { startDate: '2026-11-14', endDate: '2026-11-14' }, { startDate: '2026-11-16', endDate: '2026-11-13' }, { startDate: 'x', endDate: '2026-11-16' }]) {
      expect(planProjectSync(input(two, period)).change, JSON.stringify(period)).toBeNull();
    }
    // いまの会期を含まない範囲を指定しても、いまの会期は残る（11/13 を落とさない）
    expect(planProjectSync(input(two, { startDate: '2026-11-14', endDate: '2026-11-16' })).change?.to).toEqual({ startDate: '2026-11-13', endDate: '2026-11-16' });
  });
  it('利用者が選んでも、ほかの進行中の案件（同じ会場）の会期へは、広げない（その手前で止まる。その先の日も取り込まない）', () => {
    const manual = { ...auto, reportPeriod: undefined };
    const next = mkProject({ id: 'p2', name: '次の開催', venueId: 'v-center', startDate: '2026-11-16', endDate: '2026-11-16' });
    const far = [...rows, full('2026/11/19', CENTER, 5)];
    const r = planProjectSync({ project: manual, projects: [manual, next], venues, rows: far, now: NOW, period: { startDate: '2026-11-13', endDate: '2026-11-19' } });
    expect(r.change).toEqual({ from: { startDate: '2026-11-13', endDate: '2026-11-13' }, to: { startDate: '2026-11-13', endDate: '2026-11-15' }, notHeld: ['2026-11-15'] });
    expect(r.plan.ok && [dayList(r.plan.sync), r.plan.sync.held]).toEqual([[['2026-11-13', 30, 1], ['2026-11-14', 99, 1]], []]);
    // 中止の案件の会期は、妨げにならない
    const cancelled = planProjectSync({ project: manual, projects: [manual, { ...next, status: '中止' }], venues, rows: far, now: NOW, period: { startDate: '2026-11-13', endDate: '2026-11-19' } });
    expect(cancelled.change?.to).toEqual({ startDate: '2026-11-13', endDate: '2026-11-19' });
  });
  it('広げた先に、読み取れない回答があるときは、同期の全体を止める（会期の変更も、行わない側が判断できるように、計画は失敗で返る）', () => {
    const bad = [...rows.slice(0, 1), full('2026/11/14', CENTER, '99個')];
    const r = planProjectSync({ project: auto, projects: [auto], venues, rows: bad, now: NOW });
    expect(r.plan.ok).toBe(false);
  });
});

describe('日報から決めた会期の案件は、回答のある日に会期を合わせる（fittedPeriod）', () => {
  const auto = (startDate: string, endDate: string, id = 'p1') =>
    mkProject({ id, name: '日報から作った案件', venueId: 'v-center', startDate, endDate, reportPeriod: { startDate, endDate } });
  const days = (...ds: string[]) => ds.map((d) => full(d, CENTER, 1));
  const fit = (p: Project, rows: RawReportRow[], projects: Project[] = [p]) => fittedPeriod(p, rows, { projects, venues });
  it('端の日に回答があれば、連続する日へ伸ばす。回答の無い日を挟んだ先へは、伸ばさない', () => {
    const p = auto('2026-11-13', '2026-11-14');
    expect(fit(p, days('2026/11/12', '2026/11/13', '2026/11/14', '2026/11/15', '2026/11/16', '2026/11/18'))).toEqual({ startDate: '2026-11-12', endDate: '2026-11-16' });
    expect(fit(p, days('2026/11/13', '2026/11/14'))).toBeNull();
  });
  it('端の日の回答が無くなっていたら、その分だけ縮める。その先に回答があっても、端の無くなった日を挟んでは伸ばさない（離れた開催を、勝手に 1 つにしない）', () => {
    const p = auto('2026-11-13', '2026-11-15');
    // 11/15 の回答の開催日が、11/16 に直された
    expect(fit(p, days('2026/11/13', '2026/11/14', '2026/11/16'))).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
    // 最初の日の回答が消された
    expect(fit(p, days('2026/11/14', '2026/11/15'))).toEqual({ startDate: '2026-11-14', endDate: '2026-11-15' });
    // 縮めた側と反対の端は、連続していれば伸びる
    expect(fit(p, days('2026/11/14', '2026/11/15', '2026/11/16'))).toEqual({ startDate: '2026-11-14', endDate: '2026-11-16' });
  });
  it('会期の途中の日の回答が無くなっても、会期は分けない（両端に回答がある間は、そのまま）', () => {
    expect(fit(auto('2026-11-13', '2026-11-15'), days('2026/11/13', '2026/11/15'))).toBeNull();
  });
  it('会期の中に、回答のある日が 1 日も無いときは、変えない（基準にする日が無い）', () => {
    expect(fit(auto('2026-11-13', '2026-11-15'), days('2026/11/20'))).toBeNull();
    expect(fit(auto('2026-11-13', '2026-11-15'), [])).toBeNull();
  });
  it('ほかの進行中の案件（同じ会場）の会期に当たったら、そこで止まる', () => {
    const p = auto('2026-11-13', '2026-11-13');
    const manual = mkProject({ id: 'p2', name: '手で作った案件', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-17' });
    expect(fit(p, days('2026/11/13', '2026/11/14', '2026/11/15', '2026/11/16'), [p, manual])).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
  });
  it('日報から決めた会期の 2 つの案件に挟まれた日は、どちらも取らない（どちらの続きか、日報だけでは決まらない）', () => {
    const a = auto('2026-11-13', '2026-11-13', 'a');
    const b = auto('2026-11-15', '2026-11-15', 'b');
    const rows = days('2026/11/13', '2026/11/14', '2026/11/15');
    expect([fit(a, rows, [a, b]), fit(b, rows, [a, b])]).toEqual([null, null]);
    // 相手が、会期を手で決めた案件なら、こちらが伸びる（相手は、自分では伸びない）
    const manual = { ...b, reportPeriod: undefined };
    expect(fit(a, rows, [a, manual])).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
    // 1 日あいていれば、隣り合っていない（伸びる）
    const far = auto('2026-11-16', '2026-11-16', 'b');
    expect(fit(a, days('2026/11/13', '2026/11/14', '2026/11/16'), [a, far])).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
  });
  it('中止の案件・会場や会期が決まっていない案件は、変えない', () => {
    const p = auto('2026-11-13', '2026-11-13');
    const rows = days('2026/11/13', '2026/11/14');
    expect([fit({ ...p, status: '中止' }, rows), fit({ ...p, venueId: '' }, rows), fit({ ...p, endDate: '' }, rows)]).toEqual([null, null, null]);
  });
  it('端の日に、会場名を読み取れない回答があるときは、縮めない（この案件の回答かもしれない。これまでどおり、同期を止めて、回答を示す）', () => {
    const p = auto('2026-11-13', '2026-11-15');
    const rows = [full('2026/11/13', CENTER, 30), full('2026/11/14', CENTER, 99), { ...full('2026/11/15', 'その他', 40), venueOther: '' }];
    expect(fit(p, rows)).toBeNull();
    const r = planProjectSync({ project: p, projects: [p], venues, rows, now: NOW });
    expect(r.change).toBeNull();
    expect(r.plan).toMatchObject({ ok: false, issues: [{ row: 4, date: '2026-11-15', items: [{ field: '会場（その他の場合）' }] }] });
    // 会場名が空欄の回答・エラーの値の回答でも、同じ
    expect(fit(p, [...rows.slice(0, 2), full('2026/11/15', '', 40)])).toBeNull();
    expect(fit(p, [...rows.slice(0, 2), full('2026/11/15', '#N/A', 40)])).toBeNull();
  });
  it('端の日に、未登録の会場名の回答があるときも、縮めない（この案件の会場の、別の書き方かもしれない。会期内の「会場名が一致しない回答」として示す）', () => {
    const p = auto('2026-11-13', '2026-11-15');
    const rows = [full('2026/11/13', CENTER, 30), full('2026/11/14', CENTER, 99), full('2026/11/15', '北街モール中央', 40)];
    expect(fit(p, rows)).toBeNull();
    const r = planProjectSync({ project: p, projects: [p], venues, rows, now: NOW });
    expect(r.plan.ok && [r.change, unmatchedGaps(r.plan.sync, venues).map((u) => [u.venue, u.dates])]).toEqual([null, [['北街モール中央', ['2026-11-15']]]]);
    // 登録済みの、別の会場の回答だけなら、この案件の回答ではないので、縮める
    expect(fit(p, [...rows.slice(0, 2), full('2026/11/15', EAST, 40)])).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
    // テスト回答は、数えない
    expect(fit(p, [...rows.slice(0, 2), { ...full('2026/11/15', '北街モール中央', 40), event: '【テスト】' }])).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
  });
  it('会期の中に、この会場の回答が 1 日も無く、読み取れない回答・未登録の会場名の回答だけがあるときは、変えない', () => {
    const p = auto('2026-11-13', '2026-11-15');
    expect(fit(p, [full('2026/11/14', '北街モール中央', 40), full('2026/11/15', '', 1)])).toBeNull();
  });
  it('同期の計画に入る: 縮めた会期で照合し、会期の外になった日は実績に入らない。その先の回答は「会期のすぐ外の回答」として示す', () => {
    const p = auto('2026-11-13', '2026-11-15');
    const r = planProjectSync({ project: p, projects: [p], venues, rows: [full('2026/11/13', CENTER, 30), full('2026/11/14', CENTER, 99), full('2026/11/16', CENTER, 40)], now: NOW });
    expect(r.change).toEqual({ from: { startDate: '2026-11-13', endDate: '2026-11-15' }, to: { startDate: '2026-11-13', endDate: '2026-11-14' }, notHeld: [] });
    expect(r.plan.ok && [dayList(r.plan.sync), r.plan.sync.outside]).toEqual([[['2026-11-13', 30, 1], ['2026-11-14', 99, 1]], [{ date: '2026-11-16', rows: 1, count: 40 }]]);
  });
});

describe('利用者が選んで会期を広げるときの範囲（clampedPeriod・widenTarget）', () => {
  const p = mkProject({ id: 'p1', name: '手で作った案件', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-14' });
  const other = (startDate: string, endDate: string, patch: Partial<Project> = {}) => mkProject({ id: 'p2', name: 'ほかの案件', venueId: 'v-center', startDate, endDate, ...patch });
  it('ほかの案件が無ければ、選んだ範囲まで（いまの会期より狭い側は、いまの会期のまま）', () => {
    const ctx = { projects: [p], venues };
    expect(clampedPeriod(p, { startDate: '2026-11-10', endDate: '2026-11-18' }, ctx)).toEqual({ startDate: '2026-11-10', endDate: '2026-11-18' });
    expect(clampedPeriod(p, { startDate: '2026-11-14', endDate: '2026-11-16' }, ctx)).toEqual({ startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(clampedPeriod(p, { startDate: '2026-11-13', endDate: '2026-11-14' }, ctx)).toBeNull();
    expect(clampedPeriod(p, { startDate: 'x', endDate: '2026-11-18' }, ctx)).toBeNull();
    expect(clampedPeriod({ ...p, status: '中止' }, { startDate: '2026-11-10', endDate: '2026-11-18' }, ctx)).toBeNull();
  });
  it('ほかの進行中の案件（同じ会場）の会期の手前で止まる。別の会場の案件・中止の案件は、妨げにならない', () => {
    const wanted = { startDate: '2026-11-10', endDate: '2026-11-20' };
    expect(clampedPeriod(p, wanted, { projects: [p, other('2026-11-17', '2026-11-18')], venues })).toEqual({ startDate: '2026-11-10', endDate: '2026-11-16' });
    expect(clampedPeriod(p, wanted, { projects: [p, other('2026-11-11', '2026-11-11')], venues })).toEqual({ startDate: '2026-11-12', endDate: '2026-11-20' });
    expect(clampedPeriod(p, wanted, { projects: [p, other('2026-11-15', '2026-11-15'), other('2026-11-12', '2026-11-12')], venues })).toBeNull();
    expect(clampedPeriod(p, wanted, { projects: [p, other('2026-11-17', '2026-11-18', { venueId: 'v-east' })], venues })).toEqual(wanted);
    expect(clampedPeriod(p, wanted, { projects: [p, other('2026-11-17', '2026-11-18', { status: '中止' })], venues })).toEqual(wanted);
  });
  it('取り込みたい日のうち、1 日も届かなければ、広げない（ほかの案件の向こう側の日）', () => {
    const ctx = { projects: [p, other('2026-11-16', '2026-11-16')], venues };
    expect(widenTarget(p, ['2026-11-19'], ctx)).toBeNull();
    expect(widenTarget(p, ['2026-11-15', '2026-11-19'], ctx)).toEqual({ startDate: '2026-11-13', endDate: '2026-11-15' });
    expect(widenTarget(p, [], ctx)).toBeNull();
  });
  it('保存してある「会期のすぐ外の回答」のうち、ほかの案件の向こう側の日は、出さない（広げる先として勧めない）', () => {
    const one = mkProject({ id: 'p1', name: '1 日目の案件', venueId: 'v-center', startDate: '2026-11-13', endDate: '2026-11-13' });
    const rows = [full('2026/11/13', CENTER, 62), full('2026/11/15', CENTER, 55), full('2026/11/17', CENTER, 9)];
    const synced = { ...one, reportSync: plan(rows, { project: one }) };
    expect(openOutside(synced, { projects: [synced], venues }).map((o) => o.date)).toEqual(['2026-11-15', '2026-11-17']);
    // あとから、11/15 を会期に含む案件ができた: 11/15 はその案件のもの。11/17 は、その案件を越えないと届かない
    const next = mkProject({ id: 'p2', name: '別の開催', venueId: 'v-center', startDate: '2026-11-15', endDate: '2026-11-15' });
    expect(openOutside(synced, { projects: [synced, next], venues })).toEqual([]);
    // 11/17 を会期に含む案件ができた: 11/15 は、まだ届く
    expect(openOutside(synced, { projects: [synced, { ...next, startDate: '2026-11-17', endDate: '2026-11-17' }], venues }).map((o) => o.date)).toEqual(['2026-11-15']);
  });
});

describe('日の通し番号', () => {
  it('日付どうしの差と、前後の日（月末・年末・うるう年をまたぐ）', async () => {
    const { dayNumber, dateOfDay } = await import('./util');
    expect(dayNumber('2026-11-14') - dayNumber('2026-11-13')).toBe(1);
    expect(dayNumber('2027-01-01') - dayNumber('2026-12-31')).toBe(1);
    expect(dayNumber('2028-03-01') - dayNumber('2028-02-28')).toBe(2);
    expect(dateOfDay(dayNumber('2026-12-31') + 1)).toBe('2027-01-01');
    expect(dateOfDay(dayNumber('2026-03-01') - 1)).toBe('2026-02-28');
    for (const bad of ['', '2026-02-30', '2026/11/13', '2026-13-01', 'x']) expect(Number.isNaN(dayNumber(bad)), bad).toBe(true);
  });
});
