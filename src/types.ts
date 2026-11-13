// ============================================================
// KitaKita Lab ワークショップ運営プランナー データモデル
// 設計の根拠は docs/02_新アプリ設計書.md を参照。
// 金額は「円」、長さは「cm」、時刻は "HH:MM"、日付は "YYYY-MM-DD"。
// ============================================================

// ── マスタ ──────────────────────────────────────────────────

export interface Staff {
  id: string;
  name: string;
  /** 時給（円） */
  hourlyRate: number;
  /** 1勤務日あたりの交通費（円） */
  transportPerDay: number;
  memo: string;
}

/** コンテンツ1個（参加者1人分）を作るのに必要な材料 */
export interface Material {
  id: string;
  name: string;
  /** 材料1単位の原価（円） */
  unitCost: number;
  /** コンテンツ1個あたりの使用数 */
  qtyPerUnit: number;
}

/** 実施コンテンツ（フラワーボトル等） */
export interface Content {
  id: string;
  name: string;
  /** 参加費（1個あたり・円）。無料イベントは 0 */
  price: number;
  materials: Material[];
  memo: string;
}

export type PartCategory = 'table' | 'chair' | 'banner' | 'pop' | 'display' | 'partition' | 'other';
export type CostUnit = 'event' | 'day';

/** レイアウトに置ける定型パーツ（サイズ固定） */
export interface PartType {
  id: string;
  name: string;
  /** 図面上の短い表示名（番号の前に付く）。空なら name */
  shortName: string;
  category: PartCategory;
  widthCm: number;
  depthCm: number;
  /** true なら図面上で番号を自動採番する（テーブル等） */
  numbered: boolean;
  /** 1個あたりの費用（円）。自前備品は 0 */
  unitCost: number;
  /** 費用の単位。event=1案件あたり / day=1日あたり */
  costUnit: CostUnit;
  /** 保有数。0 は「管理しない」。超過すると警告のみ（禁止しない） */
  stockQty: number;
  /**
   * 椅子の役割（区分が「椅子」のときだけ意味がある）。work＝制作席（参加者が座って作る席）／other＝それ以外（商談席・待合など）。
   * 未設定は work として読む（この項目が無かった頃のデータの席数が、黙って変わらないようにするため）。
   */
  seatRole?: SeatRole;
}
export type SeatRole = 'work' | 'other';

/** 複数パーツの組み合わせ（L字など）。置くと1グループとして扱う */
export interface CompositeMember {
  partTypeId: string;
  dx: number;
  dy: number;
  rot: Rot;
}
export interface Composite {
  id: string;
  name: string;
  members: CompositeMember[];
}

// ── レイアウト ──────────────────────────────────────────────

export type Rot = 0 | 90;

/** 周辺環境（雛形）の要素種別 */
export type EnvKind =
  | 'booth'     // 会場（ブース）区画
  | 'passage'   // 通路
  | 'shop'      // 周辺店舗・施設
  | 'wall'      // 壁
  | 'entrance'  // 入口（帯＋矢印＋ラベル）
  | 'stairs'    // 階段
  | 'text';     // 注記テキスト

export type Tone = 'gray' | 'purple' | 'green' | 'orange';
export type Dir = 'up' | 'down' | 'left' | 'right';

export interface EnvElement {
  id: string;
  kind: EnvKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sublabel?: string;
  tone?: Tone;
  /** entrance の矢印の向き（人が入ってくる方向） */
  dir?: Dir;
}

export interface PlacedItem {
  id: string;
  partTypeId: string;
  /** 左上座標（cm） */
  x: number;
  y: number;
  rot: Rot;
  /** 組み合わせ配置のグループ。同じ groupId は一緒に動く */
  groupId?: string;
  /** 手入力ラベル。空なら自動採番ラベル */
  label?: string;
}

export interface LayoutGroup {
  id: string;
  /** 表示名（例: L字）。図面では「L字①」のように番号が付く */
  name: string;
}

/** 版の発行記録（PDF出力時に追加） */
export interface IssuedVersion {
  version: number;
  issuedAt: string;
  /**
   * 出力したときの「図に描かれる内容」の指紋（区分ごと。domain/figure.ts）。
   * いまの図の指紋と比べて、出力後に図が変わったかどうか・何が変わったかを判定する。
   * この項目が無い記録は、指紋を記録する前の版（Version 2 まで）で出力したもの。
   */
  fp?: Record<string, string>;
}

