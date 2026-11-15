// JCOS 案件の収支（純関数）。請求（売上）と実費（こちらの支払い）を分けて計算する。
// 計算式は docs/02_新アプリ設計書.md「6. Version 4」と一致させること。
//
//   請求（売上） ＝ Σ 請求する日（人件費の請求 ＋ 材料費の請求）＋ 追加の請求（予備費など）
//   実費         ＝ Σ 日（アルバイト代 × その日に配置した人数 ＋ Σ 内容（材料原価 × その日の個数））＋ その他実費
//   粗利（管理上）＝ 請求 計 − 実費 計
//
// アルバイト代は、配置した日・人数だけ計上する（人数を入れていない日は 0 人＝未配置。自動では計上しない。オーナーの判断 2026-11-15）。
// 材料原価は、内容（日報の「イベント内容」・実施コンテンツの名前）ごとに変えられる。指定の無い内容と、内容の分からない個数は、
// 案件の標準（初期値 220 円＝フラワーボトルの初期値）を使う。円未満の四捨五入は、日ごとに、同じ原価の個数をまとめてから行う
// （内容ごとの指定が無ければ、その日の個数 × 標準を四捨五入する＝内容で分ける前と、同じ金額になる）。
// 個数は、実績（日報の同期。無ければ手入力）がある日は実績、無い日は予定（会期合計の予定個数を日数で均等割り）を使う。
// 汎用の試算の項目（固定売上・参加費売上・スタッフ配置の人件費・材料マスタの材料費・会場費・レイアウト連動の備品費）は、
// ここには入れない（二重計上を防ぐ。レイアウトのパーツを増減しても、JCOS の粗利は変わらない）。
import { AppData, Content, JcosDay, JcosTerms, Project, ReportDayContent } from '../types';
import { Estimate, estimate } from './calc';
import { ReportContext, contentKey, usableReportDays } from './report';
import { listDates, num, roundYen } from './util';

/**
 * JCOS 案件の標準の条件（2026-11 時点。案件ごとに変えられる初期値）。
 * unitCost の 220 円は、フラワーボトルの初期値（内容ごとに変えられる。JcosTerms.unitCosts）。
 */
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
      if (src.notHeld === true) day.notHeld = true;
      if (Object.keys(day).length > 0) days[date] = day;
    }
  }
  // 内容ごとの材料原価: 0 以上の数だけを残す（キーが空のもの・数でないものは外す）
  const unitCosts: Record<string, number> = {};
  if (t.unitCosts && typeof t.unitCosts === 'object' && !Array.isArray(t.unitCosts)) {
    for (const [key, cost] of Object.entries(t.unitCosts as Record<string, unknown>)) {
      if (key && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) unitCosts[key] = cost;
    }
  }
  return {
    enabled: t.enabled === true,
    billLaborPerDay: amount('billLaborPerDay'),
    billMaterialPerDay: amount('billMaterialPerDay'),
    partTimerPerDay: amount('partTimerPerDay'),
    unitCost: amount('unitCost'),
    ...(Object.keys(unitCosts).length > 0 ? { unitCosts } : {}),
    extraBillings: (Array.isArray(t.extraBillings) ? t.extraBillings : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o, i) => ({ id: typeof o.id === 'string' && o.id ? o.id : `extra-${i}`, name: typeof o.name === 'string' ? o.name : '', amount: num(o.amount) })),
    days,
  };
}

/** JCOS の収支計算を使う案件か */
export const isJcos = (p: Pick<Project, 'jcos'>): boolean => !!p.jcos?.enabled;

/**
 * その日の設定（無い日は、請求する・アルバイト 0 人＝未配置）。開催していない日は、請求しない・アルバイト 0 人。
 * アルバイト代は、人数を入れた日だけ計上する（入れていない日に、自動では計上しない）。
 */
export function jcosDay(terms: JcosTerms | undefined, date: string): Required<JcosDay> {
  const d = terms?.days?.[date];
  if (d?.notHeld === true) return { billed: false, partTimers: 0, notHeld: true };
  return {
    billed: d?.billed !== false,
    partTimers: d?.partTimers == null ? 0 : Math.max(0, num(d.partTimers)),
    notHeld: false,
  };
}

