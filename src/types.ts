export interface Staff {
  id: string;
  staffNo: string;
  name: string;
  availableWeekdays: string[];
  requestedDaysOff: string[];
  maxWorkDays: number;
  maxConsecutiveDays?: number;
  memo: string;
  preferredWorkSites: string[];
}

export interface WorkSite {
  id: string;
  groupId?: string;
  groupLabel?: string;
  sessionId?: string;
  date: string;
  clientName?: string;
  siteName: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
  isPlaceholder?: boolean;
  source?: 'manual' | 'csv';
}

export interface ShiftAssignment {
  siteId: string;
  assignedStaffIds: string[];
  shortage: number;
}

/**
 * シフト情報の共通正規化形式。
 * CSV取込・貼り付け取込・Excel出力・将来の再取込/上書き判定の共通言語として使う。
 * 内部IDを持たず、人間が読める文字列フィールドのみで構成する。
 */
export interface NormalizedShiftRow {
  date: string;
  siteName: string;
  clientName?: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  assignedStaffNames: string[];
  memo?: string;
  /** 取込元の生テキスト。デバッグ・重複判定に使用。normalize後は書き換えない */
  rawSiteName?: string;
}
