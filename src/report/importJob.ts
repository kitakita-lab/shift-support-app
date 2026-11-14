// 案件一覧の「日報から案件を作成・更新」の、日報の取得。
// 画面（React）にも Firebase にも依存しない（テストで差し替えるため。状態は、画面の部品の外＝このファイルに置く）。
//
// 守ること:
//   - 取得は、同じ置き場所（共有データ／この端末だけのデータ）につき、このタブの中では 1 つずつ。
//     「動いているか」を部品の外に置くので、案件を開いて戻ってきても、取得中のままに見える。
//   - 読んだ回答（必要な列だけ）は、このタブのメモリにだけ置く（端末にも共有データにも保存しない）。
//     置き場所と、ログイン中のアカウントごとに分ける（アカウントを切り替えたあとで、前のアカウントの権限で読んだ内容を使わない）。
//   - やめた取得・あとから始めた取得がある取得の結果は、使わない。
//   - 取得を始めたら、前に読んだ内容は捨てる（取り直しが失敗しても、前の内容を、いまの日報の内容のようには見せない）。
import { RawReportRow } from '../domain/report';
import { ReportSource } from '../types';
import { ReportError, ReportErrorCode } from './sheets';
import { SyncDeps } from './sync';

/** 読んだ日報（このタブのメモリだけに置く） */
export interface FetchedReport {
  /** 読んだ日時（ISO 8601） */
  at: string;
  source: ReportSource;
  /** 必要な列だけの回答（見出しを除く。上から順） */
  rows: RawReportRow[];
}

export type FetchResult =
  | { kind: 'fetched'; report: FetchedReport }
  | { kind: 'failed'; code: ReportErrorCode; message: string; at: string }
  /** このあとに始めた取得がある・利用者がやめた … 何もしない */
  | { kind: 'dropped' };

interface Slot {
  /** 動いている取得（番号と、始めた時刻） */
  running: { seq: number; since: number } | null;
  /** 最後に始めた（または、やめた）取得の番号。この番号の取得だけが、結果を置ける */
  latest: number;
  report: FetchedReport | null;
  failure: { code: ReportErrorCode; message: string; at: string } | null;
  /** いまの日報（report）について、既存の案件の更新を、自動で始めたか（同じ日報で、何度も始めない） */
  autoApplied: boolean;
  /** いまの日報を読んでから、作成した案件の数・更新した案件 */
  created: number;
  updated: Set<string>;
  /** いまの日報で書いた同期の回数（同期の日時を、1 回ごとに進めるため）と、自動の更新をやり直せるようにした回数 */
  stamps: number;
  rearms: number;
}

/** 自動の更新をやり直せる回数の上限（読んだ日報 1 つにつき。やり直しが、やり直しを呼び続けないように） */
const MAX_REARMS = 8;

let counter = 0;
let version = 0;
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
const emit = (): void => { version += 1; for (const l of [...listeners]) l(); };
const slot = (key: string): Slot => {
  let s = slots.get(key);
  if (!s) { s = { running: null, latest: 0, report: null, failure: null, autoApplied: false, created: 0, updated: new Set(), stamps: 0, rearms: 0 }; slots.set(key, s); }
  return s;
};

/** 取得の状態を見分ける名前（置き場所 ＋ ログイン中のアカウント） */
export const fetchKey = (scope: string, uid: string): string => `${scope}:${uid}`;

export const isFetchRunning = (key: string): boolean => !!slots.get(key)?.running;
/** 動いている取得を始めた時刻（ミリ秒）。動いていなければ null */
export const fetchRunningSince = (key: string): number | null => slots.get(key)?.running?.since ?? null;
/** 最後に読めた日報（無ければ null） */
export const fetchedReport = (key: string): FetchedReport | null => slots.get(key)?.report ?? null;
/** 最後の取得の失敗（そのあとで読めていれば null） */
export const fetchFailure = (key: string): Slot['failure'] => slots.get(key)?.failure ?? null;