/**
 * 日ごとの設定を変える。既定と同じになった項目は持たない（データを増やさない）。
 * 利用者が変えた日は、「開催していない日」の印を外す（請求する・アルバイトの人数を入れた＝開催した日として扱う）。
 */
export function withJcosDay(terms: JcosTerms, date: string, patch: JcosDay): JcosTerms {
  const cur = jcosDay(terms, date);
  const next = { ...cur, ...patch };
  const out: JcosDay = {};
  if (next.billed === false) out.billed = false;
  if (num(next.partTimers) > 0) out.partTimers = num(next.partTimers);
  const days = { ...(terms.days ?? {}) };
  if (Object.keys(out).length === 0) delete days[date];
  else days[date] = out;
  return { ...terms, days };
}

/**
 * 開催していない日（日報に合わせて会期を広げた・離れた開催をまとめたとき、回答の無かった日）の印を付ける。
 * その日は、請求しない・アルバイト 0 人・予定個数を割り振らない。
 * 利用者がすでに設定している日は、変えない（手で決めた内容を上書きしない）。
 */
export function markNotHeld(terms: JcosTerms, dates: string[]): JcosTerms {
  const days = { ...(terms.days ?? {}) };
  let changed = false;
  for (const date of dates) {
    if (days[date]) continue;
    days[date] = { billed: false, partTimers: 0, notHeld: true };
    changed = true;
  }
  return changed ? { ...terms, days } : terms;
}

/**
 * 「開催していない日」の印を、その日の回答が日報に入ったときに外す（既定の「請求する・アルバイト 0 人（未配置）」に戻る）。
 * 印の無い日（利用者が決めた設定）は、変えない。
 */
export function clearNotHeld(terms: JcosTerms, dates: string[]): JcosTerms {
  const cur = terms.days ?? {};
  const hit = dates.filter((d) => cur[d]?.notHeld === true);
  if (hit.length === 0) return terms;
  const days = { ...cur };
  for (const d of hit) delete days[d];
  return { ...terms, days };
}

/**
 * 指定した日に、アルバイトを n 人ずつ配置する（試算の「開催する日すべてに 1 人ずつ入れる」）。
 * すでに配置のある日と、「開催していない日」は、変えない（利用者が入れた人数を上書きしない・開催していない日に、アルバイト代を付けない）。
 */
export function staffDays(terms: JcosTerms, dates: string[], n = 1): JcosTerms {
  return dates.reduce((t, date) => {
    const d = jcosDay(t, date);
    return d.notHeld || d.partTimers > 0 ? t : withJcosDay(t, date, { partTimers: n });
  }, terms);
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
  /** 日報の参加組数・参加人数（入力のあった回答の合計。どの回答も未入力なら undefined）と、未入力だった回答の数 */
  groups?: number;
  groupsBlank?: number;
  people?: number;
  peopleBlank?: number;
  /** 内容ごとの個数（日報の「イベント内容」に記載があった回答だけ）。無ければ、内容の分からない個数として扱う（手入力・以前の版で同期した実績） */
  contents?: ReportDayContent[];
}

/** JCOS の計算に渡す、いまのデータ（案件と会場の一覧。実施コンテンツの名前を引くために、コンテンツの一覧も渡せる） */
export type JcosContext = ReportContext & { contents?: Pick<Content, 'id' | 'name'>[] };

// ── 内容ごとの材料原価 ─────────────────────────────────────────
/** 材料原価の 1 行（内容ごと）。key が '' の行は、内容の分からない個数（案件の標準の原価を使う） */
export interface JcosMaterial {
  key: string;
  /** 表示用の名前（日報での書き方・実施コンテンツの名前。内容の分からない個数は ''） */
  label: string;
  count: number;
  unitCost: number;
  /** 個数 × 原価（円未満を四捨五入） */
  cost: number;
}

/** その内容の原価を、案件で決めているか（オブジェクトがもともと持つ名前——constructor など——を、指定と取り違えない） */
const hasUnitCost = (terms: Pick<JcosTerms, 'unitCosts'>, key: string): boolean =>
  !!key && !!terms.unitCosts && Object.prototype.hasOwnProperty.call(terms.unitCosts, key);

