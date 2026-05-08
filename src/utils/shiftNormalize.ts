import { Staff, WorkSite, ShiftAssignment, NormalizedShiftRow } from '../types';
import { parseSiteCSV, ParseError } from './csvImport';

// normalize 層のエラー型（ParseError と同形式）
export type NormalizeError = ParseError;

/** parseSiteCSVToNormalized / normalizeShiftRows の返却型 */
export interface NormalizeShiftResult {
  rows: NormalizedShiftRow[];
  errors: NormalizeError[];
}

/**
 * CSV テキストをパースして NormalizedShiftRow[] に変換する。
 * 貼り付け取込・ファイル取込のエントリポイント。
 * エラー行はスキップして errors に収集する。
 *
 * TODO: 将来的に CSV Export / Excel Export の source-of-truth をこの関数経由へ統一予定
 */
export function parseSiteCSVToNormalized(rawText: string): NormalizeShiftResult {
  const { valid, errors } = parseSiteCSV(rawText);
  return {
    rows: valid.map((site) => normalizeShiftRow(site)),
    errors,
  };
}

/**
 * シフト行の一致判定・再取込の上書き判定に使うキーを返す。
 *
 * キー構成: date / siteName / clientName / startTime / endTime
 * requiredPeople はキーに含めない（後から必要人数が変わる可能性があるため）。
 * trim() で空白差異を吸収し、clientName 未設定は空文字として扱う。
 */
export function buildShiftRowKey(
  date: string,
  siteName: string,
  clientName: string | undefined,
  startTime: string,
  endTime: string
): string {
  return [date, siteName.trim(), (clientName ?? '').trim(), startTime, endTime].join('\0');
}

/**
 * " / " または "/" で区切られたスタッフ名文字列を配列に変換する。
 * csvExport.ts の結合区切り文字（' / '）と対応している。
 * 空文字・空白のみの場合は空配列を返す。
 */
export function normalizeStaffNames(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(/\s*\/\s*/).map((n) => n.trim()).filter((n) => n !== '');
}

// ─── 業務データ normalize ヘルパー ─────────────────────────────────────

/**
 * siteName に混入した "+N名" パターンから追加人数を取り出す。
 * 例: "渋谷+2名" → 2、"現場名" → 0
 */
export function extractRequiredPeopleDelta(raw: string): number {
  const m = raw.match(/\+(\d+)名/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * siteName から汚染文字列を除去して純粋な現場名を返す。
 * 除去対象: "+N名"パターン、"※"以降のアノテーション
 * 例: "渋谷+2名※追加" → "渋谷"
 */
export function cleanSiteName(raw: string): string {
  return raw
    .replace(/\+\d+名/g, '')
    .replace(/※.*/g, '')
    .trim();
}

/**
 * siteName 末尾の全角・半角括弧内を clientName として抽出する。
 * 既に clientName が設定されている場合はそちらを優先する。
 * 例: "渋谷（ABC社）" → "ABC社"
 */
export function extractClientNameFromParens(
  siteName: string,
  existing?: string
): string | undefined {
  if (existing?.trim()) return existing.trim();
  const m = siteName.match(/[（(]([^）)]+)[）)]$/);
  return m ? m[1].trim() : undefined;
}

/**
 * 表記ゆれを吸収した現場同一性判定キーを返す。
 * cleanSiteName → 全角スペース→半角 → 小文字 → clientName を付与
 */
export function normalizeSiteIdentity(siteName: string, clientName?: string): string {
  const cleaned = cleanSiteName(siteName)
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return `${(clientName ?? '').trim().toLowerCase()}\0${cleaned}`;
}

/**
 * NormalizedShiftRow に業務 normalize を適用して新しい行を返す。
 * - siteName から "+N名"・"※..." を除去
 * - "+N名" 分を requiredPeople に加算
 * - 括弧内クライアント名を抽出（clientName 未設定時のみ）
 * - rawSiteName に元の値を保存
 */
export function normalizeBusinessShiftRow(row: NormalizedShiftRow): NormalizedShiftRow {
  const delta = extractRequiredPeopleDelta(row.siteName);
  const cleaned = cleanSiteName(row.siteName);
  const clientName = extractClientNameFromParens(cleaned, row.clientName);
  const siteNameFinal = clientName
    ? cleaned.replace(/[（(][^）)]+[）)]$/, '').trim()
    : cleaned;

  return {
    ...row,
    siteName: siteNameFinal,
    clientName: clientName || undefined,
    requiredPeople: row.requiredPeople + delta,
    rawSiteName: row.rawSiteName ?? row.siteName,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * WorkSite 1件を NormalizedShiftRow に変換する。
 *
 * @param site       変換元の現場データ
 * @param assignment 対応するシフト割当（省略時は assignedStaffNames が空配列）
 * @param staffMap   staffId → 名前のマップ（省略時は ID をそのまま使う）
 */
export function normalizeShiftRow(
  site: WorkSite,
  assignment?: ShiftAssignment,
  staffMap?: Record<string, string>
): NormalizedShiftRow {
  const assignedStaffNames =
    assignment && assignment.assignedStaffIds.length > 0
      ? assignment.assignedStaffIds.map((id) => (staffMap ? (staffMap[id] ?? id) : id))
      : [];

  return {
    date:               site.date,
    siteName:           site.siteName,
    clientName:         site.clientName?.trim() || undefined,
    startTime:          site.startTime,
    endTime:            site.endTime,
    requiredPeople:     site.requiredPeople,
    assignedStaffNames,
    memo:               site.memo?.trim() || undefined,
  };
}

/**
 * WorkSite[] を一括で NormalizedShiftRow[] に変換する。
 * isPlaceholder な現場はスキップし、日付昇順にソートして返す。
 *
 * @param sites       変換元の現場一覧
 * @param assignments 対応するシフト割当一覧
 * @param staff       スタッフ一覧（ID → 名前解決に使用）
 */
export function normalizeShiftRows(
  sites: WorkSite[],
  assignments: ShiftAssignment[],
  staff: Staff[]
): NormalizedShiftRow[] {
  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const staffMap: Record<string, string> = {};
  staff.forEach((s) => (staffMap[s.id] = s.name));

  return sites
    .filter((s) => !s.isPlaceholder)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((site) => normalizeShiftRow(site, assignMap[site.id], staffMap));
}
