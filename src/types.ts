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