/** 内容ごとの材料原価（円／個）。指定の無い内容と、内容の分からない個数（key が ''）は、案件の標準 */
export function unitCostOf(terms: Pick<JcosTerms, 'unitCost' | 'unitCosts'>, key: string): number {
  const own = hasUnitCost(terms, key) ? terms.unitCosts![key] : undefined;
  return Math.max(0, num(typeof own === 'number' && Number.isFinite(own) ? own : terms.unitCost));
}

/**
 * 内容ごとの材料原価を変える。value が null（空欄）なら、その内容の指定を外して、案件の標準に戻す。
 * key が '' のときは、案件の標準そのものを変える（null なら、変えない）。
 */
export function withUnitCost(terms: JcosTerms, key: string, value: number | null): JcosTerms {
  const ok = value != null && Number.isFinite(value) && value >= 0;
  if (!key) return ok ? { ...terms, unitCost: value } : terms;
  const next = { ...(terms.unitCosts ?? {}) };
  if (ok) next[key] = value; else delete next[key];
  const { unitCosts: _before, ...rest } = terms;
  return Object.keys(next).length > 0 ? { ...rest, unitCosts: next } : rest;
}

/** 1 日分の個数を、内容ごとに分けたもの（原価を付ける前） */
interface Bucket { key: string; label: string; count: number }

/**
 * 実績 1 日分を、内容ごとに分ける。内容の記載が無かった分（合計との差）と、内訳の無い実績（手入力・以前の版の同期）は、
 * 内容の分からない個数（key が ''）にする。内訳の合計が、その日の個数を超えているとき（保存データの不整合）は、内訳を使わない。
 */
function actualBuckets(a: Actual): Bucket[] {
  const out: Bucket[] = [];
  for (const c of a.contents ?? []) {
    const key = contentKey(c.label);
    const n = Math.max(0, num(c.count));
    if (!key || n <= 0) continue;
    const hit = out.find((b) => b.key === key);
    if (hit) hit.count += n; else out.push({ key, label: c.label, count: n });
  }
  const known = out.reduce((s, b) => s + b.count, 0);
  if (known > a.count) return a.count > 0 ? [{ key: '', label: '', count: a.count }] : [];
  if (a.count - known > 0) out.push({ key: '', label: '', count: a.count - known });
  return out;
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
    if (r) {
      out.set(date, {
        count: Math.max(0, num(r.count)), source: 'report', rows: num(r.rows),
        ...(r.groups !== undefined ? { groups: num(r.groups) } : {}), ...(r.groupsBlank ? { groupsBlank: num(r.groupsBlank) } : {}),
        ...(r.people !== undefined ? { people: num(r.people) } : {}), ...(r.peopleBlank ? { peopleBlank: num(r.peopleBlank) } : {}),
        ...(r.contents && r.contents.length > 0 ? { contents: r.contents } : {}),
      });
      continue;
    }
    const m = manualActual(p, date);
    if (m != null) out.set(date, { count: m, source: 'manual', rows: 0 });
  }
  return out;
}

