// 同じ案件の日報の同期が重なっても、古い同期の結果が、新しい実績を上書きしないようにする。
// 画面（React）にも Firebase にも依存しない（テストで差し替えるため。状態は、画面の部品の外＝このファイルに置く）。
//
// 守ること:
//   1. 同じ案件の同期は、このタブの中では 1 つずつ。動いている間は、次を始めない。
//      「動いているか」を部品の外に置くので、案件の画面を閉じて開き直しても、同期中のままに見える
//      （以前は、開き直すと「同期していない」状態に見え、2 つ目の同期を始められた）。
//   2. それでも重なったとき（利用者が同期をやめて、やり直した）は、あとから始めた同期だけが、結果を書ける。
//      先に始めた同期の結果は、成功でも失敗でも捨てる。あとから始めた同期が失敗していても、先の結果は書かない
//      （先の同期は、古い条件〔割り当ての決定・別名・日報の場所〕で照合していることがあるため）。
//   3. 結果を書く直前に、案件が持っている同期の結果が、同期を始めたときのままかを確かめる。
//      変わっていたら（ほかの端末・ほかのタブの同期の結果が、先に届いた）、書かない。
//
// 守れないこと: 2 台の端末の同期が、ほぼ同時に終わったとき（相手の結果が、まだこの端末に届いていない間）。
//   そのときは、あとからサーバーに届いたほうが残る（どちらか一方の、欠けのない結果。2 つが混ざることはない）。
//   詳しくは docs/02_新アプリ設計書.md の 6.2。
import { Project } from '../types';
import { ReportErrorCode } from './sheets';
import { SyncDeps, SyncFailure, SyncInput, SyncOutcome, applySync, failureOf, runReportSync } from './sync';

// ── 順番の札（案件ごと） ─────────────────────────────────────
interface Ticket { key: string; seq: number }

let counter = 0;
/** 案件ごとの、最後に始めた（または、やめた）同期の番号。この番号の同期だけが、結果を書ける */
const latest = new Map<string, number>();
/** 案件ごとの、動いている同期の番号 */
const running = new Map<string, number>();
const listeners = new Set<() => void>();
/** 同期が始まった・終わった・やめたときに増える番号（画面が、状態を読み直すきっかけにする） */
let version = 0;
const emit = (): void => { version += 1; for (const l of [...listeners]) l(); };

function begin(key: string): Ticket {
  const seq = ++counter;
  latest.set(key, seq);
  running.set(key, seq);
  emit();
  return { key, seq };
}
const isLatest = (t: Ticket): boolean => latest.get(t.key) === t.seq;
function end(t: Ticket): void {
  if (running.get(t.key) !== t.seq) return;      // やめたあとで、次の同期が動いている … その印は消さない
  running.delete(t.key);
  emit();
}

/** 同期の状態を見分ける名前（案件の置き場所 ＋ 案件の ID。同じ ID の案件が、共有と端末の両方にあっても取り違えない） */
export const syncKey = (scope: string, projectId: string): string => `${scope}:${projectId}`;

/** この案件の同期が、このタブで動いているか */
export const isSyncRunning = (key: string): boolean => running.has(key);

/**
 * 動いている同期をやめる（結果があとから届いても、使わない）。次の同期を始められるようになる。
 * 通信そのものは止めない（Google の確認画面を開いたままにした、など、終わらない同期から抜けるための出口）。
 */
export function abandonSync(key: string): void {
  if (!running.has(key)) return;
  latest.set(key, ++counter);                    // 動いている同期の札を無効にする
  running.delete(key);
  emit();
}

/** 同期が始まった・終わった・やめたときに呼ばれる（画面の「同期中」の表示に使う） */
export function subscribeSyncJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** 同期が始まった・終わった・やめたときに変わる値（React の useSyncExternalStore に渡す） */
export const syncJobsVersion = (): number => version;

// ── 同期 1 回 ───────────────────────────────────────────────
export interface SyncJobIo {
  /** 同期を始めた置き場所の、いまの案件（画面の描画を待たずに読む）。削除された・読めないときは undefined */
  current: () => Project | undefined;
  /** 案件を書き換える。fn は、書き込む直前の案件を受け取る（同じ案件について、2 回呼ばれても同じ結果を返す） */
  update: (fn: (p: Project) => Project) => void;
  /**
   * 結果が決まったときに、1 回だけ呼ばれる。呼ばれている間は、まだ「同期中」（isSyncRunning）。
   * 端末に置く記録（失敗の内容など）は、ここで書く。そのあとで「同期中」が消え、画面が記録を読み直す。
   */
  settled?: (result: SyncJobResult) => void;
}

