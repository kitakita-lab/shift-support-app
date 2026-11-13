// JCOS 案件の収支（jcos.ts）のテスト。
//   1. 手計算の値と比べる（受入例。Issue #88 の例を、材料原価 一律 220 円に直したもの）
//   2. 独立した計算経路との突き合わせ（取引を 1 件ずつ台帳に書き出して集計する。厳密な分数で計算し、実装の作りとは別）
//   3. 請求対象日数とアルバイト稼働日数の区別・予定と実績の区別・材料費の超過
//   4. 汎用の試算・レイアウトとの分離（二重計上しない／パーツを増減しても粗利が変わらない）
import { describe, expect, it } from 'vitest';
import { JcosTerms, Project, ReportSync } from '../types';
import { estimate } from './calc';
import { actualsByDate, defaultJcos, isJcos, jcosDay, jcosEstimate, jcosExcluded, projectMoney, splitEvenly, withJcosDay } from './jcos';
import { addPart, removeLastPart } from './layout';
import { defaultPartTypes, duplicateProject, newProject, sampleData } from './seed';
import { mkAssign, mkContent, mkData, mkProject, rng, withParts } from './testkit';
import { projectWarnings } from './warnings';

// ── テスト用の部品 ───────────────────────────────────────────
const terms = (patch: Partial<JcosTerms> = {}): JcosTerms => ({ ...defaultJcos(), ...patch });
/** JCOS 案件（既定: 1 日・予定 0 個・汎用の項目はすべて 0） */
function jp(patch: Partial<Project> = {}): Project {
  return mkProject({
    startDate: '2026-11-13', endDate: '2026-11-13', contents: [mkContent({ plannedCount: 0 })], assignments: [],
    jcos: terms(), ...patch,
  });
}
function sync(p: Pick<Project, 'venueId' | 'startDate' | 'endDate'>, days: [string, number, number?][]): ReportSync {
  return {
    at: '2026-11-14T09:00:00.000Z', venueId: p.venueId, startDate: p.startDate, endDate: p.endDate,
    days: days.map(([date, count, rows = 1]) => ({ date, count, rows })),
    rowsRead: days.length, rowsUsed: days.length, tests: 0, skipped: [], held: [], unmatched: [],
  };
}
const D5 = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];

// ── 1. 手計算の受入例 ────────────────────────────────────────
describe('JCOS の収支: 手計算の受入例', () => {
  it('1 日・実績 120 個: 請求 40,000 − 実費（アルバイト 15,000 ＋ 材料 120×220＝26,400）＝ 粗利 −1,400', () => {
    const e = jcosEstimate(jp({ actualsManual: { '2026-11-13': 120 } }));
    expect(e.current).toMatchObject({
      billLabor: 30000, billMaterial: 10000, extraBilling: 0, billing: 40000,
      partTimerCost: 15000, materialCost: 26400, otherCost: 0, cost: 41400, gross: -1400, count: 120, materialOver: 16400,
    });
    expect(e.current.marginPct).toBeCloseTo(-3.5, 10);
    expect(e.basis).toBe('actual');
  });
  it('1 日・実績 0 個: 粗利 25,000（請求 40,000 − アルバイト 15,000）', () => {
    const e = jcosEstimate(jp({ actualsManual: { '2026-11-13': 0 } }));
    expect(e.current).toMatchObject({ billing: 40000, cost: 15000, gross: 25000, materialCost: 0, materialOver: 0, count: 0 });
    expect(e.basis).toBe('actual');           // 0 個も「実績あり」（未入力とは区別する）
  });
  it('5 日請求・アルバイトは 3 日だけ・実績 62,58,70,55,65（計 310 個）: 請求 200,000 − 実費 113,200 ＝ 粗利 86,800', () => {
    let t = terms();
    t = withJcosDay(t, D5[1], { partTimers: 0 });
    t = withJcosDay(t, D5[3], { partTimers: 0 });
    const p = jp({ startDate: D5[0], endDate: D5[4], jcos: t });
    const e = jcosEstimate({ ...p, reportSync: sync(p, [[D5[0], 62], [D5[1], 58], [D5[2], 70], [D5[3], 55], [D5[4], 65]]) });
    expect([e.periodDays, e.billDays, e.partTimerDays]).toEqual([5, 5, 3]);
    expect(e.current).toMatchObject({
      billLabor: 150000, billMaterial: 50000, billing: 200000,
      partTimerCost: 45000, materialCost: 68200, cost: 113200, gross: 86800, count: 310, materialOver: 18200,
    });
    // 日別: 請求 40,000 − アルバイト代 − 材料原価
    expect(e.days.map((d) => d.gross)).toEqual([40000 - 15000 - 13640, 40000 - 12760, 40000 - 15000 - 15400, 40000 - 12100, 40000 - 15000 - 14300]);
    expect(e.days.map((d) => d.materialOver)).toEqual([3640, 2760, 5400, 2100, 4300]);
    expect(e.days.reduce((s, d) => s + d.gross, 0)).toBe(86800);
  });
  it('5 日・実績 80,78,82,57,83（計 380 個）・予備費の追加請求 20,000・その他実費 8,000: 粗利 53,400', () => {
    const p = jp({
      startDate: D5[0], endDate: D5[4],
      jcos: terms({ extraBillings: [{ id: 'x1', name: '予備費', amount: 20000 }] }),
      otherCosts: [{ id: 'o1', name: '追加レンタル', amount: 8000 }],
    });
    const e = jcosEstimate({ ...p, reportSync: sync(p, [[D5[0], 80], [D5[1], 78], [D5[2], 82], [D5[3], 57], [D5[4], 83]]) });
    // 請求 ＝ 40,000 × 5 ＋ 20,000 ＝ 220,000 ／ 実費 ＝ 15,000 × 5 ＋ 380 × 220 ＋ 8,000 ＝ 75,000 ＋ 83,600 ＋ 8,000 ＝ 166,600
    expect(e.current).toMatchObject({ billing: 220000, extraBilling: 20000, partTimerCost: 75000, materialCost: 83600, otherCost: 8000, cost: 166600, gross: 53400 });
    // 追加の請求・その他実費は会期全体の項目で、日別の粗利には入れない（日別の合計 ＋ 追加の請求 − その他実費 ＝ 会期の粗利）
    expect(e.days.reduce((s, d) => s + d.gross, 0) + 20000 - 8000).toBe(53400);
  });
  it('単価は案件ごとに変えられる（請求 35,000＋12,000／アルバイト 16,000／材料原価 250）', () => {
    const e = jcosEstimate(jp({
      jcos: terms({ billLaborPerDay: 35000, billMaterialPerDay: 12000, partTimerPerDay: 16000, unitCost: 250 }),
      actualsManual: { '2026-11-13': 40 },
    }));
    expect(e.current).toMatchObject({ billing: 47000, partTimerCost: 16000, materialCost: 10000, cost: 26000, gross: 21000, materialOver: 0 });
  });
});

