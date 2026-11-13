// JCOS 案件の収支（純関数）。請求（売上）と実費（こちらの支払い）を分けて計算する。
// 計算式は docs/02_新アプリ設計書.md「6. Version 4」と一致させること。
//
//   請求（売上） ＝ Σ 請求する日（人件費の請求 ＋ 材料費の請求）＋ 追加の請求（予備費など）
//   実費         ＝ Σ 日（アルバイト代 × その日の人数 ＋ 材料原価 × その日の個数）＋ その他実費
//   粗利（管理上）＝ 請求 計 − 実費 計
//
// 個数は、実績（日報の同期。無ければ手入力）がある日は実績、無い日は予定（会期合計の予定個数を日数で均等割り）を使う。
// 汎用の試算の項目（固定売上・参加費売上・スタッフ配置の人件費・材料マスタの材料費・会場費・レイアウト連動の備品費）は、
// ここには入れない（二重計上を防ぐ。レイアウトのパーツを増減しても、JCOS の粗利は変わらない）。
import { AppData, JcosDay, JcosTerms, Project } from '../types';
import { Estimate, estimate } from './calc';
import { ReportContext, usableReportDays } from './report';
import { listDates, num, roundYen } from './util';

/** JCOS 案件の標準の条件（2026-11 時点。案件ごとに変えられる初期値） */
export const JCOS_DEFAULTS = {
  billLaborPerDay: 30000,
  billMaterialPerDay: 10000,
  partTimerPerDay: 15000,
  unitCost: 220,
} as const;

export function defaultJcos(): JcosTerms {
  return { enabled: true, ...JCOS_DEFAULTS, extraBillings: [], days: {} };
}

/**
 * 保存されていた JCOS の条件を、画面が前提にしている形にそろえる（欠けた金額は標準の値、欠けた一覧は空にする）。
 * 条件として扱えないもの（オブジェクトでない）は undefined。
 */
export function hydrateJcos(v: unknown): JcosTerms | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  const amount = (key: keyof typeof JCOS_DEFAULTS): number => (typeof t[key] === 'number' && Number.isFinite(t[key] as number) ? (t[key] as number) : JCOS_DEFAULTS[key]);
  const days: Record<string, JcosDay> = {};
  if (t.days && typeof t.days === 'object' && !Array.isArray(t.days)) {
    for (const [date, d] of Object.entries(t.days as Record<string, unknown>)) {
      if (!d || typeof d !== 'object') continue;
      const src = d as Record<string, unknown>;
      const day: JcosDay = {};
      if (src.billed === false) day.billed = false;
      if (typeof src.partTimers === 'number' && Number.isFinite(src.partTimers)) day.partTimers = Math.max(0, src.partTimers);
      if (Object.keys(day).length > 0) days[date] = day;
    }
  }
  return {
    enabled: t.enabled === true,
    billLaborPerDay: amount('billLaborPerDay'),
    billMaterialPerDay: amount('billMaterialPerDay'),
    partTimerPerDay: amount('partTimerPerDay'),
    unitCost: amount('unitCost'),
    extraBillings: (Array.isArray(t.extraBillings) ? t.extraBillings : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o, i) => ({ id: typeof o.id === 'string' && o.id ? o.id : `extra-${i}`, name: typeof o.name === 'string' ? o.name : '', amount: num(o.amount) })),
    days,
  };
}

/** JCOS の収支計算を使う案件か */
export const isJcos = (p: Pick<Project, 'jcos'>): boolean => !!p.jcos?.enabled;

/** その日の設定（無い日は、請求する・アルバイト 1 人） */
export function jcosDay(terms: JcosTerms | undefined, date: string): Required<JcosDay> {
  const d = terms?.days?.[date];
  return {
    billed: d?.billed !== false,
    partTimers: d?.partTimers == null ? 1 : Math.max(0, num(d.partTimers)),
  };
}

/** 日ごとの設定を変える。既定と同じになった項目は持たない（データを増やさない） */
export function withJcosDay(terms: JcosTerms, date: string, patch: JcosDay): JcosTerms {
  const cur = jcosDay(terms, date);
  const next = { ...cur, ...patch };
  const out: JcosDay = {};
  if (next.billed === false) out.billed = false;
  if (num(next.partTimers) !== 1) out.partTimers = Math.max(0, num(next.partTimers));
  const days = { ...(terms.days ?? {}) };
  if (Object.keys(out).length === 0) delete days[date];
  else days[date] = out;
  return { ...terms, days };
}

