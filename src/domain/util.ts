export const genId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 数値化。空・不正は 0（入力を禁止しないため、計算側で安全に扱う） */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 円未満の四捨五入（ちょうど 0.5 は切り上げ）。
 * 2進小数の誤差（例: 1.15 × 50 が 57.49999999999999 になる）で 1 円ずれないよう、
 * 小数第6位で丸めてから四捨五入する。
 */
export function roundYen(v: number): number {
  return Math.round(Number(num(v).toFixed(6)));
}

export function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** listDates が返す日数の上限（暴走防止）。超えた分は試算・配置表に入らない */
export const MAX_DAYS = 366;

/** 開始日〜終了日の日数（両端含む・上限なし）。不正・逆転は 0。上限超えの警告用 */
export function daySpan(start: string, end: string): number {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e || e < s) return 0;
  return Math.round((Date.UTC(e.getFullYear(), e.getMonth(), e.getDate()) - Date.UTC(s.getFullYear(), s.getMonth(), s.getDate())) / 86400000) + 1;
}

/** 期間内の日付一覧（両端含む）。不正・逆転は空配列。暴走防止で最大 MAX_DAYS 日 */
export function listDates(start: string, end: string): string[] {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e || e < s) return [];
  const out: string[] = [];
  const d = new Date(s);
  while (d <= e && out.length < MAX_DAYS) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * 端末のタイムゾーンでの日付 "YYYY-MM-DD"。
 * toISOString() は UTC の日付になるため、日本では午前 9 時まで前日の日付になってしまう。
 */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
/** "2026-11-14" → "11/14(土)" */
export function shortDate(s: string): string {
  const d = parseDate(s);
  return d ? `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})` : s;
}

/** "HH:MM" → 分。不正は null */
export function toMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
export function circled(n: number): string {
  return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `(${n})`;
}
