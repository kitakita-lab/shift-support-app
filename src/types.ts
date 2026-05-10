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
  /** 取り込み元の原文。変換前の確認・復元用。normalize後も上書きしない。 */
  rawSiteName?: string;
  /**
   * 物理的な区画・売場名。例: 2階ドラッグ側、センターコート
   * siteName に混ぜない。空欄可。
   */
  subSiteName?: string;
  /**
   * UI表示・Excel表示専用。buildDisplaySiteName() で生成。
   * 例: "Bivi新札幌（2階ドラッグ側）"
   * 内部グルーピングキー・重複判定には使わない。
   */
  displaySiteName?: string;
  /**
   * グルーピング・重複判定用の内部比較キー。buildNormalizedSiteKey() で生成。
   * clientName + siteName + subSiteName を正規化・エイリアス変換して結合する。
   * displaySiteName は使わない。
   */
  normalizedSiteKey?: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
  isPlaceholder?: boolean;
  source?: 'manual' | 'csv' | 'excel';
  /** 取り込み元ファイル名（例: '会期リスト2026-05.xlsx'）。Supabase移行後も保持する。 */
  sourceFileName?: string;
  /** 取り込み日時（ISO8601）。バッチ一覧表示・差分管理に使用。 */
  importedAt?: string;
  /** 同一インポート操作のバッチID。バッチ単位での削除・管理に使用。 */
  importBatchId?: string;
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
