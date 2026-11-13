// 日報（Google フォームの回答が入るスプレッドシート）の読み取り・照合・集計（純関数）。
// 通信はここでは行わない（取得は report/sheets.ts、同期の流れは report/sync.ts）。設計は docs/02_新アプリ設計書.md「6. Version 4」。
//
// 考え方:
//   - 照合は「会場＋会期」。開催日が案件の会期内（両端を含む）で、会場名が案件の会場（または登録した別名）と一致する回答だけを対象にする。
//     イベント名は照合に使わない。会場名は、全角/半角・空白・英字の大小だけをそろえて比べる（部分一致・あいまい一致はしない）。
//   - 結果は、その案件の「日別の実績」を丸ごと作り直す（足し込まない）。同じ日報を何度読んでも同じ結果になり、
//     日報の修正・削除もそのまま反映される。
//   - どの案件の実績か決められない回答（同じ会場で会期が重なる案件がある日）は、取り込まずに保留して利用者に確認を求める。
//   - テスト回答は取り込まない。
import {
  Project, ReportDay, ReportHeld, ReportSkip, ReportSkipReason, ReportSource, ReportSync, ReportUnmatched, Venue,
} from '../types';
import { listDates } from './util';

// ── 見出し ───────────────────────────────────────────────────
/** 取得する列の見出し名。メールアドレス・入力者・自由記述の列は、ここに無いので取得しない */
export const REPORT_HEADERS = {
  date: '開催日',
  venue: '会場',
  venueOther: '会場（その他の場合）',
  event: 'イベント名',
  count: 'キットの使用数',
} as const;
export type ReportField = keyof typeof REPORT_HEADERS;
/** 無いと取り込めない列。会場（その他の場合）・イベント名は、無くても取り込める */
export const REQUIRED_FIELDS: ReportField[] = ['date', 'venue', 'count'];
/** 日報のタブ名の既定値（Google フォームが作る名前） */
export const DEFAULT_SHEET_TITLE = 'フォームの回答 1';
/** 会場の選択肢のうち、「会場（その他の場合）」の列を見るもの */
const OTHER_VENUE = 'その他';

/** 見出し・会場名を比べるためにそろえる（全角/半角・空白・英字の大小だけ。文字そのものは変えない） */
export function venueKey(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export type ColumnMap = Record<ReportField, number | null>;
export type ColumnResult =
  | { ok: true; cols: ColumnMap }
  | { ok: false; missing: string[]; duplicated: string[] };

/**
 * 見出し行から、取得する列の位置を決める。位置（D 列・L 列…）で決め打ちにしない
 * （フォームの質問が増減して列がずれたときに、別の列の数字を取り込まないため）。
 * 必要な見出しが無い・同じ見出しが 2 つ以上ある場合は、取り込まずにエラーにする。
 */
export function findReportColumns(headerRow: unknown[]): ColumnResult {
  const keys = headerRow.map(venueKey);
  const cols = {} as ColumnMap;
  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const field of Object.keys(REPORT_HEADERS) as ReportField[]) {
    const want = venueKey(REPORT_HEADERS[field]);
    const at = keys.reduce<number[]>((a, k, i) => (k === want ? [...a, i] : a), []);
    if (at.length > 1) duplicated.push(REPORT_HEADERS[field]);
    if (at.length === 0 && REQUIRED_FIELDS.includes(field)) missing.push(REPORT_HEADERS[field]);
    cols[field] = at.length === 1 ? at[0] : null;
  }
  return missing.length || duplicated.length ? { ok: false, missing, duplicated } : { ok: true, cols };
}

/** 列の位置（0 始まり）を A1 形式の列名にする（0 → A、25 → Z、26 → AA） */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ── 1 件の回答の読み取り ───────────────────────────────────────
/** 日報の 1 行から取り出した値（スプレッドシートのセルの値そのまま） */
export interface RawReportRow {
  date: unknown;
  venue: unknown;
  venueOther: unknown;
  event: unknown;
  count: unknown;
}

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;   // 2/30 など
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 開催日を "YYYY-MM-DD" にする。読み取れなければ null。
 *   - 数値: スプレッドシートの日付の通し番号（1899-12-30 からの日数）
 *   - 文字列: 2026/07/31・2026-7-31・2026.7.31・2026年7月31日（後ろに時刻や曜日が付いていてもよい）
 * 年の無い日付・月日の順が分からない日付（7/31/2026 など）は、推測せずに「読み取れない」とする。
 */
export function parseReportDate(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const days = Math.floor(v);
    if (days < 32874 || days > 73415) return null;             // 1990-01-01 〜 2100-12-31 の外は、日付の通し番号とみなさない
    const t = new Date(Date.UTC(1899, 11, 30 + days));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').trim();
  const m = /^(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?(?:\s*\(.\))?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  return m ? ymd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** キットの使用数を、0 以上の整数として読む。空欄・数字でない・小数・マイナスは null（＝読み取れない） */
export function parseReportCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 9999999 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[\s,]/g, '');
  return /^\d{1,7}$/.test(s) ? Number(s) : null;
}

