// 試算の独立検算。
// 設計書（docs/02_新アプリ設計書.md 4章）の式を、実装（calc.ts）とは別の経路で計算して突き合わせる。
//   - 手計算の値と比べるテスト（会場費・材料費・備品費・売上・人件費と、その組み合わせ）
//   - 厳密な分数（BigInt）で計算した値と比べるテスト（端数処理が 1 円もずれないこと）
import { describe, expect, it } from 'vitest';
import { AppData, Project } from '../types';
import { assignmentHours, countParts, estimate, laborLine, unitMaterialCost } from './calc';
import { addComposite, addPart, removeItems, removeLastPart } from './layout';
import { defaultComposites } from './seed';
import { bottle, mkAssign, mkContent, mkData, mkProject, rng, staffA, staffB, withParts } from './testkit';

// ── 厳密な分数での検算器（実装とは独立） ──────────────────────────
interface Q { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
const norm = (n: bigint, d: bigint): Q => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
/** 10進表記（"12.5" など）を厳密な分数にする */
function q(v: number | string): Q {
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`検算器は10進表記のみ対応: ${s}`);
  const [i, f = ''] = s.split('.');
  return norm(BigInt(i + f), 10n ** BigInt(f.length));
}
const add = (a: Q, b: Q) => norm(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => norm(a.n * b.n, a.d * b.d);
const sum = (xs: Q[]) => xs.reduce(add, q(0));
const floorDiv = (a: bigint, b: bigint) => a / b - (a % b !== 0n && (a < 0n) !== (b < 0n) ? 1n : 0n);
/** 四捨五入（ちょうど 0.5 は切り上げ。Math.round と同じ向き） */
const round = (a: Q): Q => q(String(floorDiv(2n * a.n + a.d, 2n * a.d)));
const toNum = (a: Q) => Number(a.n) / Number(a.d);

function minutesOf(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function daysOf(start: string, end: string): number {
  const p = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  const a = p(start), b = p(end);
  return a == null || b == null || b < a ? 0 : (b - a) / 86400000 + 1;
}

/** 設計書 4章の式をそのまま書き下したもの */
function oracle(p: Project, data: AppData) {
  const D = q(daysOf(p.startDate, p.endDate));
  const labor = sum(p.assignments.map((a) => {
    const s = data.staff.find((x) => x.id === a.staffId);
    const st = minutesOf(a.startTime), en = minutesOf(a.endTime);
    const minutes = st == null || en == null ? 0 : Math.max(0, en - st - a.breakMinutes);
    const rate = q(a.rateOverride ?? s?.hourlyRate ?? 0);
    const transport = q(a.transportOverride ?? s?.transportPerDay ?? 0);
    return add(round(mul(mul(q(minutes), rate), { n: 1n, d: 60n })), transport);   // round(実働時間 × 時給) ＋ 交通費
  }));
  const lines = p.contents.map((pc) => {
    const c = data.contents.find((x) => x.id === pc.contentId);
    const unit = sum((c?.materials ?? []).map((m) => mul(q(m.unitCost), q(m.qtyPerUnit))));   // Σ（材料単価 × 使用数）
    const count = q(pc.plannedCount);
    return {
      revenue: mul(count, q(pc.priceOverride ?? c?.price ?? 0)),                                // 予定個数 × 参加費
      material: round(mul(mul(count, add(q(1), mul(q(pc.sparePct), { n: 1n, d: 100n }))), unit)), // round(個数 ×（1＋予備率/100）× 原価)
    };
  });
  const participation = sum(lines.map((l) => l.revenue));
  const material = sum(lines.map((l) => l.material));
  const fixed = q(p.fixedRevenue);
  const revenue = add(participation, fixed);
  const venue = round(sum([q(p.venueFeeFixed), mul(q(p.venueFeePerDay), D), mul(mul(participation, q(p.venueFeeRatePct)), { n: 1n, d: 100n })]));
  const parts = sum(data.partTypes.map((t) => {
    const n = p.layout.items.filter((i) => i.partTypeId === t.id).length;
    return mul(mul(q(n), q(t.unitCost)), t.costUnit === 'day' ? D : q(1));
  }));
  const other = sum(p.otherCosts.map((o) => q(o.amount)));
  const total = sum([labor, material, venue, parts, other]);
  const chairs = new Set(data.partTypes.filter((t) => t.category === 'chair').map((t) => t.id));
  return {
    days: toNum(D), laborCost: toNum(labor), materialCost: toNum(material), participationRevenue: toNum(participation),
    revenue: toNum(revenue), venueFee: toNum(venue), partsCost: toNum(parts), otherCost: toNum(other),
    totalCost: toNum(total), profit: toNum(add(revenue, mul(q(-1), total))),
    seats: p.layout.items.filter((i) => chairs.has(i.partTypeId)).length,
  };
}

const KEYS = ['days', 'laborCost', 'materialCost', 'participationRevenue', 'revenue', 'venueFee', 'partsCost', 'otherCost', 'totalCost', 'profit', 'seats'] as const;
function pick(p: Project, data: AppData) {
  const e = estimate(p, data);
  return Object.fromEntries(KEYS.map((k) => [k, e[k]]));
}

const data = mkData();
const est = (patch: Partial<Project>, d: AppData = data) => estimate(mkProject({ assignments: [], contents: [], ...patch }), d);

describe('検算器そのものの確認', () => {
  it('設計書 4章の検算例（売上 150,000／人件費 17,750／材料費 29,700／会場費 55,000／費用計 107,450／利益 42,550）を再現する', () => {
    const p = mkProject({
      fixedRevenue: 100000, venueFeeFixed: 10000, venueFeePerDay: 20000, venueFeeRatePct: 10,
      contents: [mkContent({ plannedCount: 100, sparePct: 10 })],
      assignments: [
        mkAssign({ id: 'a1', staffId: 's1', date: '2026-12-05', startTime: '10:00', endTime: '18:00', breakMinutes: 60 }),
        mkAssign({ id: 'a2', staffId: 's2', date: '2026-12-06', startTime: '10:00', endTime: '15:30', breakMinutes: 0, rateOverride: 1500, transportOverride: 300 }),
      ],
      otherCosts: [{ id: 'o1', name: '印刷', amount: 5000 }],
    });
    const doc = { days: 2, laborCost: 17750, materialCost: 29700, participationRevenue: 50000, revenue: 150000, venueFee: 55000, partsCost: 0, otherCost: 5000, totalCost: 107450, profit: 42550, seats: 0 };
    expect(oracle(p, data)).toEqual(doc);
    expect(pick(p, data)).toEqual(doc);
  });
});

describe('会場費 = round(固定額 ＋ 日額 × 日数 ＋ 参加費売上 × 歩合/100)', () => {
  // 参加費売上 150,000 円（300個 × 500円）、5日間
  const base = { startDate: '2026-11-13', endDate: '2026-11-17', contents: [mkContent({ plannedCount: 300 })] };

  it('固定額だけ', () => {
    expect(est({ ...base, venueFeeFixed: 30000 }).venueFee).toBe(30000);
  });
  it('日額だけ（× 日数）', () => {
    expect(est({ ...base, venueFeePerDay: 20000 }).venueFee).toBe(100000);
  });
  it('売上歩合だけ', () => {
    expect(est({ ...base, venueFeeRatePct: 10 }).venueFee).toBe(15000);
  });
  it('固定＋日額×日数＋売上歩合の併用', () => {
    // 10,000 ＋ 20,000×5 ＋ 150,000×10% ＝ 125,000
    expect(est({ ...base, venueFeeFixed: 10000, venueFeePerDay: 20000, venueFeeRatePct: 10 }).venueFee).toBe(125000);
  });
  it('2つずつの併用', () => {
    expect(est({ ...base, venueFeeFixed: 10000, venueFeePerDay: 20000 }).venueFee).toBe(110000);
    expect(est({ ...base, venueFeeFixed: 10000, venueFeeRatePct: 10 }).venueFee).toBe(25000);
    expect(est({ ...base, venueFeePerDay: 20000, venueFeeRatePct: 10 }).venueFee).toBe(115000);
  });
  it('歩合の対象は参加費売上だけ。固定売上を増やしても会場費は変わらない（作業ログ D-04 の仮決定）', () => {
    const a = est({ ...base, venueFeeRatePct: 10, fixedRevenue: 0 });
    const b = est({ ...base, venueFeeRatePct: 10, fixedRevenue: 1000000 });
    expect(a.venueFee).toBe(15000);
    expect(b.venueFee).toBe(15000);
    expect(b.revenue - a.revenue).toBe(1000000);
  });
  it('歩合は参加費の上書き後の売上にかかる', () => {
    // 300個 × 上書き 800円 ＝ 240,000 → 10% ＝ 24,000
    expect(est({ ...base, venueFeeRatePct: 10, contents: [mkContent({ plannedCount: 300, priceOverride: 800 })] }).venueFee).toBe(24000);
  });
  it('複数コンテンツの参加費売上の合計にかかる', () => {
    // 300×500 ＋ 40×1,200 ＝ 198,000 → 10% ＝ 19,800
    const contents = [mkContent({ id: 'pc1', plannedCount: 300 }), mkContent({ id: 'pc2', plannedCount: 40, priceOverride: 1200 })];
    expect(est({ ...base, venueFeeRatePct: 10, contents }).venueFee).toBe(19800);
  });
  it('小数の歩合（12.5%）', () => {
    expect(est({ ...base, venueFeeRatePct: 12.5 }).venueFee).toBe(18750);
  });
  it('円未満は四捨五入（0.5 は切り上げ）', () => {
    // 55円 × 10% ＝ 5.5 → 6 ／ 54円 × 10% ＝ 5.4 → 5
    expect(est({ ...base, venueFeeRatePct: 10, contents: [mkContent({ plannedCount: 1, priceOverride: 55 })] }).venueFee).toBe(6);
    expect(est({ ...base, venueFeeRatePct: 10, contents: [mkContent({ plannedCount: 1, priceOverride: 54 })] }).venueFee).toBe(5);
    // 1,500円 × 3.3% ＝ 49.5 → 50
    expect(est({ ...base, venueFeeRatePct: 3.3, contents: [mkContent({ plannedCount: 3, priceOverride: 500 })] }).venueFee).toBe(50);
  });
  it('1日だけの案件は 日数 = 1', () => {
    const e = est({ ...base, endDate: '2026-11-13', venueFeeFixed: 10000, venueFeePerDay: 20000 });
    expect(e.days).toBe(1);
    expect(e.venueFee).toBe(30000);
  });
  it('期間が未入力・逆転のときは日数 0。日額分だけが 0 になり、固定額と歩合は残る', () => {
    for (const range of [{ startDate: '', endDate: '' }, { startDate: '2026-11-17', endDate: '2026-11-13' }]) {
      const e = est({ ...base, ...range, venueFeeFixed: 10000, venueFeePerDay: 20000, venueFeeRatePct: 10 });
      expect(e.days).toBe(0);
      expect(e.venueFee).toBe(25000);
    }
  });
  it('月またぎ・年またぎの日数', () => {
    expect(est({ startDate: '2026-11-28', endDate: '2026-12-02', venueFeePerDay: 1000 }).venueFee).toBe(5000);
    expect(est({ startDate: '2026-12-30', endDate: '2027-01-02', venueFeePerDay: 1000 }).venueFee).toBe(4000);
    expect(est({ startDate: '2028-02-27', endDate: '2028-03-01', venueFeePerDay: 1000 }).venueFee).toBe(4000); // うるう年
  });
});

describe('材料費 = Σ round(予定個数 ×（1 ＋ 予備率/100）× 1個あたり材料原価)', () => {
  it('1個あたり材料原価 = Σ（材料単価 × 使用数）', () => {
    expect(unitMaterialCost(bottle)).toBe(270);           // 120×1 ＋ 30×5
    expect(unitMaterialCost({ ...bottle, materials: [] })).toBe(0);
    expect(unitMaterialCost(undefined)).toBe(0);
  });
  it('予備率 0% / 10% / 12.5%', () => {
    expect(est({ contents: [mkContent({ plannedCount: 100, sparePct: 0 })] }).materialCost).toBe(27000);
    expect(est({ contents: [mkContent({ plannedCount: 100, sparePct: 10 })] }).materialCost).toBe(29700);
    expect(est({ contents: [mkContent({ plannedCount: 100, sparePct: 12.5 })] }).materialCost).toBe(30375);
  });
  it('予定個数に比例する（コンテンツ材料 × 予定個数）', () => {
    for (const n of [1, 7, 60, 300, 1234]) {
      expect(est({ contents: [mkContent({ plannedCount: n })] }).materialCost).toBe(n * 270);
    }
  });
  it('使用数が小数の材料（0.5 束など）', () => {
    const half = { ...bottle, id: 'c2', materials: [{ id: 'm', name: 'リボン', unitCost: 25, qtyPerUnit: 0.5 }] };
    const d = mkData({ contents: [bottle, half] });
    // 12.5円/個 × 3個 ＝ 37.5 → 38
    expect(est({ contents: [mkContent({ contentId: 'c2', plannedCount: 3 })] }, d).materialCost).toBe(38);
  });
  it('円未満の 0.5 は切り上げ（1個・予備率15%・原価50円 ＝ 57.5 → 58）', () => {
    const c50 = { ...bottle, id: 'c50', materials: [{ id: 'm', name: 'x', unitCost: 50, qtyPerUnit: 1 }] };
    const d = mkData({ contents: [c50] });
    expect(est({ contents: [mkContent({ contentId: 'c50', plannedCount: 1, sparePct: 15 })] }, d).materialCost).toBe(58);
    // 3個・予備率15%・原価270円 ＝ 931.5 → 932
    expect(est({ contents: [mkContent({ plannedCount: 3, sparePct: 15 })] }).materialCost).toBe(932);
  });
  it('四捨五入はコンテンツ行ごと。合計してから丸めるのではない', () => {
    const c50 = { ...bottle, id: 'c50', materials: [{ id: 'm', name: 'x', unitCost: 50, qtyPerUnit: 1 }] };
    const d = mkData({ contents: [c50] });
    const row = (id: string) => mkContent({ id, contentId: 'c50', plannedCount: 1, sparePct: 15 });
    // 57.5 ＋ 57.5 ＝ 115 だが、行ごとに 58 ＋ 58 ＝ 116
    const e = est({ contents: [row('pc1'), row('pc2')] }, d);
    expect(e.contentLines.map((l) => l.materialCost)).toEqual([58, 58]);
    expect(e.materialCost).toBe(116);
  });
  it('材料が未登録・コンテンツがマスタから削除済みなら材料費 0', () => {
    const d = mkData({ contents: [{ ...bottle, materials: [] }] });
    expect(est({ contents: [mkContent({ plannedCount: 100 })] }, d).materialCost).toBe(0);
    expect(est({ contents: [mkContent({ contentId: 'gone', plannedCount: 100 })] }).materialCost).toBe(0);
  });
  it('レイアウトのパーツ個数は材料費に影響しない（材料費はコンテンツ側、パーツは備品費。作業ログ D-01）', () => {
    const contents = [mkContent({ plannedCount: 100, sparePct: 10 })];
    const p = mkProject({ contents });
    const table = data.partTypes.find((t) => t.id === 'pt-table')!;
    const withTables = { ...p, layout: addPart(addPart(p.layout, table), table) };
    expect(estimate(withTables, data).materialCost).toBe(estimate(p, data).materialCost);
  });
});

describe('売上 計 = 参加費売上 ＋ 固定売上', () => {
  it('参加費売上だけ／固定売上だけ／併用', () => {
    const contents = [mkContent({ plannedCount: 300 })];
    expect(est({ contents })).toMatchObject({ participationRevenue: 150000, fixedRevenue: 0, revenue: 150000 });
    expect(est({ fixedRevenue: 100000 })).toMatchObject({ participationRevenue: 0, fixedRevenue: 100000, revenue: 100000 });
    expect(est({ contents, fixedRevenue: 100000 })).toMatchObject({ participationRevenue: 150000, fixedRevenue: 100000, revenue: 250000 });
  });
  it('参加無料（参加費 0）でも固定売上があれば売上になる', () => {
    const d = mkData({ contents: [{ ...bottle, price: 0 }] });
    const e = est({ contents: [mkContent({ plannedCount: 120 })], fixedRevenue: 150000 }, d);
    expect(e).toMatchObject({ participationRevenue: 0, revenue: 150000 });
    expect(e.materialCost).toBe(120 * 270);   // 無料でも材料費はかかる
  });
  it('参加費は「案件での上書き値、なければマスタ値」。上書き 0 は「0 円」であって未入力ではない', () => {
    expect(est({ contents: [mkContent({ plannedCount: 10, priceOverride: null })] }).participationRevenue).toBe(5000);
    expect(est({ contents: [mkContent({ plannedCount: 10, priceOverride: 800 })] }).participationRevenue).toBe(8000);
    expect(est({ contents: [mkContent({ plannedCount: 10, priceOverride: 0 })] }).participationRevenue).toBe(0);
  });
  it('複数コンテンツは行ごとの 個数 × 参加費 の合計', () => {
    const contents = [mkContent({ id: 'pc1', plannedCount: 300 }), mkContent({ id: 'pc2', plannedCount: 40, priceOverride: 1200 })];
    const e = est({ contents });
    expect(e.contentLines.map((l) => l.revenue)).toEqual([150000, 48000]);
    expect(e.participationRevenue).toBe(198000);
  });
  it('売上 0 のとき利益率は null（画面では「—」）。売上があれば 利益 ÷ 売上 計', () => {
    expect(est({}).marginPct).toBeNull();
    const e = est({ fixedRevenue: 200000, otherCosts: [{ id: 'o', name: 'x', amount: 150000 }] });
    expect(e.profit).toBe(50000);
    expect(e.marginPct).toBe(25);
  });
});

describe('備品費 = Σ（レイアウトの配置個数 × 単価 ×（単位が「1日」なら日数、「1案件」なら 1））', () => {
  const parts = withParts({
    'pt-table': { unitCost: 1000, costUnit: 'day' },
    'pt-chair': { unitCost: 200, costUnit: 'event' },
  });
  const d = mkData({ partTypes: parts });
  const table = parts.find((t) => t.id === 'pt-table')!;
  const chair = parts.find((t) => t.id === 'pt-chair')!;
  const five = { startDate: '2026-11-13', endDate: '2026-11-17' };
  const place = (nTable: number, nChair: number) => {
    let l = mkProject().layout;
    for (let i = 0; i < nTable; i++) l = addPart(l, table);
    for (let i = 0; i < nChair; i++) l = addPart(l, chair);
    return l;
  };

  it('「1日」単位は × 日数、「1案件」単位は × 1', () => {
    // テーブル 2台 × 1,000 × 5日 ＋ 椅子 3脚 × 200
    const e = est({ ...five, layout: place(2, 3) }, d);
    expect(e.partsCost).toBe(10000 + 600);
    expect(e.partLines.map((l) => [l.partTypeId, l.count, l.cost])).toEqual([['pt-table', 2, 10000], ['pt-chair', 3, 600]]);
  });
  it('パーツを 1 個増やす／減らすたびに、備品費と席数がその分だけ動く', () => {
    let l = place(2, 3);
    const at = (layout: typeof l) => { const e = est({ ...five, layout }, d); return [e.partsCost, e.seats]; };
    expect(at(l)).toEqual([10600, 3]);
    l = addPart(l, chair);                    expect(at(l)).toEqual([10800, 4]);   // 椅子 +1 → +200、席 +1
    l = addPart(l, table);                    expect(at(l)).toEqual([15800, 4]);   // テーブル +1 → +1,000×5、席は変わらない
    l = removeLastPart(l, 'pt-chair');        expect(at(l)).toEqual([15600, 3]);
    l = removeLastPart(l, 'pt-table');        expect(at(l)).toEqual([10600, 3]);
    l = removeItems(l, [l.items[0].id]);      expect(at(l)).toEqual([5600, 3]);    // 図面上で選んで削除（テーブル）
    l = removeItems(l, l.items.filter((i) => i.partTypeId === 'pt-chair').map((i) => i.id));
    expect(at(l)).toEqual([5000, 0]);                                              // 椅子を全部削除
  });
  it('L字（3台の組み合わせ）を置くとテーブル 3 台分。グループごと削除で元に戻る', () => {
    const before = mkProject().layout;
    const l = addComposite(before, defaultComposites()[0], parts);
    expect(countParts(l).get('pt-table')).toBe(3);
    expect(est({ ...five, layout: l }, d).partsCost).toBe(3 * 1000 * 5);
    const gone = removeItems(l, l.items.map((i) => i.id));
    expect(est({ ...five, layout: gone }, d).partsCost).toBe(0);
  });
  it('単価 0（自前の備品）は費用 0 だが個数は内訳に出る', () => {
    const e = est({ ...five, layout: place(2, 3) }, data);   // 既定マスタは単価 0
    expect(e.partsCost).toBe(0);
    expect(e.partLines.map((l) => l.count)).toEqual([2, 3]);
  });
  it('期間が未入力（日数 0）のとき、「1日」単位の費用は 0、「1案件」単位はそのまま', () => {
    expect(est({ startDate: '', endDate: '', layout: place(2, 3) }, d).partsCost).toBe(600);
  });
  it('マスタから削除された種別のパーツは備品費・席数に入らない（配置は残る）', () => {
    const l = place(2, 3);
    const noChair = mkData({ partTypes: parts.filter((t) => t.id !== 'pt-chair') });
    const e = est({ ...five, layout: l }, noChair);
    expect(e.partsCost).toBe(10000);
    expect(e.seats).toBe(0);
    expect(countParts(l).get('pt-chair')).toBe(3);
  });
  it('席数は「椅子」区分のパーツの個数。テーブルなど他の区分は数えない', () => {
    expect(est({ layout: place(4, 0) }, d).seats).toBe(0);
    expect(est({ layout: place(4, 7) }, d).seats).toBe(7);
  });
});

describe('人件費 = Σ（round(実働時間 × 時給) ＋ 交通費）', () => {
  it('実働時間 = max(0, 終了 − 開始 − 休憩) ÷ 60', () => {
    expect(assignmentHours(mkAssign({ startTime: '10:00', endTime: '18:00', breakMinutes: 60 }))).toBe(7);
    expect(assignmentHours(mkAssign({ startTime: '09:30', endTime: '13:15', breakMinutes: 0 }))).toBe(3.75);
    expect(assignmentHours(mkAssign({ startTime: '10:00', endTime: '11:00', breakMinutes: 90 }))).toBe(0);   // 休憩のほうが長い
    expect(assignmentHours(mkAssign({ startTime: '18:00', endTime: '10:00', breakMinutes: 0 }))).toBe(0);    // 逆転
    expect(assignmentHours(mkAssign({ startTime: '', endTime: '18:00' }))).toBe(0);                          // 未入力
  });
  it('時給・交通費は「案件での上書き値、なければマスタ値」。上書き 0 は 0 円として扱う', () => {
    expect(laborLine(mkAssign(), staffA).total).toBe(7 * 1200 + 800);
    expect(laborLine(mkAssign({ rateOverride: 1500 }), staffA).total).toBe(7 * 1500 + 800);
    expect(laborLine(mkAssign({ transportOverride: 300 }), staffA).total).toBe(7 * 1200 + 300);
    expect(laborLine(mkAssign({ transportOverride: 0 }), staffA).total).toBe(7 * 1200);
    expect(laborLine(mkAssign({ rateOverride: 0 }), staffA).total).toBe(800);
  });
  it('円未満は配置ごとに四捨五入（0.5 は切り上げ）', () => {
    // 65分 × 1,542円 ÷ 60 ＝ 1,670.5 → 1,671
    expect(laborLine(mkAssign({ startTime: '10:00', endTime: '11:05', breakMinutes: 0, rateOverride: 1542 }), staffB).wage).toBe(1671);
    // 50分 × 1,001円 ÷ 60 ＝ 834.1666… → 834
    expect(laborLine(mkAssign({ startTime: '10:00', endTime: '10:50', breakMinutes: 0, rateOverride: 1001 }), staffB).wage).toBe(834);
    // 2件とも 0.5 の端数 → 配置ごとに切り上げて合計
    const a = mkAssign({ id: 'x1', startTime: '10:00', endTime: '11:05', breakMinutes: 0, rateOverride: 1542 });
    const e = est({ assignments: [a, { ...a, id: 'x2', date: '2026-12-06' }] });
    expect(e.laborCost).toBe(1671 * 2 + 800 * 2);
  });
  it('実働 0 時間（時刻未入力・逆転・休憩超過）でも交通費は計上される', () => {
    expect(laborLine(mkAssign({ startTime: '', endTime: '' }), staffA)).toMatchObject({ hours: 0, wage: 0, transport: 800, total: 800 });
    expect(laborLine(mkAssign({ startTime: '18:00', endTime: '10:00' }), staffA)).toMatchObject({ wage: 0, total: 800 });
  });
  it('スタッフがマスタから削除済み（上書きなし）なら 0 円', () => {
    expect(laborLine(mkAssign({ staffId: 'gone' }), undefined)).toMatchObject({ staffName: '(未選択)', wage: 0, transport: 0, total: 0 });
  });
  it('総労働時間は全配置の実働時間の合計', () => {
    expect(estimate(mkProject(), data).totalHours).toBe(14);
  });
});

describe('組み合わせ（全項目を同時に使う）', () => {
  const parts = withParts({ 'pt-table': { unitCost: 1000, costUnit: 'day' }, 'pt-chair': { unitCost: 200, costUnit: 'event' } });
  const kit = { ...bottle, id: 'c2', name: 'ミニブーケ', price: 900, materials: [{ id: 'k1', name: '花', unitCost: 80, qtyPerUnit: 2 }, { id: 'k2', name: '包装', unitCost: 15, qtyPerUnit: 3 }] };
  const d = mkData({ partTypes: parts, contents: [bottle, kit] });
  let layout = mkProject().layout;
  layout = addComposite(layout, defaultComposites()[0], parts);
  layout = addComposite(layout, defaultComposites()[1], parts);
  for (let i = 0; i < 4; i++) layout = addPart(layout, parts.find((t) => t.id === 'pt-chair')!);
  const dates = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];
  const p = mkProject({
    startDate: dates[0], endDate: dates[4],
    fixedRevenue: 100000, venueFeeFixed: 10000, venueFeePerDay: 20000, venueFeeRatePct: 10,
    contents: [
      mkContent({ id: 'pc1', contentId: 'c1', plannedCount: 300, sparePct: 10 }),                       // 売上 150,000／材料 300×1.1×270 = 89,100
      mkContent({ id: 'pc2', contentId: 'c2', plannedCount: 40, priceOverride: 1200, sparePct: 5 }),    // 売上 48,000／材料 40×1.05×205 = 8,610
    ],
    assignments: [
      ...dates.map((date, i) => mkAssign({ id: `a${i}`, staffId: 's1', date })),                        // 5日 ×（7h×1,200 ＋ 800）= 46,000
      ...dates.slice(0, 2).map((date, i) => mkAssign({ id: `b${i}`, staffId: 's2', date, endTime: '15:30', breakMinutes: 0, rateOverride: 1500, transportOverride: 300 })), // 2日 ×（5.5h×1,500 ＋ 300）= 17,100
    ],
    otherCosts: [{ id: 'o1', name: '印刷', amount: 12000 }, { id: 'o2', name: '送料', amount: 3500 }],
    layout,
  });

  it('手計算と一致する', () => {
    const e = estimate(p, d);
    expect(e.days).toBe(5);
    expect(e.participationRevenue).toBe(198000);
    expect(e.revenue).toBe(298000);
    expect(e.laborCost).toBe(63100);
    expect(e.materialCost).toBe(97710);
    expect(e.venueFee).toBe(129800);          // 10,000 ＋ 20,000×5 ＋ 198,000×10%
    expect(e.partsCost).toBe(30800);          // テーブル 6台×1,000×5日 ＋ 椅子 4脚×200
    expect(e.otherCost).toBe(15500);
    expect(e.totalCost).toBe(336910);
    expect(e.profit).toBe(-38910);            // 赤字もそのまま出る
    expect(e.marginPct).toBeCloseTo((-38910 / 298000) * 100, 10);
    expect(e.seats).toBe(4);
    expect(e.totalHours).toBe(5 * 7 + 2 * 5.5);
  });
  it('検算器（厳密な分数）とも一致する', () => {
    expect(pick(p, d)).toEqual(oracle(p, d));
  });
  it('費用 計 = 人件費＋材料費＋会場費＋備品費＋その他、利益 = 売上 計 − 費用 計', () => {
    const e = estimate(p, d);
    expect(e.totalCost).toBe(e.laborCost + e.materialCost + e.venueFee + e.partsCost + e.otherCost);
    expect(e.profit).toBe(e.revenue - e.totalCost);
    expect(e.revenue).toBe(e.participationRevenue + e.fixedRevenue);
  });
  it('1項目だけ変えると、その項目に対応する金額だけが動く', () => {
    const base = estimate(p, d);
    const diff = (q2: Project) => {
      const e = estimate(q2, d);
      return Object.fromEntries(KEYS.filter((k) => e[k] !== base[k]).map((k) => [k, e[k] - base[k]]));
    };
    expect(diff({ ...p, fixedRevenue: 150000 })).toEqual({ revenue: 50000, profit: 50000 });
    expect(diff({ ...p, venueFeeFixed: 15000 })).toEqual({ venueFee: 5000, totalCost: 5000, profit: -5000 });
    expect(diff({ ...p, venueFeePerDay: 21000 })).toEqual({ venueFee: 5000, totalCost: 5000, profit: -5000 });
    expect(diff({ ...p, otherCosts: [] })).toEqual({ otherCost: -15500, totalCost: -15500, profit: 15500 });
    // 椅子を 1 脚足す → 備品費 +200、席 +1
    expect(diff({ ...p, layout: addPart(p.layout, parts.find((t) => t.id === 'pt-chair')!) })).toEqual({ partsCost: 200, totalCost: 200, profit: -200, seats: 1 });
    // 予定個数を 300 → 310：参加費売上 +5,000、材料費 +2,970、会場費（歩合10%）+500
    const more = { ...p, contents: [{ ...p.contents[0], plannedCount: 310 }, p.contents[1]] };
    expect(diff(more)).toEqual({ participationRevenue: 5000, revenue: 5000, materialCost: 2970, venueFee: 500, totalCost: 3470, profit: 1530 });
    // 終了日を 1 日延ばす：日数 +1 → 会場費 +20,000、テーブル（1日単位）6台 +6,000
    expect(diff({ ...p, endDate: '2026-11-18' })).toEqual({ days: 1, venueFee: 20000, partsCost: 6000, totalCost: 26000, profit: -26000 });
  });
});

describe('ランダムな入力での検算（実装 = 厳密な分数での計算）', () => {
  const pickInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const oneOf = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  function randomCase(r: () => number, decimals: boolean): { p: Project; d: AppData } {
    const dec1 = (lo: number, hi: number) => (decimals ? pickInt(r, lo * 10, hi * 10) / 10 : pickInt(r, lo, hi));
    const parts = withParts({
      'pt-table': { unitCost: pickInt(r, 0, 3000), costUnit: oneOf(r, ['day', 'event'] as const) },
      'pt-chair': { unitCost: pickInt(r, 0, 500), costUnit: oneOf(r, ['day', 'event'] as const) },
      'pt-nego': { unitCost: pickInt(r, 0, 5000), costUnit: oneOf(r, ['day', 'event'] as const) },
    });
    const contents = [0, 1, 2].map((i) => ({
      id: `c${i}`, name: `c${i}`, price: pickInt(r, 0, 30) * 100, memo: '',
      materials: Array.from({ length: pickInt(r, 0, 4) }, (_, k) => ({
        id: `m${i}${k}`, name: 'm', unitCost: dec1(1, 400), qtyPerUnit: decimals ? pickInt(r, 1, 600) / 100 : pickInt(r, 1, 6),
      })),
    }));
    const staff = [0, 1, 2].map((i) => ({ id: `s${i}`, name: `s${i}`, hourlyRate: pickInt(r, 1000, 2500), transportPerDay: pickInt(r, 0, 150) * 10, memo: '' }));
    const d = mkData({ partTypes: parts, contents, staff });
    const startDay = pickInt(r, 1, 20), len = pickInt(r, 1, 9);
    const date = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;
    let layout = mkProject().layout;
    for (const id of ['pt-table', 'pt-chair', 'pt-nego']) {
      for (let i = pickInt(r, 0, 8); i > 0; i--) layout = addPart(layout, parts.find((t) => t.id === id)!);
    }
    if (r() < 0.5) layout = addComposite(layout, defaultComposites()[pickInt(r, 0, 2)], parts);
    const p = mkProject({
      startDate: date(startDay), endDate: date(startDay + len - 1),
      fixedRevenue: pickInt(r, 0, 50) * 10000,
      venueFeeFixed: pickInt(r, 0, 10) * 5000, venueFeePerDay: pickInt(r, 0, 60) * 500, venueFeeRatePct: dec1(0, 30),
      contents: Array.from({ length: pickInt(r, 0, 3) }, (_, i) => mkContent({
        id: `pc${i}`, contentId: `c${pickInt(r, 0, 2)}`, plannedCount: pickInt(r, 0, 800),
        priceOverride: r() < 0.3 ? pickInt(r, 0, 4000) : null, sparePct: dec1(0, 30),
      })),
      assignments: Array.from({ length: pickInt(r, 0, 12) }, (_, i) => {
        const start = pickInt(r, 8 * 12, 13 * 12) * 5, span = pickInt(r, 6, 120) * 5;
        return mkAssign({
          id: `a${i}`, staffId: `s${pickInt(r, 0, 2)}`, date: date(startDay + pickInt(r, 0, len - 1)),
          startTime: hhmm(start), endTime: hhmm(start + span), breakMinutes: oneOf(r, [0, 0, 15, 30, 45, 60, 90]),
          rateOverride: r() < 0.3 ? pickInt(r, 900, 3000) : null, transportOverride: r() < 0.3 ? pickInt(r, 0, 2000) : null,
        });
      }),
      otherCosts: Array.from({ length: pickInt(r, 0, 3) }, (_, i) => ({ id: `o${i}`, name: 'x', amount: pickInt(r, 0, 500) * 100 })),
      layout,
    });
    return { p, d };
  }

  it('整数の入力 3,000 件：全項目が 1 円もずれない', () => {
    const r = rng(20261113);
    for (let i = 0; i < 3000; i++) {
      const { p, d } = randomCase(r, false);
      expect(pick(p, d), `case #${i}`).toEqual(oracle(p, d));
    }
  });
  it('小数を含む入力（予備率・歩合 0.1% 刻み、材料の単価 0.1 円刻み・使用数 0.01 刻み）3,000 件', () => {
    const r = rng(20261117);
    for (let i = 0; i < 3000; i++) {
      const { p, d } = randomCase(r, true);
      const got = pick(p, d), want = oracle(p, d);
      for (const k of KEYS) expect(got[k], `case #${i} ${k}`).toBeCloseTo(want[k], 6);
      // 四捨五入する項目は整数で完全一致
      for (const k of ['laborCost', 'materialCost', 'venueFee'] as const) expect(got[k], `case #${i} ${k}`).toBe(want[k]);
    }
  });
});
