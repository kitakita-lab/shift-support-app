// 案件ごとの収支試算（純関数）。計算式は docs/02_新アプリ設計書.md「4. 試算の計算式」と一致させること。
import { AppData, Assignment, Content, Layout, PartType, Project, Staff } from '../types';
import { listDates, num, roundYen, toMinutes } from './util';

export interface LaborLine {
  assignmentId: string;
  staffName: string;
  date: string;
  /** 実働時間（h）= (終了 − 開始 − 休憩) / 60。負になる場合は 0 */
  hours: number;
  rate: number;
  wage: number;
  transport: number;
  total: number;
}

export interface ContentLine {
  id: string;
  name: string;
  count: number;
  price: number;
  revenue: number;
  /** 1個あたり材料原価 = Σ(材料単価 × 使用数) */
  unitMaterialCost: number;
  sparePct: number;
  materialCost: number;
}

export interface PartLine {
  partTypeId: string;
  name: string;
  count: number;
  unitCost: number;
  costUnit: 'event' | 'day';
  cost: number;
  stockQty: number;
}

export interface Estimate {
  days: number;
  contentLines: ContentLine[];
  laborLines: LaborLine[];
  partLines: PartLine[];
  participationRevenue: number;
  fixedRevenue: number;
  revenue: number;
  laborCost: number;
  materialCost: number;
  venueFee: number;
  partsCost: number;
  otherCost: number;
  totalCost: number;
  profit: number;
  /** 利益率（%）。売上 0 のときは null */
  marginPct: number | null;
  totalHours: number;
  /** 椅子カテゴリのパーツ数（席数の目安） */
  seats: number;
}

export function unitMaterialCost(c: Content | undefined): number {
  if (!c) return 0;
  return c.materials.reduce((s, m) => s + num(m.unitCost) * num(m.qtyPerUnit), 0);
}

/** 実働時間（分）= max(0, 終了 − 開始 − 休憩)。時刻が未入力なら 0 */
export function assignmentMinutes(a: Assignment): number {
  const s = toMinutes(a.startTime);
  const e = toMinutes(a.endTime);
  if (s == null || e == null) return 0;
  return Math.max(0, e - s - num(a.breakMinutes));
}

export function assignmentHours(a: Assignment): number {
  return assignmentMinutes(a) / 60;
}

export function laborLine(a: Assignment, staff: Staff | undefined): LaborLine {
  const minutes = assignmentMinutes(a);
  const hours = minutes / 60;
  const rate = a.rateOverride ?? num(staff?.hourlyRate);
  const transport = a.transportOverride ?? num(staff?.transportPerDay);
  // 1配置ごとに円未満を四捨五入。「分 × 時給」を先に掛けてから 60 で割る（先に時間へ直すと端数で 1 円ずれることがある）
  const wage = roundYen((minutes * num(rate)) / 60);
  return {
    assignmentId: a.id,
    staffName: staff?.name ?? '(未選択)',
    date: a.date,
    hours,
    rate: num(rate),
    wage,
    transport: num(transport),
    total: wage + num(transport),
  };
}

/** パーツ種別ごとの配置個数 */
export function countParts(layout: Layout): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of layout.items) m.set(it.partTypeId, (m.get(it.partTypeId) ?? 0) + 1);
  return m;
}

export function partLines(layout: Layout, partTypes: PartType[], days: number): PartLine[] {
  const counts = countParts(layout);
  return partTypes
    .filter((p) => counts.has(p.id))
    .map((p) => {
      const count = counts.get(p.id) ?? 0;
      const mult = p.costUnit === 'day' ? days : 1;
      return {
        partTypeId: p.id,
        name: p.name,
        count,
        unitCost: num(p.unitCost),
        costUnit: p.costUnit,
        cost: count * num(p.unitCost) * mult,
        stockQty: num(p.stockQty),
      };
    });
}

export function estimate(p: Project, data: Pick<AppData, 'staff' | 'contents' | 'partTypes'>): Estimate {
  const days = listDates(p.startDate, p.endDate).length;

  const contentLines: ContentLine[] = p.contents.map((pc) => {
    const c = data.contents.find((x) => x.id === pc.contentId);
    const count = num(pc.plannedCount);
    const price = pc.priceOverride ?? num(c?.price);
    const unit = unitMaterialCost(c);
    return {
      id: pc.id,
      name: c?.name ?? '(未選択)',
      count,
      price: num(price),
      revenue: count * num(price),
      unitMaterialCost: unit,
      sparePct: num(pc.sparePct),
      // 個数 ×（100 ＋ 予備率）× 原価 を先に掛けてから 100 で割る（1.15 のような小数を経由すると端数で 1 円ずれることがある）
      materialCost: roundYen((count * (100 + num(pc.sparePct)) * unit) / 100),
    };
  });

  const laborLines = p.assignments.map((a) => laborLine(a, data.staff.find((s) => s.id === a.staffId)));
  const pLines = partLines(p.layout, data.partTypes, days);

  const participationRevenue = contentLines.reduce((s, l) => s + l.revenue, 0);
  const fixedRevenue = num(p.fixedRevenue);
  const revenue = participationRevenue + fixedRevenue;

  const laborCost = laborLines.reduce((s, l) => s + l.total, 0);
  const materialCost = contentLines.reduce((s, l) => s + l.materialCost, 0);
  const venueFee = roundYen(
    num(p.venueFeeFixed) + num(p.venueFeePerDay) * days + (participationRevenue * num(p.venueFeeRatePct)) / 100,
  );
  const partsCost = pLines.reduce((s, l) => s + l.cost, 0);
  const otherCost = p.otherCosts.reduce((s, o) => s + num(o.amount), 0);
  const totalCost = laborCost + materialCost + venueFee + partsCost + otherCost;
  const profit = revenue - totalCost;

  const chairIds = new Set(data.partTypes.filter((t) => t.category === 'chair').map((t) => t.id));
  const seats = p.layout.items.filter((i) => chairIds.has(i.partTypeId)).length;

  return {
    days,
    contentLines,
    laborLines,
    partLines: pLines,
    participationRevenue,
    fixedRevenue,
    revenue,
    laborCost,
    materialCost,
    venueFee,
    partsCost,
    otherCost,
    totalCost,
    profit,
    marginPct: revenue > 0 ? (profit / revenue) * 100 : null,
    totalHours: laborLines.reduce((s, l) => s + l.hours, 0),
    seats,
  };
}