export interface Layout {
  /** 図面全体のサイズ（cm） */
  width: number;
  height: number;
  env: EnvElement[];
  items: PlacedItem[];
  groups: LayoutGroup[];
  /** 現在の作業版。PDF出力済みの版を編集すると自動で +1 される */
  version: number;
  issued: IssuedVersion[];
  /** タイトル直下の一行注記（例: 配置確認用・縮尺なし） */
  caption: string;
  /** 未確認事項（1行1項目） */
  notes: string;
}

export interface Venue {
  id: string;
  name: string;
  /** 会場費の既定値（案件作成時にコピー） */
  feeFixed: number;
  feePerDay: number;
  feeRatePct: number;
  memo: string;
  /** 会場レイアウトの雛形（周辺環境のみ。items は空） */
  template: Layout;
  /**
   * 日報での会場名（別名）。日報の同期で、会場名の表記が違う回答をこの会場のものとして扱うための、明示的な対応づけ。
   * 未設定なら、会場名（name）と一致する回答だけを対象にする。
   */
  reportNames?: string[];
}

// ── 案件 ────────────────────────────────────────────────────

export type ProjectStatus = '計画中' | '確定' | '実施済' | '中止';

export interface ProjectContent {
  id: string;
  contentId: string;
  /** 期間合計の予定個数（=予定参加人数） */
  plannedCount: number;
  /** 参加費の案件別上書き。null ならコンテンツマスタの値 */
  priceOverride: number | null;
  /** 材料の予備率（%）。材料費 = 個数 × (1+予備率) × 1個原価 */
  sparePct: number;
  /**
   * 上限回転数（制作席 1 席が 1 日に受けられる回数）。任意。空欄（null・未設定・0 以下）なら、席数の過不足を警告しない。
   */
  maxTurns?: number | null;
}

export interface Assignment {
  id: string;
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  /** null ならスタッフマスタの時給 */
  rateOverride: number | null;
  /** null ならスタッフマスタの交通費 */
  transportOverride: number | null;
  memo: string;
}

export interface OtherCost {
  id: string;
  name: string;
  amount: number;
}

// ── JCOS 案件の収支（請求と実費を分けて持つ）・日報の同期 ─────────────────
// 計算は domain/jcos.ts、日報の照合と集計は domain/report.ts。設計は docs/02_新アプリ設計書.md「6. Version 4」。

/** JCOS 案件の、日ごとの例外。無い日は「請求する・アルバイト 1 人」 */
export interface JcosDay {
  /** false なら、その日は JCOS への請求の対象にしない */
  billed?: boolean;
  /** その日に稼働するアルバイトの人数（未設定は 1） */
  partTimers?: number;
}

/**
 * JCOS 案件の収支の条件。金額はすべて「編集できる初期値」で、案件ごとに変えられる。
 * enabled が true の案件だけ、JCOS の収支計算（請求 − 実費 ＝ 粗利）を使う。false・未設定なら従来の汎用の試算。
 */
export interface JcosTerms {
  enabled: boolean;
  /** JCOS への請求（売上）: 人件費 1 日あたり（円） */
  billLaborPerDay: number;
  /** JCOS への請求（売上）: 材料費 1 日あたり（円） */
  billMaterialPerDay: number;
  /** 追加の請求（予備費など。案件によって付く） */
  extraBillings: OtherCost[];
  /** こちらの支払い: アルバイト代 1 人・1 稼働日あたり（円） */
  partTimerPerDay: number;
  /** こちらの支払い: 材料原価 制作物 1 個あたり（円）。製品の種類では分けない（暫定 220 円） */
  unitCost: number;
  /** 日ごとの例外（日付 "YYYY-MM-DD" → 設定） */
  days: Record<string, JcosDay>;
}

/** 日報（Google フォームの回答が入るスプレッドシート）の場所 */
export interface ReportSource {
  spreadsheetId: string;
  /** タブの ID（URL の gid）。分かっていれば、タブ名より優先して使う */
  gid?: number | null;
}