export function subscribeFetches(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const fetchesVersion = (): number => version;

/** 動いている取得をやめる（結果があとから届いても、使わない）。次の取得を始められるようになる */
export function abandonFetch(key: string): void {
  const s = slots.get(key);
  if (!s?.running) return;
  s.latest = ++counter;
  s.running = null;
  emit();
}

/** 読んだ日報と、失敗の記録を捨てる（ログアウト・アカウントの切り替え・日報の場所の変更のとき） */
export function clearFetched(key?: string): void {
  if (key === undefined) slots.clear(); else slots.delete(key);
  emit();
}

const UNKNOWN_MESSAGE = '日報を取得できませんでした（予期しないエラー）。もう一度お試しください。';

/**
 * 日報を 1 回読む。この置き場所の取得が動いているときは、始めずに null を返す。
 * 認証の画面を、利用者の操作（タップ）の中で開くため、何も待たずに認証を呼ぶ。返す Promise は、失敗しない。
 */
export function startFetch(key: string, source: ReportSource, deps: SyncDeps): Promise<FetchResult> | null {
  const s = slot(key);
  if (s.running) return null;
  const seq = ++counter;
  s.latest = seq;
  s.running = { seq, since: Date.now() };
  // 前に読んだ内容は、ここで捨てる。取り直しが失敗した・やめたときに、前の内容（候補・選択）が画面に残って、
  // 最新の日報で確かめた内容のように使われないようにする（失敗は、失敗として見せる）
  s.report = null;
  s.failure = null;
  s.autoApplied = false;
  s.created = 0;
  s.updated = new Set();
  s.stamps = 0;
  s.rearms = 0;
  emit();
  let token: Promise<string>;
  try { token = deps.token(); } catch (e) { token = Promise.reject(e); }
  return (async (): Promise<FetchResult> => {
    let result: FetchResult;
    try {
      const t = await token;
      let rows: RawReportRow[];
      try {
        rows = await deps.rows(source, t);
      } catch (e) {
        if (e instanceof ReportError && (e.code === 'auth-expired' || e.code === 'no-scope')) deps.forget(t);
        throw e;
      }
      result = { kind: 'fetched', report: { at: deps.now(), source, rows } };
    } catch (e) {
      result = e instanceof ReportError
        ? { kind: 'failed', code: e.code, message: e.message, at: deps.now() }
        : { kind: 'failed', code: 'unknown', message: UNKNOWN_MESSAGE, at: deps.now() };
    }
    const cur = slots.get(key);
    // やめた・あとから始めた取得がある・記録ごと捨てられた（ログアウトなど）… 何も置かない
    if (!cur || cur.latest !== seq) return { kind: 'dropped' };
    if (result.kind === 'fetched') { cur.report = result.report; cur.failure = null; cur.autoApplied = false; cur.created = 0; cur.updated = new Set(); cur.stamps = 0; cur.rearms = 0; }
    else if (result.kind === 'failed') cur.failure = { code: result.code, message: result.message, at: result.at };
    cur.running = null;
    emit();
    return result;
  })();
}

// ── いまの日報についての、作業の記録 ─────────────────────────────
/** 既存の案件の更新を、自動で始める番か（いまの日報について、まだ始めていなければ true を返し、始めたことにする） */
export function claimAutoApply(key: string): boolean {
  const s = slots.get(key);
  if (!s?.report || s.autoApplied) return false;
  s.autoApplied = true;
  return true;
}
/**
 * 既存の案件の更新を、もう一度だけ自動で始められるようにする（いまの日報から案件を作成した直後。
 * 新しい案件ができると、会期のすぐ外にあった回答が、その案件のものになる。前からある案件の「取り込んでいない回答」の記録を、合わせ直す）。
 */
export function rearmAutoApply(key: string): void {
  const s = slots.get(key);
  if (!s?.report || s.rearms >= MAX_REARMS) return;
  s.rearms += 1;
  s.autoApplied = false;
}

/**
 * いまの日報の内容で案件に書くときの、同期の日時。日報を読んだ日時から、書くたびに 1 ミリ秒ずつ進める
 * （書いた時刻ではなく、読んだ日時にするのは、読んだあとで行われた新しい同期と見分けるため。1 回ごとに進めるのは、
 * 同じ日報から 2 回書いたとき（会期を広げる・もう一度反映する）にも、同期の日時が変わるようにするため。
 * 同期の日時は、ほかの画面・端末が「結果が変わったか」を見分けるのに使っている）。読んだ日報が無ければ null。
 */
export function issueStamp(key: string): string | null {
  const s = slots.get(key);
  if (!s?.report) return null;
  const at = new Date(Date.parse(s.report.at) + s.stamps).toISOString();
  s.stamps += 1;
  return at;
}
/** いまの日報の内容で書いた、いちばん新しい同期の日時（まだ書いていなければ、日報を読んだ日時）。これより新しい同期は、読んだあとで行われたもの */
export function latestStamp(key: string): string | null {
  const s = slots.get(key);
  return s?.report ? new Date(Date.parse(s.report.at) + Math.max(0, s.stamps - 1)).toISOString() : null;
}
/** いまの日報から、案件を作成した・更新した、の記録（画面のまとめに出す） */
export function noteCreated(key: string, n: number): void {
  const s = slots.get(key);
  if (!s || n <= 0) return;
  s.created += n;
  emit();
}
export function noteUpdated(key: string, projectId: string): void {
  const s = slots.get(key);
  if (!s || s.updated.has(projectId)) return;
  s.updated.add(projectId);
  emit();
}
export const fetchSession = (key: string): { created: number; updated: number } => {
  const s = slots.get(key);
  return { created: s?.created ?? 0, updated: s?.updated.size ?? 0 };
};
/** いまの日報で、この案件を更新したか */
export const wasUpdated = (key: string, projectId: string): boolean => !!slots.get(key)?.updated.has(projectId);

/** テスト用: 状態を消す */
export function resetFetches(): void {
  slots.clear();
  listeners.clear();
}
