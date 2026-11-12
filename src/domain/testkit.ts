// テスト用の部品。本体コードからは使わない。
import { AppData, Assignment, Content, PartType, Project, ProjectContent, Staff, Venue } from '../types';
import { emptyLayout } from './layout';
import { defaultComposites, defaultPartTypes } from './seed';

export const staffA: Staff = { id: 's1', name: 'A', hourlyRate: 1200, transportPerDay: 800, memo: '' };
export const staffB: Staff = { id: 's2', name: 'B', hourlyRate: 1000, transportPerDay: 0, memo: '' };

/** 材料原価 270 円/個（ボトル 120×1 ＋ 花材 30×5）、参加費 500 円 */
export const bottle: Content = {
  id: 'c1', name: 'フラワーボトル', price: 500, memo: '',
  materials: [
    { id: 'm1', name: 'ボトル', unitCost: 120, qtyPerUnit: 1 },
    { id: 'm2', name: '花材', unitCost: 30, qtyPerUnit: 5 },
  ],
};

export const venue1: Venue = { id: 'v1', name: '会場1', feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout() };

export function mkAssign(patch: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', staffId: 's1', date: '2026-12-05', startTime: '10:00', endTime: '18:00', breakMinutes: 60,
    rateOverride: null, transportOverride: null, memo: '', ...patch,
  };
}

export function mkContent(patch: Partial<ProjectContent> = {}): ProjectContent {
  return { id: 'pc1', contentId: 'c1', plannedCount: 100, priceOverride: null, sparePct: 0, ...patch };
}

/** 何も警告が出ない「正常な」案件（2日間・会場あり・コンテンツ1件・両日1人ずつ配置・周辺環境あり） */
export function mkProject(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'テスト案件', venueId: 'v1', startDate: '2026-12-05', endDate: '2026-12-06',
    openTime: '10:00', closeTime: '18:00', status: '計画中', memo: '',
    contents: [mkContent()],
    assignments: [mkAssign({ id: 'a1', date: '2026-12-05' }), mkAssign({ id: 'a2', date: '2026-12-06' })],
    fixedRevenue: 0, venueFeeFixed: 0, venueFeePerDay: 0, venueFeeRatePct: 0, otherCosts: [],
    layout: { ...emptyLayout(), env: [{ id: 'e1', kind: 'booth', x: 100, y: 100, w: 800, h: 700, label: '' }] },
    updatedAt: 0,
    ...patch,
  };
}

export function mkData(patch: Partial<AppData> = {}): AppData {
  return {
    staff: [staffA, staffB], venues: [venue1], contents: [bottle],
    partTypes: defaultPartTypes(), composites: defaultComposites(), projects: [],
    ...patch,
  };
}

/** パーツマスタの一部を書き換えた配列を返す */
export function withParts(patches: Record<string, Partial<PartType>>): PartType[] {
  return defaultPartTypes().map((t) => (patches[t.id] ? { ...t, ...patches[t.id] } : t));
}

/** 再現性のある擬似乱数（mulberry32）。0 以上 1 未満 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