// ── 2. 独立した計算経路（台帳方式・厳密な分数） ─────────────────────
interface Q { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const norm = (n: bigint, d: bigint): Q => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
function q(v: number): Q {
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`検算器は 10 進表記のみ対応: ${s}`);
  const [i, f = ''] = s.split('.');
  return norm(BigInt(i + f), 10n ** BigInt(f.length));
}
const mul = (a: Q, b: Q) => norm(a.n * b.n, a.d * b.d);
const floorDiv = (a: bigint, b: bigint) => a / b - (a % b !== 0n && (a < 0n) !== (b < 0n) ? 1n : 0n);
/** 四捨五入（ちょうど 0.5 は切り上げ）して整数（円）にする */
const yenOf = (a: Q): bigint => floorDiv(2n * a.n + a.d, 2n * a.d);

/** 会期の日付を、実装（util.listDates）を使わずに並べる */
function datesOf(start: string, end: string): string[] {
  const t = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const out: string[] = [];
  for (let x = t(start); x <= t(end); x += 86400000) out.push(new Date(x).toISOString().slice(0, 10));
  return out;
}

/**
 * 台帳方式の検算。取引（請求・支払い）を 1 件ずつ書き出し、最後に種類ごとに足す。
 * 実装は「日別の行を作って足す」作りなので、作りが違う。金額は厳密な分数で持ち、四捨五入の位置だけ仕様に合わせる。
 */
function ledger(p: Project) {
  const t = p.jcos!;
  const dates = datesOf(p.startDate, p.endDate);
  const book: { kind: 'billLabor' | 'billMaterial' | 'extra' | 'partTimer' | 'material' | 'other'; yen: bigint }[] = [];

  // 請求: 請求する日ごとに 2 件（人件費・材料費）。追加の請求は 1 行 1 件
  for (const d of dates) {
    if (t.days[d]?.billed === false) continue;
    book.push({ kind: 'billLabor', yen: yenOf(q(t.billLaborPerDay)) });
    book.push({ kind: 'billMaterial', yen: yenOf(q(t.billMaterialPerDay)) });
  }
  for (const x of t.extraBillings) book.push({ kind: 'extra', yen: yenOf(q(x.amount)) });

  // 支払い: アルバイト代は 1 日ごと（人数 × 単価）
  for (const d of dates) book.push({ kind: 'partTimer', yen: yenOf(mul(q(t.days[d]?.partTimers ?? 1), q(t.partTimerPerDay))) });

  // 支払い: 材料原価。その日の個数 ＝ 日報の実績 → 手入力 → 予定（均等割り）の順
  const planned = p.contents.reduce((s, c) => s + c.plannedCount, 0);
  const base = Math.floor(planned / dates.length), extra = planned - base * dates.length;
  const reportOk = !!p.reportSync && p.reportSync.venueId === p.venueId;
  let count = 0n;
  dates.forEach((d, i) => {
    const fromReport = reportOk ? p.reportSync!.days.find((x) => x.date === d)?.count : undefined;
    const manual = p.actualsManual?.[d];
    const n = fromReport ?? manual ?? base + (i < extra ? 1 : 0);
    count += BigInt(n);
    book.push({ kind: 'material', yen: yenOf(mul(q(n), q(t.unitCost))) });
  });
  for (const o of p.otherCosts) book.push({ kind: 'other', yen: yenOf(q(o.amount)) });

  const of = (k: string) => Number(book.filter((b) => b.kind === k).reduce((s, b) => s + b.yen, 0n));
  const billing = of('billLabor') + of('billMaterial') + of('extra');
  const cost = of('partTimer') + of('material') + of('other');
  return {
    billLabor: of('billLabor'), billMaterial: of('billMaterial'), extraBilling: of('extra'), billing,
    partTimerCost: of('partTimer'), materialCost: of('material'), otherCost: of('other'), cost,
    gross: billing - cost, count: Number(count), materialOver: Math.max(0, of('material') - of('billMaterial')),
  };
}