/** 会期合計の個数を、日数で均等に割る（整数なら、端数を前の日から 1 個ずつ配る。合計は必ず元の個数と一致する） */
export function splitEvenly(total: number, days: number): number[] {
  if (days <= 0) return [];
  const t = Math.max(0, num(total));
  if (!Number.isInteger(t)) return Array.from({ length: days }, () => t / days);
  const base = Math.floor(t / days);
  const rest = t - base * days;
  return Array.from({ length: days }, (_, i) => base + (i < rest ? 1 : 0));
}

export interface Actual {
  count: number;
  /** report＝日報の同期 ／ manual＝手入力 */
  source: 'report' | 'manual';
  /** 日報の回答の数（source が report のとき） */
  rows: number;
}

/** 手入力の実績（0 以上の数だけを有効とする） */
function manualActual(p: Project, date: string): number | null {
  const v = p.actualsManual?.[date];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 日ごとの実績。日報の実績がある日は日報、無ければ手入力。どちらも無い日は入らない。
 * ctx（いまの案件と会場の一覧）を渡すと、会期が重なる案件があって、この案件のものと決まっていない日の日報の実績は使わない（report.ts の usableReportDays）。
 */
export function actualsByDate(p: Project, ctx?: ReportContext): Map<string, Actual> {
  const out = new Map<string, Actual>();
  const report = usableReportDays(p, ctx);
  for (const date of listDates(p.startDate, p.endDate)) {
    const r = report.get(date);
    if (r) { out.set(date, { count: Math.max(0, num(r.count)), source: 'report', rows: num(r.rows) }); continue; }
    const m = manualActual(p, date);
    if (m != null) out.set(date, { count: m, source: 'manual', rows: 0 });
  }
  return out;
}

export interface JcosDayLine {
  date: string;
  billed: boolean;
  billLabor: number;
  billMaterial: number;
  /** その日の請求 ＝ 人件費の請求 ＋ 材料費の請求（請求しない日は 0） */
  billing: number;
  partTimers: number;
  partTimerCost: number;
  /** 予定個数（会期合計の均等割り） */
  plannedCount: number;
  actual: Actual | null;
  /** 日報の実績があるために使っていない、手入力の値（無ければ null） */
  manualIgnored: number | null;
  /** 計算に使った個数（実績があれば実績、無ければ予定） */
  count: number;
  basis: 'actual' | 'planned';
  materialCost: number;
  /** その日の材料原価が、その日の材料費の請求を超えた額（超えていなければ 0） */
  materialOver: number;
  cost: number;
  /** その日の粗利 ＝ 請求 − アルバイト代 − 材料原価 */
  gross: number;
}

export interface JcosTotals {
  billLabor: number;
  billMaterial: number;
  extraBilling: number;
  billing: number;
  partTimerCost: number;
  materialCost: number;
  otherCost: number;
  cost: number;
  gross: number;
  /** 粗利率（%）＝ 粗利 ÷ 請求 計。請求が 0 以下のときは null */
  marginPct: number | null;
  count: number;
  /** 材料原価の合計が、材料費の請求の合計を超えた額（超えていなければ 0）＝ 自己負担になる額 */
  materialOver: number;
}

export interface JcosEstimate {
  terms: JcosTerms;
  days: JcosDayLine[];
  periodDays: number;
  /** 請求対象日数 */
  billDays: number;
  /** アルバイトの稼働（人日）。請求対象日数とは別に数える */
  partTimerDays: number;
  plannedCount: number;
  /** 実績のある日の個数の合計・日数 */
  actualCount: number;
  actualDays: number;
  /** actual＝全日が実績 ／ mixed＝一部が実績 ／ planned＝実績なし */
  basis: 'actual' | 'mixed' | 'planned';
  /** 実績がある日は実績、無い日は予定で計算した会期全体（画面の主な表示） */
  current: JcosTotals;
  /** すべての日を予定個数で計算した会期全体 */
  planned: JcosTotals;
  /** 実績のある日だけの小計（請求・アルバイト代・材料原価。追加の請求・その他実費は入れない） */
  reported: { days: number; count: number; billing: number; cost: number; gross: number };
}

const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);

function totals(lines: JcosDayLine[], counts: number[], unitCost: number, extraBilling: number, otherCost: number): JcosTotals {
  const billLabor = sum(lines, (l) => l.billLabor);
  const billMaterial = sum(lines, (l) => l.billMaterial);
  const billing = billLabor + billMaterial + extraBilling;
  const partTimerCost = sum(lines, (l) => l.partTimerCost);
  // 材料原価は日ごとに円未満を四捨五入し、会期の合計は日別の合計とする（日別の表を足すと、必ず合計と一致する）
  const materialCost = sum(counts, (c) => roundYen(c * unitCost));
  const cost = partTimerCost + materialCost + otherCost;
  const gross = billing - cost;
  return {
    billLabor, billMaterial, extraBilling, billing, partTimerCost, materialCost, otherCost, cost, gross,
    marginPct: billing > 0 ? (gross / billing) * 100 : null,
    count: sum(counts, (c) => c),
    materialOver: Math.max(0, materialCost - billMaterial),
  };
}