export type SyncJobResult =
  /** 結果を案件に書いた */
  | { kind: 'applied'; outcome: Extract<SyncOutcome, { ok: true }> }
  /** 書かなかった（案件のデータには触れていない）。failure は、画面に出す記録 */
  | { kind: 'failed'; code: ReportErrorCode | 'superseded' | 'gone'; failure: SyncFailure }
  /** このあとに始めた同期がある・利用者がやめた … 何もしない（記録も残さない） */
  | { kind: 'dropped' };

/** 案件が持っている同期の結果の印（同期した日時。まだ同期していなければ ''） */
export const syncStamp = (p: Project): string => p.reportSync?.at ?? '';

export const SUPERSEDED_MESSAGE = 'この同期の途中で、案件の同期の結果が、ほかの操作（ほかの端末・ほかのタブでの同期など）で変わりました。あとから届いたこの同期の結果は、使っていません（いまの結果を、そのまま残しています）。もう一度「日報を同期」を押すと、最新の日報で取り込み直します。';
export const GONE_MESSAGE = '同期の結果を保存できませんでした（同期の途中で、案件が削除されたか、ログアウトなどで、共有データを読めない状態になりました）。案件を開き直して、もう一度お試しください。';
const UNKNOWN_MESSAGE = '日報を同期できませんでした（予期しないエラー）。もう一度お試しください。';

function settle(ticket: Ticket, base: string, out: SyncOutcome, deps: SyncDeps, io: SyncJobIo): SyncJobResult {
  // 2. このあとに始めた同期がある（または、やめた）… 成功でも失敗でも、何もしない
  if (!isLatest(ticket)) return { kind: 'dropped' };
  const now = io.current();
  const refuse = (code: 'superseded' | 'gone', message: string, at: string): SyncJobResult =>
    ({ kind: 'failed', code, failure: failureOf({ ok: false, code: 'unknown', message }, deps.now(), at) });
  if (!out.ok) return { kind: 'failed', code: out.code, failure: failureOf(out, deps.now(), now ? syncStamp(now) : base) };
  if (!now) return refuse('gone', GONE_MESSAGE, base);
  // 3. 同期を始めたあとで、案件の同期の結果が変わっている … 書かない
  if (syncStamp(now) !== base) return refuse('superseded', SUPERSEDED_MESSAGE, syncStamp(now));
  // 書き込みは、あとで（画面の描画のときに）行われることがある。書く直前の案件でも、同じことを確かめる
  io.update((cur) => (syncStamp(cur) === base ? applySync(cur, out) : cur));
  return { kind: 'applied', outcome: out };
}

/**
 * 同期を 1 回行う。この案件の同期が動いているときは、始めずに null を返す。
 * 認証の画面を、利用者の操作（タップ）の中で開くため、何も待たずに runReportSync（→ 認証）を呼ぶ。
 * 返す Promise は、失敗しない（結果は SyncJobResult で返す）。
 */
export function startSyncJob(key: string, input: SyncInput, deps: SyncDeps, io: SyncJobIo): Promise<SyncJobResult> | null {
  if (running.has(key)) return null;
  const ticket = begin(key);
  const base = syncStamp(input.project);
  let started: Promise<SyncOutcome>;
  try {
    started = runReportSync(input, deps);
  } catch (e) {
    started = Promise.reject(e);
  }
  return (async (): Promise<SyncJobResult> => {
    let result: SyncJobResult;
    try {
      result = settle(ticket, base, await started, deps, io);
    } catch {
      result = isLatest(ticket)
        ? { kind: 'failed', code: 'unknown', failure: failureOf({ ok: false, code: 'unknown', message: UNKNOWN_MESSAGE }, new Date().toISOString(), base) }
        : { kind: 'dropped' };
    }
    try { io.settled?.(result); } catch { /* 記録できなくても、同期中の印は必ず消す */ } finally { end(ticket); }
    return result;
  })();
}

/** テスト用: 状態を消す（番号は戻さない。前のテストの同期が残っていても、札が重ならないように） */
export function resetSyncJobs(): void {
  latest.clear();
  running.clear();
  listeners.clear();
}