describe('JCOS の収支: 独立した計算経路（台帳方式）との突き合わせ', () => {
  it('手計算の受入例は、台帳方式でも同じ値になる', () => {
    const p = jp({ startDate: D5[0], endDate: D5[4] });
    const withSync = { ...p, reportSync: sync(p, [[D5[0], 62], [D5[1], 58], [D5[2], 70], [D5[3], 55], [D5[4], 65]]) };
    expect(ledger(withSync)).toMatchObject({ billing: 200000, cost: 75000 + 68200, gross: 56800 });
    expect(jcosEstimate(withSync).current).toMatchObject(ledger(withSync));
  });

  it('無作為に作った 3,000 件の案件で、実装と台帳方式が 1 円もずれない（整数の単価）', () => {
    const r = rng(20261113);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let k = 0; k < 3000; k += 1) {
      const n = int(1, 9);
      const dates = datesOf('2026-11-13', new Date(Date.UTC(2026, 10, 13 + n - 1)).toISOString().slice(0, 10));
      let t = terms({
        billLaborPerDay: int(0, 6) * 5000, billMaterialPerDay: int(0, 4) * 5000, partTimerPerDay: int(0, 4) * 5000, unitCost: int(0, 400),
        extraBillings: Array.from({ length: int(0, 2) }, (_, i) => ({ id: `x${i}`, name: '予備費', amount: int(0, 30) * 1000 })),
      });
      const manual: Record<string, number> = {};
      const reported: [string, number][] = [];
      for (const d of dates) {
        if (r() < 0.25) t = withJcosDay(t, d, { billed: false });
        if (r() < 0.4) t = withJcosDay(t, d, { partTimers: int(0, 3) });
        if (r() < 0.3) manual[d] = int(0, 150);
        if (r() < 0.4) reported.push([d, int(0, 150)]);
      }
      const base = jp({
        startDate: dates[0], endDate: dates[dates.length - 1], jcos: t, actualsManual: manual,
        contents: [mkContent({ plannedCount: int(0, 600) }), mkContent({ id: 'pc2', plannedCount: int(0, 200) })],
        otherCosts: Array.from({ length: int(0, 2) }, (_, i) => ({ id: `o${i}`, name: '実費', amount: int(0, 20) * 500 })),
      });
      const p = r() < 0.7 ? { ...base, reportSync: sync(base, reported) } : base;
      const e = jcosEstimate(p);
      expect(e.current, `案件 ${k}`).toMatchObject(ledger(p));
      // 日別の合計と会期の合計が合う
      const t0 = e.current;
      expect(e.days.reduce((s, d) => s + d.billing, 0) + t0.extraBilling).toBe(t0.billing);
      expect(e.days.reduce((s, d) => s + d.cost, 0) + t0.otherCost).toBe(t0.cost);
      expect(e.days.reduce((s, d) => s + d.gross, 0) + t0.extraBilling - t0.otherCost).toBe(t0.gross);
      expect(e.days.reduce((s, d) => s + d.count, 0)).toBe(t0.count);
    }
  });

  it('単価が小数でも、台帳方式（厳密な分数）と一致する（材料原価は日ごとに円未満を四捨五入）', () => {
    const r = rng(88);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let k = 0; k < 1000; k += 1) {
      const n = int(1, 6);
      const dates = datesOf('2026-12-01', new Date(Date.UTC(2026, 11, 1 + n - 1)).toISOString().slice(0, 10));
      const manual: Record<string, number> = {};
      for (const d of dates) if (r() < 0.6) manual[d] = int(0, 120);
      const p = jp({
        startDate: dates[0], endDate: dates[n - 1], actualsManual: manual, contents: [mkContent({ plannedCount: int(0, 500) })],
        jcos: terms({ unitCost: int(1000, 30000) / 100, partTimerPerDay: int(100000, 2000000) / 100 }),
      });
      expect(jcosEstimate(p).current, `案件 ${k}`).toMatchObject(ledger(p));
    }
  });
  it('四捨五入の位置: 単価 220.5 円 × 3 個 ＝ 661.5 → 662 円（日ごと）。2 日なら 1,324 円（661.5 × 2 ＝ 1,323 ではない）', () => {
    const p = jp({ startDate: D5[0], endDate: D5[1], jcos: terms({ unitCost: 220.5 }), actualsManual: { [D5[0]]: 3, [D5[1]]: 3 } });
    const e = jcosEstimate(p);
    expect(e.days.map((d) => d.materialCost)).toEqual([662, 662]);
    expect(e.current.materialCost).toBe(1324);
  });
});