/**
 * JCOS 案件の収支。p.jcos が無い案件でも、標準の条件で計算する（画面は isJcos のときだけ使う）。
 * 画面からは、ctx（いまの案件と会場の一覧）を必ず渡す（同じ回答を 2 つの案件で数えないため。actualsByDate を参照）。
 */
export function jcosEstimate(p: Project, ctx?: ReportContext): JcosEstimate {
  const terms: JcosTerms = { ...defaultJcos(), ...(p.jcos ?? {}), extraBillings: p.jcos?.extraBillings ?? [], days: p.jcos?.days ?? {} };
  const dates = listDates(p.startDate, p.endDate);
  const unit = Math.max(0, num(terms.unitCost));
  const plannedCount = sum(p.contents ?? [], (c) => Math.max(0, num(c.plannedCount)));
  const plan = splitEvenly(plannedCount, dates.length);
  const actuals = actualsByDate(p, ctx);

  const days: JcosDayLine[] = dates.map((date, i) => {
    const d = jcosDay(terms, date);
    const billLabor = d.billed ? num(terms.billLaborPerDay) : 0;
    const billMaterial = d.billed ? num(terms.billMaterialPerDay) : 0;
    const partTimerCost = roundYen(d.partTimers * num(terms.partTimerPerDay));
    const actual = actuals.get(date) ?? null;
    const manual = manualActual(p, date);
    const count = actual ? actual.count : plan[i];
    const materialCost = roundYen(count * unit);
    const billing = billLabor + billMaterial;
    const cost = partTimerCost + materialCost;
    return {
      date, billed: d.billed, billLabor, billMaterial, billing,
      partTimers: d.partTimers, partTimerCost,
      plannedCount: plan[i], actual,
      manualIgnored: actual?.source === 'report' && manual != null && manual !== actual.count ? manual : null,
      count, basis: actual ? 'actual' : 'planned',
      materialCost, materialOver: Math.max(0, materialCost - billMaterial),
      cost, gross: billing - cost,
    };
  });

  const extraBilling = sum(terms.extraBillings ?? [], (o) => num(o.amount));
  const otherCost = sum(p.otherCosts ?? [], (o) => num(o.amount));
  const withActual = days.filter((l) => l.actual);
  return {
    terms,
    days,
    periodDays: dates.length,
    billDays: days.filter((l) => l.billed).length,
    partTimerDays: sum(days, (l) => l.partTimers),
    plannedCount,
    actualCount: sum(withActual, (l) => l.count),
    actualDays: withActual.length,
    basis: withActual.length === 0 ? 'planned' : withActual.length === days.length ? 'actual' : 'mixed',
    current: totals(days, days.map((l) => l.count), unit, extraBilling, otherCost),
    planned: totals(days, plan, unit, extraBilling, otherCost),
    reported: {
      days: withActual.length,
      count: sum(withActual, (l) => l.count),
      billing: sum(withActual, (l) => l.billing),
      cost: sum(withActual, (l) => l.cost),
      gross: sum(withActual, (l) => l.gross),
    },
  };
}

/** 汎用の試算の項目のうち、JCOS の収支に入れていないもの（金額が 0 でないものだけ）。入力値は消さずに残してある */
export function jcosExcluded(est: Estimate): { label: string; amount: number }[] {
  return [
    { label: '固定売上', amount: est.fixedRevenue },
    { label: '参加費売上', amount: est.participationRevenue },
    { label: 'スタッフ配置の人件費（時給・交通費）', amount: est.laborCost },
    { label: 'コンテンツの材料マスタによる材料費', amount: est.materialCost },
    { label: '会場費', amount: est.venueFee },
    { label: '備品費（レイアウト連動）', amount: est.partsCost },
  ].filter((x) => x.amount !== 0);
}

/** 一覧・見出しに出す金額（JCOS 案件は 請求・実費・粗利、それ以外は従来の 売上・費用・利益） */
export interface Money { jcos: boolean; revenue: number; cost: number; profit: number }
export function projectMoney(
  p: Project, data: Pick<AppData, 'staff' | 'contents' | 'partTypes'> & Partial<ReportContext>, generic?: Estimate,
): Money {
  if (isJcos(p)) {
    const ctx = data.projects && data.venues ? { projects: data.projects, venues: data.venues } : undefined;
    const t = jcosEstimate(p, ctx).current;
    return { jcos: true, revenue: t.billing, cost: t.cost, profit: t.gross };
  }
  const e = generic ?? estimate(p, data);
  return { jcos: false, revenue: e.revenue, cost: e.totalCost, profit: e.profit };
}
