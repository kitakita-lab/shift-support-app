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
  /**
   * クライアント（発注元）名。
   * 取得優先順位: (1) ファイルの clientName 列 → (2) ウィザード Step2 のデフォルト値 →
   * (3) siteName 括弧から自動抽出（applySiteNormalize 内）。
   * 内部キー生成に使うため、表記ゆれを吸収したい場合は SITE_NAME_ALIAS_DICT で対応する。
   */
  clientName?: string;
  /**
   * 親会場名。cleanSiteName() 適用後の値のみを格納する。
   * subSiteName を混ぜない。displaySiteName でもない。
   * 例: "Bivi新札幌"（"Bivi新札幌（2階ドラッグ側）" は不可）
   */
  siteName: string;
  /**
   * 取り込み元ファイルの原文。復元・監査用。
   * applySiteNormalize 後も絶対に上書きしない。候補検索・キー生成には使わない。
   */
  rawSiteName?: string;
  /**
   * 物理的な区画・売場名。例: 2階ドラッグ側、センターコート。
   * siteName に混ぜない。独立フィールドとして管理する。空欄可。
   */
  subSiteName?: string;
  /**
   * UI表示・Excel表示専用。buildDisplaySiteName() で生成。
   * 例: "Bivi新札幌（2階ドラッグ側）"
   * 内部グルーピングキー・重複判定・候補検索には絶対に使わない。
   */
  displaySiteName?: string;
  /**
   * 表記ゆれ吸収・類似候補検索用の内部キー。buildNormalizedSiteKey() で生成。
   * キー構造: normalize(clientName) + "\0" + normalize(siteName) + "\0" + normalize(subSiteName)
   * displaySiteName / rawSiteName は使わない。
   * SITE_NAME_ALIAS_DICT を追加・変更した場合は既存データのキーを再生成すること。
   */
  normalizedSiteKey?: string;
  /**
   * 会場同一性判定の安定キー。buildSiteIdentityKey() で生成。
   * importDiff / 再インポート判定 / 重複除外の唯一の基準として使う。
   * normalizedSiteKey と同じアルゴリズムだが用途を概念的に分離している。
   * displaySiteName / rawSiteName は絶対に使わない。
   * SITE_NAME_ALIAS_DICT を変更した場合は既存データとの不整合が生じるため注意。
   */
  siteIdentityKey?: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
  isPlaceholder?: boolean;
  source?: 'manual' | 'csv' | 'excel';
  /** ユーザーが現場管理タブで手動編集した場合 true。再インポート・バッチ削除から保護する。 */
  isManuallyEdited?: boolean;
  /** 手動編集日時（ISO8601）。isManuallyEdited: true と同時に付与する。 */
  manualEditedAt?: string;
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

/**
 * インポート操作1回分のログ。localStorage に永続化する。
 * 初回インポート・再インポートの両方で生成する。
 */
export interface ImportLog {
  id: string;
  importBatchId: string;
  source: 'csv' | 'excel';
  sourceFileName?: string;
  importedAt: string;
  /** パース後の有効行数 */
  rowCount: number;
  /** 実際にストアに追加したWorkSite数（日単位） */
  importedSiteCount: number;
  skippedCount?: number;
  addedCount?: number;
  changedCount?: number;
  deletedCount?: number;
  /** source==='manual' または isManuallyEdited===true により保護された件数 */
  protectedCount?: number;
}
