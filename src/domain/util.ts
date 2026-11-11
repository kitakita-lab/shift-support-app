export const genId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 数値化。空・不正は 0（入力を禁止しないため、計算側で安全に扱う） */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
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

/** 期間内の日付一覧（両端含む）。不正・逆転は空配列。暴走防止で最大 366 日 */
export function listDates(start: string, end: string): string[] {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e || e < s) return [];
  const out: string[] = [];
  const d = new Date(s);
  while (d <= e && out.length < 366) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
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