const text = (v: unknown): string => (v == null ? '' : String(v)).trim();
/** 何も入っていない行（途中の空行・消された回答）か */
export function isBlankRow(r: RawReportRow): boolean {
  return [r.date, r.venue, r.venueOther, r.event, r.count].every((v) => text(v) === '');
}

/** 回答の会場名。会場が「その他」のときは「会場（その他の場合）」を見る。どちらも空なら null */
export function reportVenue(r: RawReportRow): { name: string; key: string } | null {
  const main = text(r.venue);
  const other = text(r.venueOther);
  const name = main === '' || venueKey(main) === venueKey(OTHER_VENUE) ? other : main;
  const key = venueKey(name);
  return key ? { name, key } : null;
}

/** テスト回答か（会場名かイベント名に「テスト」「test」が入っている）。イベント名は、この判定にだけ使う */
export function isTestRow(r: RawReportRow): boolean {
  const s = [r.venue, r.venueOther, r.event].map((v) => text(v).normalize('NFKC')).join('\n');
  return s.includes('テスト') || /(^|[^a-z])test([^a-z]|$)/i.test(s);
}

// ── 案件との照合 ──────────────────────────────────────────────
/** 案件の会場に対応する、日報での会場名（会場名そのものと、登録した別名）。そろえた形で返す */
export function venueKeys(venue: Venue | undefined): Set<string> {
  const out = new Set<string>();
  if (!venue) return out;
  for (const n of [venue.name, ...(venue.reportNames ?? [])]) {
    const k = venueKey(n);
    if (k) out.add(k);
  }
  return out;
}

export interface SyncInput {
  /** 同期する案件 */
  project: Project;
  /** 同じ置き場所にある全案件（会期が重なる案件を見つけるため。自分を含んでよい） */
  projects: Project[];
  venues: Venue[];
  /** 日報の回答（見出しを除く。上から順） */
  rows: RawReportRow[];
  /** 同期した日時（ISO 8601） */
  now: string;
}
export type SyncPlan = { ok: true; sync: ReportSync } | { ok: false; message: string };

interface Rival { name: string; keys: Set<string>; dates: Set<string>; claims: Set<string> }

/**
 * 日報の回答から、案件の「同期の結果」を作る。案件や日報は書き換えない。
 * 会場または会期が決まっていない案件は、照合できないのでエラーにする。
 */
export function planReportSync({ project: p, projects, venues, rows, now }: SyncInput): SyncPlan {
  const venue = venues.find((v) => v.id === p.venueId);
  if (!p.venueId || !venue) return { ok: false, message: '案件の会場が未選択です。基本情報で会場を選んでから、もう一度同期してください。' };
  const keys = venueKeys(venue);
  if (keys.size === 0) return { ok: false, message: `会場マスタの会場名が未入力です。会場名を入力してから、もう一度同期してください。` };
  const dates = new Set(listDates(p.startDate, p.endDate));
  if (dates.size === 0) return { ok: false, message: '案件の会期（開始日・終了日）が正しく入力されていません。基本情報で確認してから、もう一度同期してください。' };

  // 同じ会場名で、会期が重なりうるほかの案件（中止の案件は実績を持たないので相手にしない）
  const rivals: Rival[] = [];
  for (const q of projects) {
    if (q.id === p.id || q.status === '中止') continue;
    const qKeys = venueKeys(venues.find((v) => v.id === q.venueId));
    if (![...qKeys].some((k) => keys.has(k))) continue;
    const qDates = new Set(listDates(q.startDate, q.endDate));
    if (![...qDates].some((d) => dates.has(d))) continue;
    rivals.push({ name: q.name || '（名称未設定）', keys: qKeys, dates: qDates, claims: new Set(q.reportClaims ?? []) });
  }
  const claims = new Set(p.reportClaims ?? []);

  const days = new Map<string, ReportDay>();
  const held = new Map<string, ReportHeld>();
  const unmatched = new Map<string, ReportUnmatched>();
  const skipped = new Map<ReportSkipReason, { rows: number; dates: Set<string> }>();
  const skip = (reason: ReportSkipReason, date: string | null) => {
    const s = skipped.get(reason) ?? { rows: 0, dates: new Set<string>() };
    s.rows += 1;
    if (date) s.dates.add(date);
    skipped.set(reason, s);
  };
  let rowsRead = 0, rowsUsed = 0, tests = 0;

  for (const r of rows) {
    if (isBlankRow(r)) continue;
    rowsRead += 1;
    if (isTestRow(r)) { tests += 1; continue; }
    const v = reportVenue(r);
    const date = parseReportDate(r.date);
    const mine = !!v && keys.has(v.key);
    if (!date) { if (mine) skip('bad-date', null); continue; }
    if (!dates.has(date)) continue;                               // 会期の外（ほかの会期の回答）
    if (!v) { skip('no-venue', date); continue; }
    const count = parseReportCount(r.count);
    if (!mine) {
      const u = unmatched.get(v.key) ?? { venue: v.name, rows: 0, count: 0, dates: [] };
      u.rows += 1;
      u.count += count ?? 0;
      if (!u.dates.includes(date)) u.dates.push(date);
      unmatched.set(v.key, u);
      continue;
    }
    if (count == null) { skip('bad-count', date); continue; }

    // 同じ会場名・同じ日を会期に含む案件がほかにあるか
    const others = rivals.filter((q) => q.keys.has(v.key) && q.dates.has(date));
    if (others.length > 0) {
      const theirs = others.filter((q) => q.claims.has(date));
      if (!claims.has(date) && theirs.length > 0) { skip('other-project', date); continue; }
      if (!claims.has(date) || theirs.length > 0) {
        const h = held.get(date) ?? { date, count: 0, rows: 0, others: [] };
        h.count += count;
        h.rows += 1;
        for (const q of others) if (!h.others.includes(q.name)) h.others.push(q.name);
        held.set(date, h);
        continue;
      }
    }
    const d = days.get(date) ?? { date, count: 0, rows: 0 };
    d.count += count;
    d.rows += 1;
    days.set(date, d);
    rowsUsed += 1;
  }

  const byDate = <T extends { date: string }>(a: T, b: T) => a.date.localeCompare(b.date);
  const ORDER: ReportSkipReason[] = ['bad-date', 'bad-count', 'no-venue', 'other-project'];
  const sync: ReportSync = {
    at: now,
    venueId: p.venueId,
    startDate: p.startDate,
    endDate: p.endDate,
    days: [...days.values()].sort(byDate),
    rowsRead,
    rowsUsed,
    tests,
    skipped: ORDER.filter((k) => skipped.has(k)).map<ReportSkip>((k) => ({ reason: k, rows: skipped.get(k)!.rows, dates: [...skipped.get(k)!.dates].sort() })),
    held: [...held.values()].sort(byDate),
    unmatched: [...unmatched.values()]
      .map((u) => ({ ...u, dates: [...u.dates].sort() }))
      .sort((a, b) => b.rows - a.rows || a.venue.localeCompare(b.venue)),
  };
  return { ok: true, sync };
}

