// 入力チェック（警告）の境界確認。設計書（docs/02_新アプリ設計書.md 3.5）の一覧に沿う。
//   - 原則「入力は拒否せず、警告して選ばせる」：値を書き換えない・試算を止めない
//   - 警告が出るべき条件の境界（ちょうど／1つ超え）で発火すること
//   - 正常な入力では 1 件も発火しないこと
import { describe, expect, it } from 'vitest';
import { AppData, Assignment, PlacedItem, Project, Warning } from '../types';
import { estimate } from './calc';
import { addComposite } from './layout';
import { defaultComposites } from './seed';
import { bottle, mkAssign, mkContent, mkData, mkProject, staffA, withParts } from './testkit';
import { checkNewAssignment, projectWarnings } from './warnings';

const data = mkData();
const ws = (p: Project, d: AppData = data): Warning[] => projectWarnings(p, { ...d, projects: d.projects.length ? d.projects : [p] });
const msgs = (p: Project, d: AppData = data, sev: Warning['severity'] = 'warn') => ws(p, d).filter((w) => w.severity === sev).map((w) => w.message);
const at = (p: Project, target: string, d: AppData = data) => ws(p, d).filter((w) => w.target === target);
/** 配置 1 件だけの案件（その日だけの 1 日案件）で、その配置に付く警告 */
const assignMsgs = (a: Partial<Assignment>, d: AppData = data) =>
  msgs(mkProject({ startDate: '2026-12-05', endDate: '2026-12-05', assignments: [mkAssign({ id: 'a1', ...a })] }), d);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

describe('正常な入力では発火しない', () => {
  it('基準の案件は警告も参考も 0 件', () => {
    expect(ws(mkProject())).toEqual([]);
  });
  it('よくある正常パターン（参加無料・固定売上なし・交通費 0・その他費用なし・1日だけ・中止）でも 0 件', () => {
    const free = mkData({ contents: [{ ...bottle, price: 0 }], staff: [{ ...staffA, transportPerDay: 0 }] });
    expect(ws(mkProject(), free)).toEqual([]);
    expect(ws(mkProject({ fixedRevenue: 0, otherCosts: [] }))).toEqual([]);
    expect(ws(mkProject({ endDate: '2026-12-05', assignments: [mkAssign()] }))).toEqual([]);
    expect(ws(mkProject({ status: '中止' }))).toEqual([]);
    expect(ws(mkProject({ status: '確定' }))).toEqual([]);
  });
  it('赤字の試算そのものは入力ミスではないので警告しない（一覧・ヘッダーで赤字表示するだけ）', () => {
    const p = mkProject({ otherCosts: [{ id: 'o', name: '高い費用', amount: 9999999 }] });
    expect(estimate(p, data).profit).toBeLessThan(0);
    expect(ws(p)).toEqual([]);
  });
});

describe('原則：入力は拒否せず、警告して選ばせる', () => {
  const bad = mkProject({
    name: '', venueId: '', startDate: '2026-12-06', endDate: '2026-12-05',
    contents: [mkContent({ contentId: '', plannedCount: -5 })],
    assignments: [mkAssign({ staffId: '', startTime: '18:00', endTime: '10:00', breakMinutes: 999 })],
  });

  it('警告の計算は入力値を書き換えない', () => {
    const p = deepFreeze(structuredClone(bad));
    const d = deepFreeze({ ...mkData(), projects: [p] });
    expect(() => projectWarnings(p, d)).not.toThrow();
    expect(() => checkNewAssignment(p.assignments[0], p, d)).not.toThrow();
    expect(p).toEqual(bad);
  });
  it('おかしな入力でも試算は止まらず、入力した値のまま計算される', () => {
    const e = estimate(bad, data);
    expect(e.contentLines[0].count).toBe(-5);            // マイナスのまま（0 に直したりしない）
    expect(e.days).toBe(0);
    expect(Number.isFinite(e.profit)).toBe(true);
  });
  it('配置前のチェックは「メッセージを返すだけ」。配置するかどうかは呼び出し側（利用者）が決める', () => {
    const p = mkProject();
    const dup = mkAssign({ id: 'new', date: '2026-12-05' });
    const out = checkNewAssignment(dup, p, { ...data, projects: [p] });
    expect(out).toHaveLength(1);
    expect(out.every((m) => typeof m === 'string')).toBe(true);
    expect(p.assignments).toHaveLength(2);               // 何も追加・削除されていない
  });
  it('警告の対象（target）は画面のセルと対応する形式になっている', () => {
    const parts = withParts({ 'pt-chair': { stockQty: 1 } });
    const items: PlacedItem[] = [
      { id: 'i1', partTypeId: 'pt-chair', x: 0, y: 0, rot: 0 },
      { id: 'i2', partTypeId: 'pt-chair', x: 10, y: 10, rot: 0 },
      { id: 'i3', partTypeId: 'gone', x: 500, y: 500, rot: 0 },
    ];
    const p = { ...bad, layout: { ...bad.layout, env: [], items } };
    const targets = ws(p, mkData({ partTypes: parts })).map((w) => w.target);
    const ok = /^(project:(name|venueId|endDate|contents)|pc:[^:]+:(contentId|plannedCount)|assign:[^:]+:(staffId|date|endTime|breakMinutes|rate)|day:\d{4}-\d{2}-\d{2}|part:.+|item:.+|layout:(overlap|env))$/;
    expect(targets.length).toBeGreaterThan(8);
    expect(targets.filter((t) => !ok.test(t))).toEqual([]);
  });
});

