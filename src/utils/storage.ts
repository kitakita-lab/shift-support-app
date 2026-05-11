import { Staff, WorkSite, ShiftAssignment } from '../types';

const KEYS = {
  staff: 'shift_staff',
  workSites: 'shift_worksites',
  assignments: 'shift_assignments',
};

const genId = (): string =>
  typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function load<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function save<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

/**
 * Partial<WorkSite> から WorkSite を安全に復元する。
 * 必須フィールドが旧データに存在しない場合はデフォルト値を補完し、
 * 新フィールド（importBatchId 等）は存在する場合のみコピーする。
 * Supabase 移行時もこの関数を更新するだけで対応できる。
 */
function hydrateWorkSite(raw: Partial<WorkSite>): WorkSite {
  const s: WorkSite = {
    id:             raw.id             ?? genId(),
    date:           raw.date           ?? '',
    siteName:       raw.siteName       ?? '',
    startTime:      raw.startTime      ?? '',
    endTime:        raw.endTime        ?? '',
    requiredPeople: raw.requiredPeople ?? 1,
    memo:           raw.memo           ?? '',
  };
  // オプションフィールドは値が存在するときのみコピー（旧データとの後方互換）
  if (raw.clientName        != null) s.clientName        = raw.clientName;
  if (raw.groupId           != null) s.groupId           = raw.groupId;
  if (raw.groupLabel        != null) s.groupLabel        = raw.groupLabel;
  if (raw.sessionId         != null) s.sessionId         = raw.sessionId;
  if (raw.rawSiteName       != null) s.rawSiteName       = raw.rawSiteName;
  if (raw.subSiteName       != null) s.subSiteName       = raw.subSiteName;
  if (raw.displaySiteName   != null) s.displaySiteName   = raw.displaySiteName;
  if (raw.normalizedSiteKey != null) s.normalizedSiteKey = raw.normalizedSiteKey;
  if (raw.isPlaceholder     != null) s.isPlaceholder     = raw.isPlaceholder;
  if (raw.source            != null) s.source            = raw.source;
  if (raw.sourceFileName    != null) s.sourceFileName    = raw.sourceFileName;
  if (raw.importedAt        != null) s.importedAt        = raw.importedAt;
  if (raw.importBatchId     != null) s.importBatchId     = raw.importBatchId;
  return s;
}

export const storage = {
  loadStaff: (): Staff[] =>
    load<Partial<Staff> & Omit<Staff, 'staffNo' | 'preferredWorkSites'>>(KEYS.staff).map(
      (s) => ({ staffNo: '', preferredWorkSites: [], maxConsecutiveDays: 5, ...s } as Staff)
    ),
  saveStaff: (data: Staff[]): void => save(KEYS.staff, data),

  loadWorkSites: (): WorkSite[] =>
    load<Partial<WorkSite>>(KEYS.workSites).map(hydrateWorkSite),
  saveWorkSites: (data: WorkSite[]): void => save(KEYS.workSites, data),

  loadAssignments: (): ShiftAssignment[] => load<ShiftAssignment>(KEYS.assignments),
  saveAssignments: (data: ShiftAssignment[]): void => save(KEYS.assignments, data),

  clearAll: (): void => {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  },
};
