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
  /** CSV取込・入力元の元表記。normalize後も消えない原本 */
  rawSiteName?: string;
  /** 画面・Excelで表示するための整えた現場名（+N名・※... 等を除去済み） */
  displaySiteName?: string;
  /** 表記ゆれ吸収・グルーピング・重複判定用の内部比較キー */
  normalizedSiteKey?: string;
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
  /** 取込元の生テキスト。normalize後は書き換えない */
  rawSiteName?: string;
  /** 表記ゆれ吸収済みの同一性判定キー。normalizeSiteIdentity() で生成 */
  normalizedSiteKey?: string;
}