// ── 3. 日数・予定と実績・超過 ───────────────────────────────────
describe('請求対象日数とアルバイト稼働日数は別々に数える', () => {
  const base = jp({ startDate: D5[0], endDate: D5[4] });
  it('何も変えなければ、会期の日数ぶん請求し、毎日アルバイト 1 人', () => {
    const e = jcosEstimate(base);
    expect([e.periodDays, e.billDays, e.partTimerDays]).toEqual([5, 5, 5]);
    expect(e.current).toMatchObject({ billing: 200000, partTimerCost: 75000 });
  });
  it('請求しない日を作っても、アルバイトの稼働は変わらない', () => {
    const e = jcosEstimate({ ...base, jcos: withJcosDay(terms(), D5[2], { billed: false }) });
    expect([e.billDays, e.partTimerDays]).toEqual([4, 5]);
    expect(e.current).toMatchObject({ billLabor: 120000, billMaterial: 40000, billing: 160000, partTimerCost: 75000 });
    expect(e.days[2]).toMatchObject({ billed: false, billing: 0, partTimers: 1, partTimerCost: 15000, gross: -15000 });
  });
  it('アルバイトが稼働しない日・2 人の日を作っても、請求は変わらない', () => {
    let t = withJcosDay(terms(), D5[0], { partTimers: 0 });
    t = withJcosDay(t, D5[1], { partTimers: 2 });
    const e = jcosEstimate({ ...base, jcos: t });
    expect([e.billDays, e.partTimerDays]).toEqual([5, 5]);     // 0＋2＋1＋1＋1
    expect(e.days.map((d) => d.partTimerCost)).toEqual([0, 30000, 15000, 15000, 15000]);
    expect(e.current.billing).toBe(200000);
  });
  it('日ごとの設定は、既定（請求する・1 人）に戻すとデータから消える', () => {
    let t = withJcosDay(terms(), D5[0], { billed: false, partTimers: 2 });
    expect(t.days).toEqual({ [D5[0]]: { billed: false, partTimers: 2 } });
    t = withJcosDay(t, D5[0], { billed: true });
    expect(t.days).toEqual({ [D5[0]]: { partTimers: 2 } });
    t = withJcosDay(t, D5[0], { partTimers: 1 });
    expect(t.days).toEqual({});
    expect(jcosDay(t, D5[0])).toEqual({ billed: true, partTimers: 1 });
  });
  it('会期の外の日に残った設定は、計算に入らない（会期を変えたあとの残り）', () => {
    const t = withJcosDay(terms(), '2026-12-25', { billed: false, partTimers: 5 });
    expect(jcosEstimate({ ...base, jcos: t }).current).toMatchObject({ billing: 200000, partTimerCost: 75000 });
  });
});

