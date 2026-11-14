// 日報の同期の、端末に置く記録（最後に使った日報の場所・最後の失敗の内容・最後の取り込みのまとめ）。
// どれも、この端末（ブラウザ）の中だけに置く。共有データには入れない。
// 案件の「日報を同期」（ReportBar）と、案件一覧の「日報から案件を作成・更新」（ReportImport）の両方が使う。
import { ReportSource } from '../types';
import { SyncFailure, hydrateFailure } from './sync';
import type { SyncJobResult } from './syncJob';

/** 以前の版の記録（置き場所を分けずに、1 つだけ持っていた）。読むだけ */
const SOURCE_KEY_V1 = 'kkl_report_source_v1';
const SOURCE_KEY = 'kkl_report_source_v2';
const ERROR_KEY = 'kkl_report_error_v1';
const IMPORT_KEY = 'kkl_report_import_v1';

function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても、同期そのものには影響しない */ }
}
/** 記録の入れ物（名前 → 記録）。形が壊れていたら、空として扱う */
function loadMap(key: string): Record<string, unknown> {
  const v = load<unknown>(key, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ── 日報の場所 ────────────────────────────────────────────────
function sourceOf(v: unknown): { source: ReportSource; at: string } | null {
  const s = v as { spreadsheetId?: unknown; gid?: unknown; at?: unknown } | null;
  return s && typeof s === 'object' && typeof s.spreadsheetId === 'string' && s.spreadsheetId
    ? { source: { spreadsheetId: s.spreadsheetId, gid: typeof s.gid === 'number' && Number.isFinite(s.gid) ? s.gid : null }, at: typeof s.at === 'string' ? s.at : '' }
    : null;
}
/**
 * この端末で、その置き場所（共有データ／この端末だけのデータ）について最後に使った日報の場所と、それを使った日時（無ければ null）。
 * 置き場所ごとに覚える（この端末だけのデータで試したときの日報を、共有データで、黙って読まないため）。
 * 日時は、案件に記録されている場所（ほかの端末が使った場所）と、どちらが新しいかを比べるために持つ。
 * 以前の版の記録（置き場所の区別も、日時も無い）は、その置き場所の記録が無いときにだけ使う（日時は '' ＝ 案件に記録があれば、そちらが優先される）。
 */
export function loadSourceRecord(scope: string): { source: ReportSource; at: string } | null {
  const own = sourceOf(loadMap(SOURCE_KEY)[scope]);
  if (own) return own;
  const old = sourceOf(load<unknown>(SOURCE_KEY_V1, null));
  return old ? { source: old.source, at: '' } : null;
}
/** この端末で、その置き場所について最後に使った日報の場所（無ければ null） */
export const loadSource = (scope: string): ReportSource | null => loadSourceRecord(scope)?.source ?? null;
export function saveSource(scope: string, source: ReportSource): void {
  const all = loadMap(SOURCE_KEY);
  all[scope] = { spreadsheetId: source.spreadsheetId, gid: source.gid, at: new Date().toISOString() };
  save(SOURCE_KEY, all);
}

// ── 案件ごとの、最後の失敗 ─────────────────────────────────────
// このタブで記録した失敗。端末にも置くが、置けなかったとき（保存領域がいっぱい・保存できない設定）でも、
// このタブでは表示できるように、メモリにも持つ（失敗したのに、何も表示されない、を防ぐ）
const recent = new Map<string, SyncFailure | null>();
/** この案件（key ＝ 置き場所 ＋ 案件の ID）の、最後の失敗の記録 */
export const lastFailure = (key: string): SyncFailure | null => (recent.has(key) ? recent.get(key) ?? null : hydrateFailure(loadMap(ERROR_KEY)[key]));
/** 失敗の記録を、このタブのメモリと、端末に置く（null … 消す） */
export function recordFailure(key: string, f: SyncFailure | null): void {
  recent.set(key, f);
  const all = loadMap(ERROR_KEY);
  if (f) all[key] = f; else delete all[key];
  save(ERROR_KEY, all);
}

/**
 * 案件の同期 1 回の結果を、端末の記録に反映する（成功 … 日報の場所を覚え、失敗の記録を消す ／ 失敗 … 内容を記録する）。
 * 結果を使わない（このあとに始めた同期がある・利用者がやめた）ときは、何もしない。
 *   scope … 案件の置き場所（日報の場所は、置き場所ごとに覚える）
 */
export function recordSyncResult(key: string, r: SyncJobResult, source: ReportSource | null, scope: string): void {
  if (r.kind === 'dropped') return;
  if (r.kind === 'applied') {
    saveSource(scope, r.outcome.source);
    recordFailure(key, null);
    return;
  }
  // 案件のデータには触れていない（読み取れない回答があるときも、何も取り込まない）
  recordFailure(key, r.failure);
  // 読み取れない回答で止めたときは、日報そのものは読めている。場所だけは、この端末に覚えておく（直したあとで、URL を貼り直さずに同期できるように）
  if (r.code === 'bad-rows' && source?.spreadsheetId) saveSource(scope, source);
}

// ── 案件一覧の「日報から案件を作成・更新」の、最後のまとめ ──────────────────
/**
 * 最後に日報を読んだときのまとめ（画面を開き直したときに、いつ・何件読んだかを出す。回答の中身は持たない）。
 * 置き場所 ＋ アカウントごとに置く（ほかのアカウントが読んだときの件数を、次の人に見せない）。
 */
export interface ImportRecord {
  /** 読んだ日時（ISO 8601） */
  at: string;
  /** 読んだ回答の数（テスト回答を除く） */
  rows: number;
}
export function loadImportRecord(key: string): ImportRecord | null {
  const v = loadMap(IMPORT_KEY)[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return typeof r.at === 'string' ? { at: r.at, rows: typeof r.rows === 'number' && Number.isFinite(r.rows) ? r.rows : 0 } : null;
}
export function saveImportRecord(key: string, rec: ImportRecord): void {
  // 持つのは、いま読んだアカウントの分だけ（以前の記録・ほかのアカウントの記録は、残さない）
  save(IMPORT_KEY, { [key]: { at: rec.at, rows: rec.rows } });
}