/** 日報から取り込んだ 1 日分の実績 */
export interface ReportDay {
  date: string;
  /** キットの使用数の合計（＝制作物の実績個数） */
  count: number;
  /** 合計のもとになった回答の数 */
  rows: number;
  /**
   * 合計のもとになった回答の会場名（照合用にそろえた形）。同期のあとで、同じ会場名・重なる会期の案件が増えた・
   * 「この案件の実績にする」の決定が変わった、という場合に、この実績をいまも使ってよいかを確かめ直すために持つ。
   * この項目が無い実績（以前の版で同期したもの）は、案件の会場名すべてを使って確かめる。
   */
  keys?: string[];
}

/** 取り込まなかった回答の理由 */
export type ReportSkipReason =
  | 'bad-date'        // 会場は一致するが、開催日を読み取れない
  | 'bad-count'       // 会場と開催日は一致するが、キットの使用数を読み取れない（空欄を含む）
  | 'no-venue'        // 開催日は会期内だが、会場名が空欄
  | 'other-project';  // 会場と開催日は一致するが、会期が重なる別の案件の実績として割り当て済み

export interface ReportSkip {
  reason: ReportSkipReason;
  rows: number;
  /** 対象の開催日（読み取れたものだけ。重複なし・日付順） */
  dates: string[];
}

/** 会期が重なる別の案件があり、どちらの実績か決められないため、取り込みを保留した日 */
export interface ReportHeld {
  date: string;
  count: number;
  rows: number;
  /** 重なっている案件の名前 */
  others: string[];
}

/** 開催日は会期内だが、会場名が一致しなかった回答（別名を登録する候補） */
export interface ReportUnmatched {
  /** 日報に書かれていた会場名（前後の空白を除いたもの） */
  venue: string;
  rows: number;
  count: number;
  dates: string[];
}

/**
 * 最後に成功した同期の結果。同期のたびに丸ごと置き換える（足し込まない）ので、何度同期しても二重計上にならず、
 * 日報の修正・削除もそのまま反映される。失敗した同期では書き換えない。
 */
export interface ReportSync {
  /** 同期した日時（ISO 8601） */
  at: string;
  /** 同期したときの会場と会期（あとで会場・会期を変えた場合に、古い実績を使わないための控え） */
  venueId: string;
  startDate: string;
  endDate: string;
  days: ReportDay[];
  /** 日報から読んだ回答の数（見出しを除く） */
  rowsRead: number;
  /** この案件の実績として取り込んだ回答の数 */
  rowsUsed: number;
  /** テスト回答として除いた数 */
  tests: number;
  skipped: ReportSkip[];
  held: ReportHeld[];
  unmatched: ReportUnmatched[];
}

export interface Project {
  id: string;
  /** タイトル先頭に入る名称（例: ikyu） */
  name: string;
  venueId: string;
  startDate: string;
  endDate: string;
  /** スタッフ配置の既定時間 */
  openTime: string;
  closeTime: string;
  status: ProjectStatus;
  memo: string;
  contents: ProjectContent[];
  assignments: Assignment[];
  /** 固定の売上（受託料・出店料収入など） */
  fixedRevenue: number;
  venueFeeFixed: number;
  venueFeePerDay: number;
  /** 売上歩合（%）。対象は参加費売上 */
  venueFeeRatePct: number;
  otherCosts: OtherCost[];
  layout: Layout;
  updatedAt: number;
  // ── 以下は Version 4 で追加（すべて任意。無ければ従来どおりの汎用の試算） ──
  /** JCOS 案件の収支の条件 */
  jcos?: JcosTerms;
  /** 手入力の実績個数（日付 → 個数）。同じ日に日報の実績があれば、日報を優先する */
  actualsManual?: Record<string, number>;
  /** 日報の場所。同期に成功したときに、使った場所を記録する */
  reportSource?: ReportSource;
  /** 最後に成功した日報の同期の結果 */
  reportSync?: ReportSync;
  /** 会期が重なる別の案件があるときに、「この案件の実績として取り込む」と利用者が決めた日付 */
  reportClaims?: string[];
}

// ── アプリ全体 ──────────────────────────────────────────────

export interface AppData {
  staff: Staff[];
  venues: Venue[];
  contents: Content[];
  partTypes: PartType[];
  composites: Composite[];
  projects: Project[];
}

export type Severity = 'warn' | 'info';

/** 入力チェック結果。入力は禁止せず、警告として表示する */
export interface Warning {
  severity: Severity;
  /** 対象の場所（例: 'assign:<id>:endTime', 'project:endDate', 'part:<partTypeId>'） */
  target: string;
  message: string;
}