export interface JcosDayLine {
  date: string;
  /** 開催していない日（請求しない・アルバイト 0 人・予定個数 0。実績が無くても「予定で計算した日」には数えない） */
  notHeld: boolean;
  billed: boolean;
  billLabor: number;
  billMaterial: number;
  /** その日の請求 ＝ 人件費の請求 ＋ 材料費の請求（請求しない日は 0） */
  billing: number;
  partTimers: number;
  partTimerCost: number;
  /** 予定個数（会期合計を、開催する日で均等に割ったもの。開催していない日は 0） */
  plannedCount: number;
  actual: Actual | null;
  /** 日報の実績があるために使っていない、手入力の値（無ければ null） */
  manualIgnored: number | null;
  /** 計算に使った個数（実績があれば実績、無ければ予定） */
  count: number;
  basis: 'actual' | 'planned';
  /** 計算に使った個数の、内容ごとの内訳（原価つき）。合計が materialCost */
  materials: JcosMaterial[];
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
  /** 会期のうち、開催する日の数（「開催していない日」を除く。実績が要るのは、この日数） */
  heldDays: number;
  /** 請求対象日数 */
  billDays: number;
  /** アルバイトの稼働（人日）。請求対象日数とは別に数える */
  partTimerDays: number;
  /**
   * 開催する日があるのに、アルバイトを 1 日も配置していない（＝アルバイト代を 0 円で計算している）。
   * 粗利を、確定した実績と取り違えないよう、金額のそばに出す（一覧・見出し・試算で、同じ条件を使う）
   */
  noStaff: boolean;
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
  /**
   * 日報の参加組数・参加人数（日報の実績がある日の合計）。
   * total … 入力のあった分の合計（1 日も入力が無ければ null）／missingDays … 日報の実績はあるが、未入力の回答がある（または全部が未入力の）日数
   */
  participants: { reportDays: number; groups: Tally; people: Tally };
  /**
   * 手入力の実績個数と、日報の個数が違う日（競合）。計算には日報を使い、手入力の値は消さずに残している。
   * どちらが正しいかは、利用者が確かめる（日報が違っていれば、日報を直して同期し直す）。
   */
  conflicts: { date: string; manual: number; report: number }[];
  /**
   * 材料原価の、内容ごとの内訳（いまの計算＝実績のある日は実績、無い日は予定）。個数のある内容（多い順）→ 個数が 0 の内容（予定の内容・原価を決めてある内容）
   * → 内容の分からない個数（key が ''）の順。金額の合計は、日別の材料原価の合計と一致する。
   */
  materials: JcosMaterialSummary[];
  /** 個数のある行が、どれも同じ原価か（同じなら、その原価。個数が無ければ、案件の標準）。違う原価が混ざっていれば null */
  uniformUnitCost: number | null;
}
export interface Tally { total: number | null; missingDays: number }
export interface JcosMaterialSummary extends JcosMaterial {
  /** 実績のある日の個数・予定で計算した日の個数（合わせて count） */
  actualCount: number;
  plannedCount: number;
  /** この内容の原価を、案件で決めているか（false なら、案件の標準を使っている） */
  custom: boolean;
}
/*
 * 内訳には、いまの計算で個数が 0 の内容も入れる（個数 0・金額 0 の行）:
 *   - 実施コンテンツ（予定）の内容 … すべての日に実績が入ると、予定の個数は使われなくなるが、原価は「予定だけで計算した粗利」に効く
 *   - 原価を決めてある内容 … 日報の書き方が変わるなどして個数が無くなっても、決めた原価を見られる・外せるようにする
 */

const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);

/** 日報の実績がある日の、参加組数（または参加人数）の合計と、未入力のある日数 */
function tally(actuals: Actual[], value: (a: Actual) => number | undefined, blank: (a: Actual) => number | undefined): Tally {
  const have = actuals.filter((a) => value(a) !== undefined);
  return {
    total: have.length > 0 ? sum(have, (a) => value(a)!) : null,
    missingDays: actuals.filter((a) => value(a) === undefined || num(blank(a)) > 0).length,
  };
}

