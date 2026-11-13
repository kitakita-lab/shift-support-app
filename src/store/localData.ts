// 「この端末だけのデータ」の読み書き（ブラウザの localStorage）と、保存された生データをアプリの形に整える処理。
// ここにあるデータは同期しない。共有データ（Firestore）とは別の入れ物で、自動では混ざらない。
import { hydrateJcos } from '../domain/jcos';
import { hydrateLayout } from '../domain/layout';
import { hydrateReportSync } from '../domain/report';
import { emptyData } from '../domain/seed';
import { AppData, Composite, Content, PartType, Project, Staff, Venue } from '../types';

/** V1 から変えていない（以前の版で保存したデータを、そのまま「この端末だけのデータ」として読める） */
export const LS_KEY = 'kkl_workshop_v1';

export function hydrateProject(p: Project): Project {
  const out: Project = {
    ...p,
    contents: p.contents ?? [],
    assignments: p.assignments ?? [],
    otherCosts: p.otherCosts ?? [],
    layout: hydrateLayout(p.layout),
    updatedAt: p.updatedAt ?? 0,
  };
  // Version 4 の項目（どれも任意）。あるものだけ形をそろえ、扱えない形のものは外す。無い案件には足さない
  const raw = p as unknown as Record<string, unknown>;
  const put = <K extends 'jcos' | 'reportSync' | 'actualsManual' | 'reportClaims' | 'reportSource'>(key: K, value: Project[K] | undefined) => {
    if (value === undefined) delete out[key]; else out[key] = value;
  };
  if (raw.jcos !== undefined) put('jcos', hydrateJcos(raw.jcos));
  if (raw.reportSync !== undefined) put('reportSync', hydrateReportSync(raw.reportSync));
  if (raw.actualsManual !== undefined) {
    const m = raw.actualsManual;
    put('actualsManual', m && typeof m === 'object' && !Array.isArray(m)
      ? Object.fromEntries(Object.entries(m as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] >= 0))
      : undefined);
  }
  if (raw.reportClaims !== undefined) {
    put('reportClaims', Array.isArray(raw.reportClaims) ? raw.reportClaims.filter((d): d is string => typeof d === 'string') : undefined);
  }
  if (raw.reportSource !== undefined) {
    const s = raw.reportSource as { spreadsheetId?: unknown; gid?: unknown } | null;
    put('reportSource', s && typeof s === 'object' && typeof s.spreadsheetId === 'string' && s.spreadsheetId
      ? { spreadsheetId: s.spreadsheetId, gid: typeof s.gid === 'number' && Number.isFinite(s.gid) ? s.gid : null }
      : undefined);
  }
  return out;
}

/** マスタ 1 件を整える（共有データは 1 件ずつ届くので、1 件単位でも使う） */
export const hydrateItem = {
  staff: (s: Staff): Staff => s,
  venues: (v: Venue): Venue => ({ ...v, template: hydrateLayout(v.template) }),
  contents: (c: Content): Content => ({ ...c, materials: c.materials ?? [] }),
  partTypes: (p: PartType): PartType => p,
  composites: (c: Composite): Composite => c,
};

export function hydrateData(raw: Partial<AppData> | null): AppData {
  const base = emptyData();
  if (!raw) return base;
  return {
    staff: raw.staff ?? [],
    venues: (raw.venues ?? []).map(hydrateItem.venues),
    contents: (raw.contents ?? []).map(hydrateItem.contents),
    partTypes: raw.partTypes ?? base.partTypes,
    composites: raw.composites ?? base.composites,
    projects: (raw.projects ?? []).map(hydrateProject),
  };
}

export function loadLocal(): AppData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return hydrateData(raw ? (JSON.parse(raw) as Partial<AppData>) : null);
  } catch {
    return emptyData();
  }
}

export function saveLocal(data: AppData): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;                                 // 容量超過など
  }
}

/** 何も入っていない（初期状態と同じ）か。サンプル読込・復元の前に確認を出すかどうかの判定に使う */
export function isEmptyData(d: AppData): boolean {
  return d.projects.length === 0 && d.staff.length === 0 && d.venues.length === 0 && d.contents.length === 0;
}