// ── 同期の結果の使い方 ─────────────────────────────────────────
/**
 * いまの案件に対して使える、日報の実績（日付 → 1 日分）。
 *   - 同期のあとで会場を変えた場合は、使わない（別の会場の実績を、この案件の実績にしないため）
 *   - 会期の外になった日は、使わない
 */
export function usableReportDays(p: Project): Map<string, ReportDay> {
  const out = new Map<string, ReportDay>();
  const s = p.reportSync;
  if (!s || s.venueId !== p.venueId || !Array.isArray(s.days)) return out;
  const dates = new Set(listDates(p.startDate, p.endDate));
  for (const d of s.days) if (dates.has(d.date)) out.set(d.date, d);
  return out;
}

/**
 * 会場名が一致しなかった回答のうち、「この案件の実績が無い日」のもの。
 * 同じ会期に、別の会場で別のイベントがあるのはふつうのことなので、一致しない回答があるだけでは確認を求めない。
 * この案件の実績が入っていない日に、別の書き方の会場名の回答があるときだけ、「書き方が違うだけかもしれない」として確認を求める。
 */
export function unmatchedGaps(sync: ReportSync | undefined): ReportUnmatched[] {
  if (!sync) return [];
  const have = new Set([...(sync.days ?? []).map((d) => d.date), ...(sync.held ?? []).map((h) => h.date)]);
  return (sync.unmatched ?? []).filter((u) => u.dates.some((d) => !have.has(d)));
}

/** 同期のあとで、案件の会場・会期が変わっているか（変わっていれば、同期のやり直しを勧める） */
export function syncStaleness(p: Project): { venue: boolean; period: boolean } {
  const s = p.reportSync;
  if (!s) return { venue: false, period: false };
  return { venue: s.venueId !== p.venueId, period: s.startDate !== p.startDate || s.endDate !== p.endDate };
}

// ── 日報の場所 ────────────────────────────────────────────────
/**
 * 貼り付けられた文字列（スプレッドシートの URL、または ID）から、日報の場所を取り出す。読み取れなければ null。
 * 公開用のリンク（/d/e/…/pubhtml）は受け付けない（公開された日報を前提にしないため）。
 */
export function parseSheetUrl(input: string): ReportSource | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return { spreadsheetId: s, gid: null };
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,})(?:[/?#]|$)/.exec(s);
  if (!m) return null;
  const g = /[?#&]gid=(\d+)/.exec(s);
  return { spreadsheetId: m[1], gid: g ? Number(g[1]) : null };
}

/**
 * 同期に使う日報の場所。案件に記録があればそれ、無ければ、同じ置き場所のほかの案件が最後に使った場所
 * （一度どこかの案件で同期すれば、ほかの案件・ほかの端末でも、場所を入れ直さずに同期できる）。
 */
export function findReportSource(p: Project, projects: Project[]): ReportSource | null {
  if (p.reportSource?.spreadsheetId) return p.reportSource;
  let best: Project | null = null;
  for (const q of projects) {
    if (!q.reportSource?.spreadsheetId) continue;
    if (!best || (q.reportSync?.at ?? '') > (best.reportSync?.at ?? '')) best = q;
  }
  return best?.reportSource ?? null;
}