describe('基本情報', () => {
  it('案件名：空・空白だけは警告、1文字あれば出ない', () => {
    expect(at(mkProject({ name: '' }), 'project:name')).toHaveLength(1);
    expect(at(mkProject({ name: '　 ' }), 'project:name')).toHaveLength(1);
    expect(at(mkProject({ name: 'a' }), 'project:name')).toHaveLength(0);
  });
  it('会場：未選択は警告', () => {
    expect(msgs(mkProject({ venueId: '' }))).toEqual(['会場が未選択です。']);
  });
  it('会場：マスタから削除された会場を指したままの案件も警告（画面では「会場未選択」と表示されるため）', () => {
    const out = at(mkProject({ venueId: 'deleted-venue' }), 'project:venueId');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('warn');
    expect(out[0].message).toContain('削除');
  });
  it('期間：どちらか未入力は「未入力」1 件だけ（逆転の警告は重ねない）', () => {
    for (const range of [{ startDate: '', endDate: '2026-12-06' }, { startDate: '2026-12-05', endDate: '' }, { startDate: '', endDate: '' }]) {
      const out = at(mkProject({ ...range, assignments: [] }), 'project:endDate');
      expect(out.map((w) => w.message)).toEqual(['期間（開始日・終了日）が未入力です。']);
    }
  });
  it('期間：終了日が開始日の前日なら「逆転」、同じ日なら出ない（1日だけの案件）', () => {
    expect(at(mkProject({ startDate: '2026-12-06', endDate: '2026-12-05', assignments: [] }), 'project:endDate').map((w) => w.message))
      .toEqual(['終了日が開始日より前になっています。']);
    expect(at(mkProject({ startDate: '2026-12-05', endDate: '2026-12-05', assignments: [mkAssign()] }), 'project:endDate')).toHaveLength(0);
  });
  it('期間：366 日までは出ない。367 日以上は「試算が 366 日で打ち切られる」ことを警告', () => {
    const p366 = mkProject({ startDate: '2026-01-01', endDate: '2027-01-01', assignments: [] });
    const p367 = mkProject({ startDate: '2026-01-01', endDate: '2027-01-02', assignments: [] });
    expect(estimate(p366, data).days).toBe(366);
    expect(at(p366, 'project:endDate')).toHaveLength(0);
    expect(estimate(p367, data).days).toBe(366);          // 入力は拒否しないが、計算は 366 日まで
    expect(at(p367, 'project:endDate').map((w) => w.message).join()).toContain('366');
    // 年の打ち間違い（2026 → 2027）で起きる
    expect(at(mkProject({ startDate: '2026-11-13', endDate: '2027-11-17', assignments: [] }), 'project:endDate')).toHaveLength(1);
  });
  it('実施コンテンツが 0 件のときは「参考」どまり（警告にはしない）', () => {
    const out = ws(mkProject({ contents: [] }));
    expect(out).toEqual([{ severity: 'info', target: 'project:contents', message: '実施コンテンツが未登録です。' }]);
  });
});