/** materialCosts・counts は、日ごとの材料原価（内容ごとに四捨五入して足したもの）と、個数 */
function totals(lines: JcosDayLine[], materialCosts: number[], counts: number[], extraBilling: number, otherCost: number): JcosTotals {
  const billLabor = sum(lines, (l) => l.billLabor);
  const billMaterial = sum(lines, (l) => l.billMaterial);
  const billing = billLabor + billMaterial + extraBilling;
  const partTimerCost = sum(lines, (l) => l.partTimerCost);
  // 材料原価は、日ごと・内容ごとに円未満を四捨五入し、会期の合計は日別の合計とする（日別の表を足すと、必ず合計と一致する）
  const materialCost = sum(materialCosts, (c) => c);
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
export function jcosEstimate(p: Project, ctx?: JcosContext): JcosEstimate {
  const terms: JcosTerms = { ...defaultJcos(), ...(p.jcos ?? {}), extraBillings: p.jcos?.extraBillings ?? [], days: p.jcos?.days ?? {} };
  const dates = listDates(p.startDate, p.endDate);
  /**
   * 1 日分の内訳に、原価と金額を付ける。円未満の四捨五入は、同じ原価の個数をまとめてから行う
   * （内容ごとの指定が無ければ、その日の個数 × 標準を四捨五入する＝内容で分ける前と、同じ金額になる）。
   * 行ごとの金額は、まとめて四捨五入した金額に合うように配る（円未満を切り捨てた額に、端数の大きい行から 1 円ずつ足す。内訳を足すと、必ず合計と一致する）。
   */
  const price = (bs: Bucket[]): JcosMaterial[] => {
    const rows = bs.map((b) => ({ ...b, unitCost: unitCostOf(terms, b.key), cost: 0 }));
    for (const unitCost of new Set(rows.map((r) => r.unitCost))) {
      const group = rows.filter((r) => r.unitCost === unitCost);
      const total = roundYen(sum(group, (r) => r.count) * unitCost);
      const parts = group.map((r) => { const exact = Number((r.count * unitCost).toFixed(6)); const floor = Math.floor(exact); return { r, floor, frac: exact - floor }; });
      let rest = total - sum(parts, (x) => x.floor);
      for (const x of parts) x.r.cost = x.floor;
      for (const x of [...parts].sort((a, b) => b.frac - a.frac)) {
        if (rest <= 0) break;
        x.r.cost += 1;
        rest -= 1;
      }
    }
    return rows;
  };

  // 予定個数は、内容（実施コンテンツ）ごとに、開催する日だけで均等に割る（開催していない日には、割り振らない）。
  // 実施コンテンツの名前が分からないとき（コンテンツの一覧を渡していない・マスタから消えている）は、内容の分からない個数としてまとめる
  const settings = dates.map((date) => jcosDay(terms, date));
  const heldCount = settings.filter((d) => !d.notHeld).length;
  const plannedLines: { key: string; label: string; total: number; share: number[] }[] = [];
  for (const c of p.contents ?? []) {
    const total = Math.max(0, num(c.plannedCount));
    if (total <= 0) continue;
    const label = (ctx?.contents?.find((m) => m.id === c.contentId)?.name ?? '').trim();
    const key = contentKey(label);
    const hit = plannedLines.find((l) => l.key === key);
    if (hit) hit.total += total; else plannedLines.push({ key, label: key ? label : '', total, share: [] });
  }
  // 内容ごとに均等に割る。端数（余り）は、前の内容が配り終えた次の日から配る
  // （日ごとの合計が、全体をまとめて割ったとき＝内容で分ける前と同じになる。内容ごとに初日から配ると、初めの日に寄ってしまう）
  let offset = 0;
  for (const l of plannedLines) {
    const even = splitEvenly(l.total, heldCount);
    l.share = even.map((_, h) => even[(h - offset + heldCount) % heldCount]);
    if (heldCount > 0 && Number.isInteger(l.total)) offset = (offset + (l.total % heldCount)) % heldCount;
  }
  const plannedCount = sum(plannedLines, (l) => l.total);
  let held = 0;
  const planBuckets: Bucket[][] = settings.map((d) => {
    if (d.notHeld) return [];
    const h = held++;
    return plannedLines.map((l) => ({ key: l.key, label: l.label, count: l.share[h] })).filter((b) => b.count > 0);
  });
  const plan = planBuckets.map((bs) => sum(bs, (b) => b.count));
  const planMaterials = planBuckets.map(price);
  const actuals = actualsByDate(p, ctx);

  const days: JcosDayLine[] = dates.map((date, i) => {
    const d = settings[i];
    const billLabor = d.billed ? num(terms.billLaborPerDay) : 0;
    const billMaterial = d.billed ? num(terms.billMaterialPerDay) : 0;
    const partTimerCost = roundYen(d.partTimers * num(terms.partTimerPerDay));
    const actual = actuals.get(date) ?? null;
    const manual = manualActual(p, date);
    const count = actual ? actual.count : plan[i];
    const materials = actual ? price(actualBuckets(actual)) : planMaterials[i];
    const materialCost = sum(materials, (m) => m.cost);
    const billing = billLabor + billMaterial;
    const cost = partTimerCost + materialCost;
    return {
      date, notHeld: d.notHeld, billed: d.billed, billLabor, billMaterial, billing,
      partTimers: d.partTimers, partTimerCost,
      plannedCount: plan[i], actual,
      manualIgnored: actual?.source === 'report' && manual != null && manual !== actual.count ? manual : null,
      count, basis: actual ? 'actual' : 'planned',
      materials, materialCost, materialOver: Math.max(0, materialCost - billMaterial),
      cost, gross: billing - cost,
    };
  });

  const extraBilling = sum(terms.extraBillings ?? [], (o) => num(o.amount));
  const otherCost = sum(p.otherCosts ?? [], (o) => num(o.amount));
  const withActual = days.filter((l) => l.actual);
  // 実績が要る日（開催していない日は、実績が無くてよい。開催していない日に実績が入っているときは、その日も数える）
  const need = days.filter((l) => !l.notHeld || l.actual);
  const fromReport = days.flatMap((l) => (l.actual?.source === 'report' ? [l.actual] : []));

  // 材料原価の内訳（内容ごと）。日別の行を、そのまま足す
  const byKey = new Map<string, JcosMaterialSummary>();
  const row = (key: string, label: string): JcosMaterialSummary => {
    let e = byKey.get(key);
    if (!e) { e = { key, label, count: 0, unitCost: unitCostOf(terms, key), cost: 0, actualCount: 0, plannedCount: 0, custom: hasUnitCost(terms, key) }; byKey.set(key, e); }
    return e;
  };
  for (const l of days) {
    for (const m of l.materials) {
      const e = row(m.key, m.label);
      e.count += m.count;
      e.cost += m.cost;
      if (l.actual) e.actualCount += m.count; else e.plannedCount += m.count;
    }
  }
  // 個数が 0 でも出す行: 実施コンテンツ（予定）の内容と、原価を決めてある内容（名前が分からなければ、キーを名前の代わりにする）
  for (const l of plannedLines) if (l.key) row(l.key, l.label);
  for (const key of Object.keys(terms.unitCosts ?? {})) if (key) row(key, key);
  const materials = [...byKey.values()].sort((a, b) =>
    Number(!a.key) - Number(!b.key) || Number(a.count <= 0) - Number(b.count <= 0) || b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const units = new Set(materials.filter((m) => m.count > 0).map((m) => m.unitCost));

  return {
    terms,
    days,
    periodDays: dates.length,
    heldDays: need.length,
    billDays: days.filter((l) => l.billed).length,
    partTimerDays: sum(days, (l) => l.partTimers),
    noStaff: need.length > 0 && sum(days, (l) => l.partTimers) === 0,
    plannedCount,
    actualCount: sum(withActual, (l) => l.count),
    actualDays: withActual.length,
    basis: withActual.length === 0 ? 'planned' : need.every((l) => l.actual) ? 'actual' : 'mixed',
    current: totals(days, days.map((l) => l.materialCost), days.map((l) => l.count), extraBilling, otherCost),
    planned: totals(days, planMaterials.map((ms) => sum(ms, (m) => m.cost)), plan, extraBilling, otherCost),
    reported: {
      days: withActual.length,
      count: sum(withActual, (l) => l.count),
      billing: sum(withActual, (l) => l.billing),
      cost: sum(withActual, (l) => l.cost),
      gross: sum(withActual, (l) => l.gross),
    },
    participants: {
      reportDays: fromReport.length,
      groups: tally(fromReport, (a) => a.groups, (a) => a.groupsBlank),
      people: tally(fromReport, (a) => a.people, (a) => a.peopleBlank),
    },
    conflicts: days.flatMap((l) => (l.manualIgnored != null && l.actual ? [{ date: l.date, manual: l.manualIgnored, report: l.actual.count }] : [])),
    materials,
    uniformUnitCost: units.size === 0 ? unitCostOf(terms, '') : units.size === 1 ? [...units][0] : null,
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

/**
 * 一覧・見出しに出す金額（JCOS 案件は 請求・実費・粗利、それ以外は従来の 売上・費用・利益）。
 * noStaff … JCOS 案件で、開催する日があるのに、アルバイトを 1 日も配置していない（＝アルバイト代を 0 円で計算している）。
 *           粗利を、確定した実績と取り違えないよう、金額のそばに出す
 */
export interface Money { jcos: boolean; revenue: number; cost: number; profit: number; noStaff?: boolean }
export function projectMoney(
  p: Project, data: Pick<AppData, 'staff' | 'contents' | 'partTypes'> & Partial<ReportContext>, generic?: Estimate,
): Money {
  if (isJcos(p)) {
    const ctx = data.projects && data.venues ? { projects: data.projects, venues: data.venues, contents: data.contents } : undefined;
    const j = jcosEstimate(p, ctx);
    const t = j.current;
    return { jcos: true, revenue: t.billing, cost: t.cost, profit: t.gross, noStaff: j.noStaff };
  }
  const e = generic ?? estimate(p, data);
  return { jcos: false, revenue: e.revenue, cost: e.totalCost, profit: e.profit };
}
