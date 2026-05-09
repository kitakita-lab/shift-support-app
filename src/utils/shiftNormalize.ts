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
 * requiredPeople はキーに含めない（後から変わる可能性があるため）。
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
  const m = raw.match(/[+＋](\d+)名/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * siteName から汚染文字列を除去して純粋な現場名を返す。
 *
 * 除去対象:
 * - "+N名" / "＋N名" / "+N" / "＋N"（全角プラス対応）
 * - "※..." （※ 以降すべて）
 * - 末尾の補足語: サテ / 臨時 / 応援 / 短縮営業（スペース区切り）
 *
 * 例: "WB小樽+2名 ネイチャー" → "WB小樽 ネイチャー"
 *     "イオン厚別 ※サテライト" → "イオン厚別"
 */
export function cleanSiteName(raw: string): string {
  return raw
    .replace(/[+＋]\d+名?/g, '')
    .replace(/※.*/g, '')
    .replace(/[\s　]+(サテ|臨時|応援|短縮営業)\s*$/g, '')
    .replace(/\s+/g, ' ')
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
 *
 * 仕様:
 * - cleanSiteName 適用後に全角英数→半角、スペース除去、括弧除去、小文字化
 * - clientName もまとめてキーに含める
 *
 * 例: "アリオ ハーベストコート" / "アリオハーベストコート" → 同一キー
 *     "イオン厚別（ティーガイア）" → extractClientNameFromParens後の形と同一キー
 */
export function normalizeSiteIdentity(siteName: string, clientName?: string): string {
  const norm = (s: string): string =>
    cleanSiteName(s)
      .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[ａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s　]/g, '')
      .replace(/[（）()]/g, '')
      .toLowerCase();
  return `${norm(clientName ?? '')}\0${norm(siteName)}`;
}

/**
 * CSV 取込した WorkSite に normalize を適用して返す。
 * groupId 付与前の `buildCsvImportGroups` / `applySiteImport` で使用。
 *
 * - cleanSiteName で "+N名"・"※..." を除去
 * - 括弧内クライアント名を抽出（clientName 未設定時のみ）
 * - siteName から括弧を除去（clientName へ移動済みのため）
 */
export function applySiteNormalize(site: WorkSite): WorkSite {
  const cleaned = cleanSiteName(site.siteName);
  const m = cleaned.match(/[（(]([^）)]+)[）)]$/);
  const extractedClient = m ? m[1].trim() : undefined;
  const clientName = site.clientName?.trim() || extractedClient || '';
  const siteName = m ? cleaned.replace(/[（(][^）)]+[）)]$/, '').trim() : cleaned;
  return { ...site, siteName, clientName };
}

/**
 * NormalizedShiftRow に業務 normalize を適用して新しい行を返す。
 * - cleanSiteName、括弧内クライアント名抽出
 * - "+N名" 分を requiredPeople に加算
 * - rawSiteName に元の値を保存
 * - normalizedSiteKey を設定
 */
export function normalizeBusinessShiftRow(row: NormalizedShiftRow): NormalizedShiftRow {
  const delta = extractRequiredPeopleDelta(row.siteName);
  const cleaned = cleanSiteName(row.siteName);
  const m = cleaned.match(/[（(]([^）)]+)[）)]$/);
  const extractedClient = m ? m[1].trim() : undefined;
  const clientName = row.clientName?.trim() || extractedClient || undefined;
  const siteName = m ? cleaned.replace(/[（(][^）)]+[）)]$/, '').trim() : cleaned;

  return {
    ...row,
    siteName,
    clientName,
    requiredPeople: row.requiredPeople + delta,
    rawSiteName: row.rawSiteName ?? row.siteName,
    normalizedSiteKey: normalizeSiteIdentity(siteName, clientName),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * WorkSite 1件を NormalizedShiftRow に変換する。
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