describe('コンテンツ', () => {
  const withC = (c: Parameters<typeof mkContent>[0], d: AppData = data) => ws(mkProject({ contents: [mkContent(c)] }), d);

  it('未選択・マスタから削除済みは警告', () => {
    expect(withC({ contentId: '' }).map((w) => w.message)).toEqual(['コンテンツが未選択です。']);
    expect(withC({ contentId: 'deleted' }).map((w) => w.target)).toEqual(['pc:pc1:contentId']);
  });
  it('予定個数：0 は警告、1 は出ない、-1 は「マイナス」1 件だけ', () => {
    expect(withC({ plannedCount: 0 }).map((w) => w.message)).toEqual(['予定個数が 0 です。材料費・売上が 0 で試算されます。']);
    expect(withC({ plannedCount: 1 })).toEqual([]);
    expect(withC({ plannedCount: -1 }).map((w) => w.message)).toEqual(['予定個数がマイナスです。']);
  });
  it('材料が未登録のコンテンツは「参考」', () => {
    const out = withC({}, mkData({ contents: [{ ...bottle, materials: [] }] }));
    expect(out.map((w) => w.severity)).toEqual(['info']);
    expect(out[0].message).toContain('材料が登録されていません');
  });
  it('参加費 0（無料）・予備率 0 は正常な入力として扱う', () => {
    expect(withC({ priceOverride: 0, sparePct: 0 })).toEqual([]);
  });
});