describe('予定個数と実績個数を区別する', () => {
  const base = jp({ startDate: D5[0], endDate: D5[4], contents: [mkContent({ plannedCount: 300 })] });
  it('実績が無い間は、予定個数（300 個を 5 日で均等割り＝60 個/日）で見込みを出す', () => {
    const e = jcosEstimate(base);
    expect(e.basis).toBe('planned');
    expect(e.days.map((d) => [d.plannedCount, d.count, d.basis])).toEqual(D5.map(() => [60, 60, 'planned']));
    expect(e.current).toEqual(e.planned);
    expect(e.planned).toMatchObject({ count: 300, materialCost: 66000, gross: 200000 - 75000 - 66000 });
    expect([e.plannedCount, e.actualCount, e.actualDays]).toEqual([300, 0, 0]);
  });
  it('一部の日に実績が入ると、その日は実績・残りは予定で計算し、予定だけの見込みも別に持つ', () => {
    const e = jcosEstimate({ ...base, reportSync: sync(base, [[D5[0], 80], [D5[1], 45]]) });
    expect(e.basis).toBe('mixed');
    expect(e.days.map((d) => [d.count, d.basis])).toEqual([[80, 'actual'], [45, 'actual'], [60, 'planned'], [60, 'planned'], [60, 'planned']]);
    expect([e.plannedCount, e.actualCount, e.actualDays]).toEqual([300, 125, 2]);
    expect(e.current).toMatchObject({ count: 305, materialCost: 67100, gross: 200000 - 75000 - 67100 });
    expect(e.planned).toMatchObject({ count: 300, materialCost: 66000 });            // 予定は実績に引きずられない
    // 実績のある 2 日だけの小計
    expect(e.reported).toEqual({ days: 2, count: 125, billing: 80000, cost: 30000 + 27500, gross: 80000 - 57500 });
  });
  it('全日に実績が入ると、実績だけで計算する', () => {
    const e = jcosEstimate({ ...base, reportSync: sync(base, D5.map((d, i) => [d, 50 + i] as [string, number])) });
    expect(e.basis).toBe('actual');
    expect(e.current.count).toBe(50 + 51 + 52 + 53 + 54);
  });
  it('予定個数は、複数のコンテンツの合計（製品の種類では分けない）。割り切れない端数は前の日から 1 個ずつ', () => {
    const e = jcosEstimate({ ...base, contents: [mkContent({ plannedCount: 200 }), mkContent({ id: 'pc2', plannedCount: 103 })] });
    expect(e.plannedCount).toBe(303);
    expect(e.days.map((d) => d.plannedCount)).toEqual([61, 61, 61, 60, 60]);
    expect(e.planned.materialCost).toBe(303 * 220);
  });
  it('均等割りは、合計が必ず元の個数と一致する', () => {
    for (let total = 0; total <= 400; total += 7) for (let days = 1; days <= 9; days += 1) {
      const s = splitEvenly(total, days);
      expect(s.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
    }
    expect(splitEvenly(10, 0)).toEqual([]);
    expect(splitEvenly(-5, 2)).toEqual([0, 0]);                 // マイナスの予定個数は 0 として扱う（警告は別に出る）
  });
});

describe('実績のもと（日報・手入力）', () => {
  const base = jp({ startDate: D5[0], endDate: D5[2], contents: [mkContent({ plannedCount: 90 })] });
  it('同じ日に日報と手入力があれば、日報を使う（手入力は消さずに残し、使っていないことが分かる）', () => {
    const p = { ...base, actualsManual: { [D5[0]]: 50, [D5[1]]: 40 }, reportSync: sync(base, [[D5[0], 52, 2]]) };
    const a = actualsByDate(p);
    expect(a.get(D5[0])).toEqual({ count: 52, source: 'report', rows: 2 });
    expect(a.get(D5[1])).toEqual({ count: 40, source: 'manual', rows: 0 });
    expect(a.has(D5[2])).toBe(false);
    const e = jcosEstimate(p);
    expect(e.days.map((d) => d.manualIgnored)).toEqual([50, null, null]);
    expect(e.current.count).toBe(52 + 40 + 30);
  });
  it('日報と手入力が同じ値なら、「使っていない手入力」としては示さない', () => {
    const p = { ...base, actualsManual: { [D5[0]]: 52 }, reportSync: sync(base, [[D5[0], 52]]) };
    expect(jcosEstimate(p).days[0].manualIgnored).toBeNull();
  });
  it('同期のあとで会場を変えたら、その日報の実績は使わない（別の会場の実績を、この案件に入れない）', () => {
    const p = { ...base, reportSync: sync(base, [[D5[0], 52]]) };
    expect(jcosEstimate(p).actualDays).toBe(1);
    const moved = { ...p, venueId: 'v-other' };
    expect(jcosEstimate(moved).actualDays).toBe(0);
    expect(jcosEstimate(moved).basis).toBe('planned');
  });
  it('同期のあとで会期を縮めたら、会期の外になった日の実績は数えない', () => {
    const p = { ...base, reportSync: sync(base, [[D5[0], 52], [D5[2], 61]]) };
    const e = jcosEstimate({ ...p, endDate: D5[1] });
    expect([e.periodDays, e.actualDays, e.actualCount]).toEqual([2, 1, 52]);
  });
  it('手入力の不正な値（マイナス・数でないもの）は、実績として扱わない', () => {
    const p = { ...base, actualsManual: { [D5[0]]: -3, [D5[1]]: Number.NaN, [D5[2]]: 0 } };
    expect([...actualsByDate(p).keys()]).toEqual([D5[2]]);
  });
});

describe('同じ会場で会期が重なる案件があるとき（案件と会場の一覧を渡した計算）', () => {
  const data = mkData();
  const a = jp({ id: 'pa', startDate: D5[0], endDate: D5[2], contents: [mkContent({ plannedCount: 90 })] });
  const b = jp({ id: 'pb', name: '重なる案件', startDate: D5[1], endDate: D5[3], contents: [mkContent({ plannedCount: 90 })] });
  const synced = { ...a, reportSync: sync(a, [[D5[0], 40], [D5[1], 50], [D5[2], 60]]), actualsManual: { [D5[2]]: 33 } };

  it('重なる日の日報の実績は、この案件のものと決まるまで使わない（手入力があれば手入力、無ければ予定で計算する）', () => {
    const alone = jcosEstimate(synced, { ...data, projects: [synced] });
    expect(alone.days.map((d) => [d.count, d.actual?.source ?? null])).toEqual([[40, 'report'], [50, 'report'], [60, 'report']]);
    const both = jcosEstimate(synced, { ...data, projects: [synced, b] });
    expect(both.days.map((d) => [d.count, d.actual?.source ?? null])).toEqual([[40, 'report'], [30, null], [33, 'manual']]);
    expect(both.current.materialCost).toBe((40 + 30 + 33) * 220);
    // 「この案件の実績にする」と決めた日は、また日報の実績を使う
    const claimed = { ...synced, reportClaims: [D5[1], D5[2]] };
    expect(jcosEstimate(claimed, { ...data, projects: [claimed, b] }).actualCount).toBe(150);
  });
  it('一覧・見出しの金額も、同じ決め方で計算する（案件ごとに違う数字にならない）', () => {
    const all = { ...data, projects: [synced, b] };
    expect(projectMoney(synced, all).profit).toBe(jcosEstimate(synced, all).current.gross);
    expect(projectMoney(synced, all).profit).not.toBe(jcosEstimate(synced).current.gross);
  });
});

describe('材料費の超過（請求した材料費を、原価が超えた額）', () => {
  it('1 日 10,000 円の請求に対し、45 個（9,900 円）までは超過なし、46 個（10,120 円）で 120 円の超過', () => {
    const at = (n: number) => jcosEstimate(jp({ actualsManual: { '2026-11-13': n } }));
    expect(at(45).current).toMatchObject({ materialCost: 9900, materialOver: 0 });
    expect(at(46).current).toMatchObject({ materialCost: 10120, materialOver: 120 });
    expect(at(46).days[0].materialOver).toBe(120);
  });
  it('会期の超過は、合計どうしで比べる（少ない日のぶんで、多い日の超過が埋まる）', () => {
    const p = jp({ startDate: D5[0], endDate: D5[1], actualsManual: { [D5[0]]: 60, [D5[1]]: 20 } });
    const e = jcosEstimate(p);
    expect(e.days.map((d) => d.materialOver)).toEqual([3200, 0]);          // 60×220＝13,200 → 3,200 超過／20×220＝4,400
    expect(e.current).toMatchObject({ billMaterial: 20000, materialCost: 17600, materialOver: 0 });
  });
  it('請求しない日の材料原価は、全額が超過になる', () => {
    const p = jp({ jcos: withJcosDay(terms(), '2026-11-13', { billed: false }), actualsManual: { '2026-11-13': 10 } });
    expect(jcosEstimate(p).current).toMatchObject({ billing: 0, materialCost: 2200, materialOver: 2200, marginPct: null });
  });
});

// ── 4. 汎用の試算・レイアウトとの分離 ─────────────────────────────
describe('レイアウト・汎用の試算の項目は、JCOS の収支に入らない（二重計上しない）', () => {
  // 汎用の項目をすべて入れた案件（固定売上・参加費・スタッフ配置・会場費・備品費）
  const partTypes = withParts({ 'pt-table': { unitCost: 500, costUnit: 'day' }, 'pt-chair': { unitCost: 100, costUnit: 'day' } });
  const data = mkData({ partTypes });
  const table = partTypes.find((t) => t.id === 'pt-table')!;
  const chair = partTypes.find((t) => t.id === 'pt-chair')!;
  const generic = mkProject({
    startDate: D5[0], endDate: D5[4], fixedRevenue: 400000, venueFeeFixed: 5000, venueFeePerDay: 20000, venueFeeRatePct: 10,
    contents: [mkContent({ plannedCount: 300, sparePct: 10 })],
    assignments: D5.map((d, i) => mkAssign({ id: `a${i}`, date: d })),
    otherCosts: [{ id: 'o1', name: '印刷費', amount: 12000 }],
  });
  const withLayout = { ...generic, layout: addPart(addPart(generic.layout, table), chair) };
  const jcos = { ...withLayout, jcos: terms() };

  it('JCOS 案件の請求・実費は、JCOS の条件・個数・その他実費だけで決まる', () => {
    const e = jcosEstimate(jcos);
    // 請求 200,000 ／ 実費 ＝ アルバイト 75,000 ＋ 材料 300×220＝66,000 ＋ その他実費 12,000
    expect(e.current).toMatchObject({ billing: 200000, partTimerCost: 75000, materialCost: 66000, otherCost: 12000, cost: 153000, gross: 47000 });
  });
  it('椅子・テーブルを増やしても減らしても、JCOS の粗利は変わらない（汎用の試算では備品費が変わる）', () => {
    const before = jcosEstimate(jcos).current;
    const more = { ...jcos, layout: addPart(addPart(addPart(jcos.layout, chair), chair), table) };
    const less = { ...jcos, layout: removeLastPart(jcos.layout, 'pt-table') };
    expect(jcosEstimate(more).current).toEqual(before);
    expect(jcosEstimate(less).current).toEqual(before);
    // 汎用の試算では、同じ操作で備品費と利益が変わる（＝分離できていることの対照）
    expect(estimate(more, data).partsCost).not.toBe(estimate(jcos, data).partsCost);
    expect(estimate(more, data).profit).not.toBe(estimate(jcos, data).profit);
  });
  it('固定売上・参加費・会場費・スタッフ配置・材料マスタ・予備率を変えても、JCOS の収支は変わらない', () => {
    const before = jcosEstimate(jcos).current;
    const changed: Project = {
      ...jcos, fixedRevenue: 0, venueFeeFixed: 99999, venueFeePerDay: 1, venueFeeRatePct: 50, assignments: [],
      contents: [mkContent({ plannedCount: 300, sparePct: 50, priceOverride: 1500 })],
    };
    expect(jcosEstimate(changed).current).toEqual(before);
  });
  it('JCOS の計算に入れていない汎用の項目は、金額つきで一覧にできる（黙って落とさない）', () => {
    const ex = jcosExcluded(estimate(jcos, data));
    expect(ex.map((x) => x.label)).toEqual(['固定売上', '参加費売上', 'スタッフ配置の人件費（時給・交通費）', 'コンテンツの材料マスタによる材料費', '会場費', '備品費（レイアウト連動）']);
    expect(ex.find((x) => x.label === '固定売上')!.amount).toBe(400000);
    expect(ex.find((x) => x.label === '備品費（レイアウト連動）')!.amount).toBe((500 + 100) * 5);
    // 0 円の項目は出さない
    expect(jcosExcluded(estimate(jp(), mkData()))).toEqual([]);
  });
  it('JCOS の項目を足しても、汎用の試算（estimate）の結果は 1 円も変わらない', () => {
    const e0 = estimate(withLayout, data);
    const e1 = estimate({ ...jcos, actualsManual: { [D5[0]]: 99 }, reportSync: sync(jcos, [[D5[1], 77]]), reportClaims: [D5[0]] }, data);
    expect(e1).toEqual(e0);
    const off = { ...jcos, jcos: { ...terms(), enabled: false } };
    expect(estimate(off, data)).toEqual(e0);
  });
  it('一覧・見出しの金額: JCOS 案件は 請求・実費・粗利、それ以外（切り替えを戻した案件を含む）は従来の 売上・費用・利益', () => {
    const e0 = estimate(withLayout, data);
    expect(projectMoney(withLayout, data)).toEqual({ jcos: false, revenue: e0.revenue, cost: e0.totalCost, profit: e0.profit });
    expect(projectMoney(jcos, data)).toEqual({ jcos: true, revenue: 200000, cost: 153000, profit: 47000 });
    const off = { ...jcos, jcos: { ...terms(), enabled: false } };
    expect(isJcos(off)).toBe(false);
    expect(projectMoney(off, data)).toEqual({ jcos: false, revenue: e0.revenue, cost: e0.totalCost, profit: e0.profit });
  });
  it('初期のパーツ（単価 0 円）でも、単価つきのパーツでも同じ（JCOS はパーツの単価を見ない）', () => {
    const a = jcosEstimate(jcos).current;
    const b = jcosEstimate({ ...jcos, layout: addPart(jcos.layout, defaultPartTypes()[0]) }).current;
    expect(b).toEqual(a);
  });
});

describe('案件の複製・サンプル', () => {
  it('複製すると、JCOS の条件（単価・追加の請求）と日報の場所は引き継ぎ、実績・日ごとの設定・割り当ての決定は引き継がない', () => {
    const src = jp({
      startDate: D5[0], endDate: D5[2],
      jcos: withJcosDay(terms({ unitCost: 250, extraBillings: [{ id: 'x', name: '予備費', amount: 5000 }] }), D5[1], { billed: false, partTimers: 2 }),
      actualsManual: { [D5[0]]: 40 }, reportClaims: [D5[1]], reportSource: { spreadsheetId: 'sheet-1', gid: 7 },
    });
    const copy = duplicateProject({ ...src, reportSync: sync(src, [[D5[0], 44]]) });
    expect(copy.jcos).toEqual({ ...terms({ unitCost: 250, extraBillings: [{ id: 'x', name: '予備費', amount: 5000 }] }), days: {} });
    expect(copy.reportSource).toEqual({ spreadsheetId: 'sheet-1', gid: 7 });
    expect('reportSync' in copy || 'actualsManual' in copy || 'reportClaims' in copy).toBe(false);
    expect(jcosEstimate(copy).basis).toBe('planned');
    // 汎用の案件の複製は、これまでどおり（JCOS の項目は増えない）
    expect('jcos' in duplicateProject(mkProject())).toBe(false);
  });
  it('サンプルの案件は、汎用の試算のまま（JCOS の計算を自動では適用しない）', () => {
    expect(sampleData().projects.map((p) => isJcos(p))).toEqual([false, false]);
    expect(isJcos(newProject())).toBe(false);
  });
});

describe('データが欠けていても落ちない', () => {
  it('jcos が無い案件・項目の欠けた jcos でも、標準の条件で計算する', () => {
    const p = mkProject({ startDate: D5[0], endDate: D5[0], contents: [mkContent({ plannedCount: 10 })] });
    expect(jcosEstimate(p).current).toMatchObject({ billing: 40000, partTimerCost: 15000, materialCost: 2200 });
    const partial = { ...p, jcos: { enabled: true } as unknown as JcosTerms };
    expect(jcosEstimate(partial).current).toMatchObject({ billing: 40000, partTimerCost: 15000, materialCost: 2200 });
  });
  it('会期が未入力の案件は、0 日として計算する（追加の請求・その他実費だけが残る）', () => {
    const p = jp({ startDate: '', endDate: '', jcos: terms({ extraBillings: [{ id: 'x', name: '予備費', amount: 5000 }] }), otherCosts: [{ id: 'o', name: '実費', amount: 2000 }] });
    const e = jcosEstimate(p);
    expect(e.days).toEqual([]);
    expect(e.current).toMatchObject({ billing: 5000, cost: 2000, gross: 3000 });
  });
});

// ── 5. 警告（JCOS 案件） ───────────────────────────────────────
describe('JCOS 案件の警告', () => {
  const data = mkData();
  const targets = (p: Project) => projectWarnings(p, { ...data, projects: [p] }).map((w) => w.target);
  // 汎用では警告・参考が出る状態: スタッフ配置なし・予定個数 0
  const bare = mkProject({ startDate: D5[0], endDate: D5[1], assignments: [], contents: [mkContent({ plannedCount: 0 })] });

  it('汎用の試算にだけ関係する確認（スタッフ配置が無い日・時給 0 円・材料の未登録）は、JCOS 案件では出さない', () => {
    expect(targets(bare)).toEqual(['pc:pc1:plannedCount', `day:${D5[0]}`, `day:${D5[1]}`]);
    expect(targets({ ...bare, jcos: terms() })).toEqual(['pc:pc1:plannedCount']);
    const zeroRate = mkProject({ assignments: [mkAssign({ rateOverride: 0 }), mkAssign({ id: 'a2', date: '2026-12-06' })] });
    expect(targets(zeroRate)).toContain('assign:a1:rate');
    expect(targets({ ...zeroRate, jcos: terms() })).not.toContain('assign:a1:rate');
    // 切り替えを戻した案件（enabled: false）は、汎用と同じ
    expect(targets({ ...bare, jcos: { ...terms(), enabled: false } })).toEqual(targets(bare));
  });
  it('予定個数 0 の説明は、JCOS 案件の計算に合わせる', () => {
    const msg = (p: Project) => projectWarnings(p, { ...data, projects: [p] }).find((w) => w.target === 'pc:pc1:plannedCount')!.message;
    expect(msg(bare)).toContain('材料費・売上が 0 で試算');
    expect(msg({ ...bare, jcos: terms() })).toContain('見込みの材料原価が 0 円');
  });
  it('材料原価が 0 円以下・金額がマイナスなら知らせる', () => {
    const ok = jp({ contents: [mkContent({ plannedCount: 10 })] });
    expect(targets(ok)).toEqual([]);
    expect(targets({ ...ok, jcos: terms({ unitCost: 0 }) })).toEqual(['jcos:unitCost']);
    expect(targets({ ...ok, jcos: terms({ partTimerPerDay: -1 }) })).toEqual(['jcos:terms']);
  });
  it('日報の同期で確認が必要なもの（会場・会期を変えた／保留の日／読み取れない回答／実績の無い日にある別の会場名の回答）', () => {
    const p = jp({ startDate: D5[0], endDate: D5[2], contents: [mkContent({ plannedCount: 30 })] });
    const base = sync(p, [[D5[0], 10]]);
    expect(targets({ ...p, reportSync: base })).toEqual([]);
    expect(targets({ ...p, venueId: 'v1', reportSync: { ...base, venueId: 'v-old' } })).toEqual(['report:stale']);
    expect(targets({ ...p, reportSync: { ...base, endDate: D5[4] } })).toEqual(['report:stale']);
    expect(targets({ ...p, reportSync: { ...base, held: [{ date: D5[1], count: 5, rows: 1, others: ['別の案件'] }] } })).toEqual(['report:held']);
    expect(targets({ ...p, reportSync: { ...base, skipped: [{ reason: 'bad-count', rows: 2, dates: [D5[1]] }] } })).toEqual(['report:skipped']);
    // 別の案件に割り当て済みの回答は、読み取れない回答としては数えない
    expect(targets({ ...p, reportSync: { ...base, skipped: [{ reason: 'other-project', rows: 2, dates: [D5[1]] }] } })).toEqual([]);
    const other = { venue: '別の書き方', rows: 1, count: 9, dates: [D5[1]] };
    const w = projectWarnings({ ...p, reportSync: { ...base, unmatched: [other] } }, { ...data, projects: [] });
    expect(w.map((x) => [x.target, x.severity])).toEqual([['report:unmatched', 'info']]);
    // 同期したあとで、同じ会場・重なる会期の案件が増えた日（決まっていない＝警告。相手が決めた＝参考）
    const rival = jp({ id: 'rival', name: '重なる案件', startDate: D5[0], endDate: D5[0] });
    const all = (r: Project) => projectWarnings({ ...p, reportSync: base }, { ...data, projects: [{ ...p, reportSync: base }, r] }).map((x) => [x.target, x.severity]);
    expect(all(rival)).toEqual([['report:contested', 'warn']]);
    expect(all({ ...rival, reportClaims: [D5[0]] })).toEqual([['report:assigned', 'info']]);
    expect(all({ ...rival, status: '中止' })).toEqual([]);
    // その日にこの案件の実績があれば、別の会場の回答があっても知らせない
    expect(targets({ ...p, reportSync: { ...base, unmatched: [{ ...other, dates: [D5[0]] }] } })).toEqual([]);
  });
});
