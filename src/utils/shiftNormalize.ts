import { Staff, WorkSite, ShiftAssignment, NormalizedShiftRow } from '../types';

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