describe('スタッフ配置', () => {
  it('スタッフ未選択・マスタから削除済みは警告', () => {
    expect(assignMsgs({ staffId: '' })).toEqual(['スタッフが未選択、またはマスタから削除されています。']);
    expect(assignMsgs({ staffId: 'deleted' })).toEqual(['スタッフが未選択、またはマスタから削除されています。']);
  });
  it('日付：開始日・終了日ちょうどは期間内、前日・翌日は期間外', () => {
    const p = (date: string) => at(mkProject({ assignments: [mkAssign({ id: 'a1', date }), mkAssign({ id: 'k1', date: '2026-12-05' }), mkAssign({ id: 'k2', staffId: 's2', date: '2026-12-06' })] }), 'assign:a1:date');
    expect(p('2026-12-04')).toHaveLength(1);
    expect(p('2026-12-07')).toHaveLength(1);
    // 期間内（s1 は 12/5 に k1 と重複するが、ここでは日付の警告だけを見る）
    expect(p('2026-12-05')).toHaveLength(0);
    expect(p('2026-12-06')).toHaveLength(0);
  });
  it('日付：案件の期間が未入力のうちは「期間外」を出さない（判定できないため）', () => {
    expect(at(mkProject({ startDate: '', endDate: '', assignments: [mkAssign()] }), 'assign:a1:date')).toHaveLength(0);
  });
  it('時刻：未入力は警告。終了＝開始は警告、終了が 1 分でも後なら出ない', () => {
    expect(assignMsgs({ startTime: '' }).join()).toContain('開始・終了時刻が未入力');
    expect(assignMsgs({ endTime: '' }).join()).toContain('開始・終了時刻が未入力');
    expect(assignMsgs({ startTime: '10:00', endTime: '10:00', breakMinutes: 0 }).join()).toContain('終了時刻が開始時刻以前');
    expect(assignMsgs({ startTime: '10:00', endTime: '09:59', breakMinutes: 0 }).join()).toContain('終了時刻が開始時刻以前');
    expect(assignMsgs({ startTime: '10:00', endTime: '10:01', breakMinutes: 0 })).toEqual([]);
  });
  it('時刻の警告文は試算と食い違わない（賃金は 0 円だが交通費は計上される）', () => {
    const p = mkProject({ startDate: '2026-12-05', endDate: '2026-12-05', assignments: [mkAssign({ startTime: '', endTime: '' })] });
    expect(estimate(p, data).laborCost).toBe(800);         // 交通費 800 円は入る
    const m = msgs(p).join();
    expect(m).not.toContain('人件費 0 円');
    expect(m).toContain('賃金 0 円');
  });
  it('休憩：勤務時間ちょうど以上は警告、1 分短ければ出ない', () => {
    expect(assignMsgs({ startTime: '10:00', endTime: '11:00', breakMinutes: 60 })).toEqual(['A 12/5(土): 休憩が勤務時間以上です。']);
    expect(assignMsgs({ startTime: '10:00', endTime: '11:00', breakMinutes: 61 })).toEqual(['A 12/5(土): 休憩が勤務時間以上です。']);
    expect(assignMsgs({ startTime: '10:00', endTime: '11:00', breakMinutes: 59 })).toEqual([]);
  });
  it('休憩：マイナスは警告（実働時間が水増しされるため）', () => {
    const out = assignMsgs({ startTime: '10:00', endTime: '12:00', breakMinutes: -30 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('休憩がマイナス');
  });
  it('休憩（労基法34条）：実働 6 時間ちょうどは不要、6 時間を 1 分でも超えたら 45 分必要', () => {
    const w45 = 'A 12/5(土): 実働6時間超ですが休憩が45分未満です。';
    expect(assignMsgs({ startTime: '10:00', endTime: '16:00', breakMinutes: 0 })).toEqual([]);      // 実働 6:00
    expect(assignMsgs({ startTime: '10:00', endTime: '16:01', breakMinutes: 0 })).toEqual([w45]);   // 実働 6:01
    expect(assignMsgs({ startTime: '10:00', endTime: '16:46', breakMinutes: 44 })).toEqual([w45]);  // 実働 6:02・休憩 44
    expect(assignMsgs({ startTime: '10:00', endTime: '16:46', breakMinutes: 45 })).toEqual([]);     // 実働 6:01・休憩 45
    expect(assignMsgs({ startTime: '10:00', endTime: '18:00', breakMinutes: 60 })).toEqual([]);     // 既定の 10-18・休憩 60
  });
  it('休憩（労基法34条）：実働 8 時間ちょうどは 45 分で足りる、8 時間を超えたら 60 分必要', () => {
    const w60 = 'A 12/5(土): 実働8時間超ですが休憩が60分未満です。';
    expect(assignMsgs({ startTime: '10:00', endTime: '18:45', breakMinutes: 45 })).toEqual([]);     // 実働 8:00・休憩 45
    expect(assignMsgs({ startTime: '10:00', endTime: '18:46', breakMinutes: 45 })).toEqual([w60]);  // 実働 8:01・休憩 45
    expect(assignMsgs({ startTime: '10:00', endTime: '19:00', breakMinutes: 59 })).toEqual([w60]);  // 実働 8:01・休憩 59
    expect(assignMsgs({ startTime: '10:00', endTime: '19:01', breakMinutes: 60 })).toEqual([]);     // 実働 8:01・休憩 60
    expect(assignMsgs({ startTime: '09:00', endTime: '21:00', breakMinutes: 0 })).toEqual([w60]);   // 8時間超のときは 60 分の警告 1 件だけ
  });
  it('時給：マスタ 0 円（上書きなし）・上書き 0 円は警告。上書きで 1 円以上になれば出ない', () => {
    const zero = mkData({ staff: [{ ...staffA, hourlyRate: 0 }] });
    expect(at(mkProject({ assignments: [mkAssign()], endDate: '2026-12-05' }), 'assign:a1:rate', zero)).toHaveLength(1);
    expect(at(mkProject({ assignments: [mkAssign({ rateOverride: 1200 })], endDate: '2026-12-05' }), 'assign:a1:rate', zero)).toHaveLength(0);
    expect(at(mkProject({ assignments: [mkAssign({ rateOverride: 0 })], endDate: '2026-12-05' }), 'assign:a1:rate')).toHaveLength(1);
    expect(at(mkProject({ assignments: [mkAssign({ rateOverride: 1 })], endDate: '2026-12-05' }), 'assign:a1:rate')).toHaveLength(0);
    expect(at(mkProject({ assignments: [mkAssign({ transportOverride: 0 })], endDate: '2026-12-05' }), 'assign:a1:rate')).toHaveLength(0); // 交通費 0 は正常
  });

  describe('同じ案件の中での時間重複', () => {
    const two = (b: Partial<Assignment>) => mkProject({
      startDate: '2026-12-05', endDate: '2026-12-05',
      assignments: [mkAssign({ id: 'a1', startTime: '10:00', endTime: '12:00', breakMinutes: 0 }), mkAssign({ id: 'a2', breakMinutes: 0, ...b })],
    });
    it('1 分でも重なれば両方の行に警告', () => {
      const out = ws(two({ startTime: '11:59', endTime: '14:00' }));
      expect(out.map((w) => w.target)).toEqual(['assign:a1:staffId', 'assign:a2:staffId']);
      expect(out[0].message).toContain('同じ時間帯に重複');
    });
    it('前の終了＝次の開始（10-12 と 12-14）は重複ではない', () => {
      expect(ws(two({ startTime: '12:00', endTime: '14:00' }))).toEqual([]);
    });
    it('別の人・別の日なら出ない', () => {
      expect(ws(two({ staffId: 's2', startTime: '10:00', endTime: '12:00' }))).toEqual([]);
      const otherDay = mkProject({ assignments: [mkAssign({ id: 'a1' }), mkAssign({ id: 'a2', date: '2026-12-06' })] });
      expect(ws(otherDay)).toEqual([]);
    });
  });

  describe('別の案件との時間重複（掛け持ち）', () => {
    const mine = mkProject({ id: 'p1', startDate: '2026-12-05', endDate: '2026-12-05', assignments: [mkAssign({ id: 'a1', startTime: '10:00', endTime: '14:00', breakMinutes: 0 })] });
    const other = (patch: Partial<Project>, a: Partial<Assignment> = {}) => mkProject({
      id: 'p2', name: '別案件', startDate: '2026-12-05', endDate: '2026-12-05',
      assignments: [mkAssign({ id: 'x1', startTime: '13:00', endTime: '18:00', breakMinutes: 0, ...a })], ...patch,
    });
    const run = (o: Project, me: Project = mine) => projectWarnings(me, mkData({ projects: [me, o] })).map((w) => w.message);

    it('重なっていれば、相手の案件名つきで警告', () => {
      expect(run(other({}))).toEqual(['A 12/5(土): 別案件「別案件」と時間帯が重なっています。']);
    });
    it('時間が接しているだけ・別の日・別の人なら出ない', () => {
      expect(run(other({}, { startTime: '14:00' }))).toEqual([]);
      expect(run(other({}, { date: '2026-12-06' }))).toEqual([]);
      expect(run(other({}, { staffId: 's2' }))).toEqual([]);
    });
    it('相手が「中止」の案件なら出ない', () => {
      expect(run(other({ status: '中止' }))).toEqual([]);
    });
    it('自分が「中止」の案件なら出ない（中止案件に残っている配置で警告を増やさない）', () => {
      expect(run(other({}), { ...mine, status: '中止' })).toEqual([]);
    });
    it('配置前チェック：同じ案件の重複と別案件の掛け持ちをそれぞれ知らせる。重ならなければ空', () => {
      const d = mkData({ projects: [mine, other({})] });
      const a = mkAssign({ id: 'new', startTime: '12:00', endTime: '15:00' });
      expect(checkNewAssignment(a, mine, d)).toEqual([
        'A は同じ日・同じ時間帯にすでに配置されています。',
        'A は 12/5(土) に別案件「別案件」にも配置されています。',
      ]);
      expect(checkNewAssignment(mkAssign({ id: 'new', staffId: 's2' }), mine, d)).toEqual([]);
      expect(checkNewAssignment(mkAssign({ id: 'new', date: '2026-12-06' }), mine, d)).toEqual([]);
      // 相手が中止なら掛け持ちとはみなさない
      expect(checkNewAssignment(mkAssign({ id: 'new', startTime: '14:00', endTime: '18:00' }), mine, mkData({ projects: [mine, other({ status: '中止' })] }))).toEqual([]);
    });
  });

  it('誰も配置されていない日は「参考」。全日に 1 人以上いれば出ない', () => {
    const p = mkProject({ startDate: '2026-12-05', endDate: '2026-12-07', assignments: [mkAssign({ date: '2026-12-06' })] });
    expect(ws(p)).toEqual([
      { severity: 'info', target: 'day:2026-12-05', message: '12/5(土): スタッフが1人も配置されていません。' },
      { severity: 'info', target: 'day:2026-12-07', message: '12/7(月): スタッフが1人も配置されていません。' },
    ]);
  });
});

describe('レイアウト', () => {
  const item = (id: string, partTypeId: string, x: number, y: number, extra: Partial<PlacedItem> = {}): PlacedItem => ({ id, partTypeId, x, y, rot: 0, ...extra });
  const withItems = (items: PlacedItem[], patch: Partial<Project> = {}) => { const p = mkProject(patch); return { ...p, layout: { ...p.layout, items } }; };
  const chairs = (n: number) => Array.from({ length: n }, (_, i) => item(`c${i}`, 'pt-chair', i * 100, 0));

  it('保有数：ちょうどは出ない、1 個超えたら警告', () => {
    const d = mkData({ partTypes: withParts({ 'pt-chair': { stockQty: 3 } }) });
    expect(ws(withItems(chairs(3)), d)).toEqual([]);
    expect(ws(withItems(chairs(4)), d)).toEqual([
      { severity: 'warn', target: 'part:pt-chair', message: '椅子: 配置 4 個が保有数 3 個を超えています（追加手配が必要）。' },
    ]);
  });
  it('保有数 0 は「管理しない」。何個置いても出ない', () => {
    expect(ws(withItems(chairs(50)))).toEqual([]);
  });
  it('保有数は L字（組み合わせ）で置いたテーブルも数える', () => {
    const parts = withParts({ 'pt-table': { stockQty: 5 } });
    const p = mkProject();
    const one = addComposite(p.layout, defaultComposites()[0], parts);
    const two = addComposite({ ...one, items: one.items.map((i) => ({ ...i, x: i.x + 600 })) }, defaultComposites()[0], parts);
    expect(at({ ...p, layout: one }, 'part:pt-table', mkData({ partTypes: parts }))).toHaveLength(0);   // 3 台
    expect(at({ ...p, layout: two }, 'part:pt-table', mkData({ partTypes: parts }))).toHaveLength(1);   // 6 台 > 5
  });
  it('マスタから削除された種別のパーツは 1 個ずつ警告', () => {
    const out = ws(withItems([item('i1', 'gone', 0, 0), item('i2', 'gone', 300, 0), item('i3', 'pt-chair', 600, 0)]));
    expect(out.map((w) => w.target)).toEqual(['item:i1', 'item:i2']);
  });
  it('重なり：5cm ちょうどまでは許容、5cm を超えたら警告（縦横とも超えたとき）', () => {
    // テーブルは 150×60。2台目の左上を動かして重なり量を作る
    const two = (x: number, y: number) => at(withItems([item('t1', 'pt-table', 0, 0), item('t2', 'pt-table', x, y)]), 'layout:overlap');
    expect(two(150, 0)).toHaveLength(0);     // 接しているだけ
    expect(two(145, 55)).toHaveLength(0);    // 横 5cm・縦 5cm
    expect(two(144, 55)).toHaveLength(0);    // 横 6cm・縦 5cm（縦が超えていない）
    expect(two(145, 54)).toHaveLength(0);    // 横 5cm・縦 6cm（横が超えていない）
    expect(two(144, 54)).toHaveLength(1);    // 横 6cm・縦 6cm
    expect(two(0, 0)).toHaveLength(1);       // 完全に重なっている
  });
  it('重なり：同じグループ内（L字の継ぎ目）は対象外。別グループとは判定する', () => {
    expect(at(withItems([item('t1', 'pt-table', 0, 0, { groupId: 'g' }), item('t2', 'pt-table', 20, 10, { groupId: 'g' })]), 'layout:overlap')).toHaveLength(0);
    expect(at(withItems([item('t1', 'pt-table', 0, 0, { groupId: 'g' }), item('t2', 'pt-table', 20, 10, { groupId: 'h' })]), 'layout:overlap')).toHaveLength(1);
  });
  it('重なり：回転したパーツは回転後の寸法で判定する', () => {
    // 90°回転したテーブルは 60×150。x=60 に置けば接するだけ
    const r = (x: number) => at(withItems([item('t1', 'pt-table', 0, 0, { rot: 90 }), item('t2', 'pt-table', x, 0)]), 'layout:overlap');
    expect(r(60)).toHaveLength(0);
    expect(r(50)).toHaveLength(1);
  });
  it('重なり：警告文で「どれとどれ」が分かる（番号のないパーツはパーツ名で示す）', () => {
    const out = at(withItems([item('t1', 'pt-table', 0, 0), item('c1', 'pt-chair', 10, 10)]), 'layout:overlap');
    expect(out[0].message).toBe('パーツが重なっています（1組: T1×椅子）。');
  });
  it('重なり：4 組以上あっても警告は 1 件にまとめ、先頭 3 組＋「ほか」', () => {
    const out = at(withItems([0, 1, 2, 3, 4].map((i) => item(`t${i}`, 'pt-table', i * 10, 0))), 'layout:overlap');
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('10組');
    expect(out[0].message).toContain('ほか');
  });
  it('周辺環境（雛形）が空なら「参考」', () => {
    const p = mkProject();
    expect(ws({ ...p, layout: { ...p.layout, env: [] } })).toEqual([{ severity: 'info', target: 'layout:env', message: '会場の雛形（周辺環境）が未設定です。' }]);
  });
});

describe('席数と予定個数の関係（作業ログ D-16：判断待ち）', () => {
  it('現状：席数（椅子）と予定個数を比べる警告は無い。椅子 0 脚・予定 300 個でも発火しない', () => {
    const p = mkProject({ contents: [mkContent({ plannedCount: 300 })] });
    expect(estimate(p, data).seats).toBe(0);
    expect(ws(p)).toEqual([]);
  });
  it.todo('席数 × 回転数 × 日数 を上限として予定個数と比べる（D-16 で方式が決まったら実装）');
});
