// 「日報を同期」の流れ（認証 → 取得 → 照合）。画面にも Firebase にも依存しない形にしてある（テストで差し替えるため）。
//
// 失敗したときは { ok: false } を返すだけで、案件のデータには一切触れない
// （呼び出し側は、ok のときだけ結果を案件に書く。通信エラー・権限エラー・見出しの不一致で、前回の実績が消えることはない）。
// 日報に読み取れない回答があるときも同じ（code: 'bad-rows'）。一部だけを取り込んだ結果は作らず、どの回答のどの項目かを返す。
import { RawReportRow, ReportIssue, planReportSync } from '../domain/report';
import { Project, ReportSource, ReportSync, Venue } from '../types';
import { ReportError, ReportErrorCode } from './sheets';

export interface SyncDeps {
  /** 日報を読むための認証（アクセストークン）。利用者の操作（タップ）の中で、最初に呼ぶ */
  token: () => Promise<string>;
  /** 日報の回答を読む */
  rows: (source: ReportSource, token: string) => Promise<RawReportRow[]>;
  /** いまの時刻（ISO 8601） */
  now: () => string;
  /** 認証が無効だったときに、覚えている認証を捨てる。token は、無効だった認証（覚えているものが、それと同じときだけ捨てる） */
  forget: (token: string) => void;
}

export interface SyncInput {
  project: Project;
  /** 同じ置き場所の全案件 */
  projects: Project[];
  venues: Venue[];
  source: ReportSource | null;
}

export type SyncOutcome =
  | { ok: true; sync: ReportSync; source: ReportSource }
  /** issues … 読み取れない回答があって止めたとき（code: 'bad-rows'）の、回答ごとの内容 */
  | { ok: false; code: ReportErrorCode; message: string; issues?: ReportIssue[] };

const fail = (code: ReportErrorCode, message: string): SyncOutcome => ({ ok: false, code, message });

export async function runReportSync({ project, projects, venues, source }: SyncInput, deps: SyncDeps): Promise<SyncOutcome> {
  // 通信しなくても分かる問題は、認証の画面を出す前に知らせる（回答 0 件で照合して、会場・会期が決まっているかだけを見る）
  const pre = planReportSync({ project, projects, venues, rows: [], now: deps.now() });
  if (!pre.ok) return fail('setup', pre.message);
  if (!source?.spreadsheetId) return fail('setup', '日報の場所が、まだ設定されていません。日報のスプレッドシートの URL を貼り付けてください。');

  try {
    // ここまで await していないので、認証のポップアップは利用者のタップの中で開く（Safari は、そうでないポップアップを止める）
    const token = await deps.token();
    let rows: RawReportRow[];
    try {
      rows = await deps.rows(source, token);
    } catch (e) {
      // 無効だったのは、この同期が使った認証。あとから届いた古い同期の失敗で、新しく得た認証を捨てないよう、どの認証かを渡す
      if (e instanceof ReportError && (e.code === 'auth-expired' || e.code === 'no-scope')) deps.forget(token);
      throw e;
    }
    const plan = planReportSync({ project, projects, venues, rows, now: deps.now() });
    if (!plan.ok) {
      // 読み取れない回答がある … 何も取り込まずに止める（前回の実績は、呼び出し側にそのまま残る）
      return plan.issues?.length ? { ok: false, code: 'bad-rows', message: plan.message, issues: plan.issues } : fail('setup', plan.message);
    }
    return { ok: true, sync: plan.sync, source };
  } catch (e) {
    if (e instanceof ReportError) return fail(e.code, e.message);
    return fail('unknown', '日報を同期できませんでした（予期しないエラー）。もう一度お試しください。');
  }
}

/** 同期の結果を案件に書く（実績を丸ごと置き換える。使った日報の場所も記録する） */
export function applySync(p: Project, outcome: Extract<SyncOutcome, { ok: true }>): Project {
  return { ...p, reportSync: outcome.sync, reportSource: outcome.source };
}

// ── 同期できなかったときの記録 ─────────────────────────────────
/** 画面に出す・端末に置く回答の数の上限（読み取れない回答が多いときは、先頭だけ） */
export const MAX_ISSUES_SHOWN = 20;

/** 同期できなかったときの記録（画面に出す。この端末にだけ置き、共有データには入れない） */
export interface SyncFailure {
  /** 失敗した日時（ISO 8601） */
  at: string;
  message: string;
  /** 読み取れない回答があって止めたときの、回答ごとの内容（先頭 MAX_ISSUES_SHOWN 件） */
  issues?: ReportIssue[];
  /** issues に入れなかった件数 */
  more?: number;
  /**
   * 失敗したときに案件が持っていた、最後に成功した同期の日時（`reportSync.at`。まだ同期していなければ ''）。
   * そのあとで、同期の結果が新しくなった（ほかの端末・ほかのタブで同期が成功した）ら、この記録は古いので出さない（failureIsCurrent）。
   * 端末どうしの時計のずれに左右されないよう、時刻の前後ではなく「同じ結果のままか」で見る。
   */
  base?: string;
}

/** 同期の失敗を、記録の形にする。base は、失敗したときに案件が持っていた `reportSync.at`（無ければ ''） */
export function failureOf(out: Extract<SyncOutcome, { ok: false }>, at: string, base: string): SyncFailure {
  const f: SyncFailure = { at, message: out.message, base };
  if (out.issues?.length) {
    f.issues = out.issues.slice(0, MAX_ISSUES_SHOWN);
    if (out.issues.length > MAX_ISSUES_SHOWN) f.more = out.issues.length - MAX_ISSUES_SHOWN;
  }
  return f;
}

/**
 * 端末に置いてあった記録を、画面が前提にしている形にそろえる（形の合わない部分は落とす。記録として扱えなければ null）。
 * 手で書き換えられた・以前の版が書いた記録を読んでも、画面が落ちないようにするため。
 */
export function hydrateFailure(v: unknown): SyncFailure | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  if (typeof f.at !== 'string' || typeof f.message !== 'string') return null;
  const out: SyncFailure = { at: f.at, message: f.message };
  if (Array.isArray(f.issues)) {
    const issues: ReportIssue[] = [];
    for (const x of f.issues) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
      const i = x as Record<string, unknown>;
      if (typeof i.row !== 'number' || !Number.isInteger(i.row) || !Array.isArray(i.items)) continue;
      const items: ReportIssue['items'] = [];
      for (const it of i.items) {
        const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
        if (typeof o.field === 'string' && typeof o.reason === 'string') items.push({ field: o.field, reason: o.reason });
      }
      if (items.length === 0) continue;
      issues.push({ row: i.row, date: typeof i.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : null, items });
    }
    if (issues.length > 0) out.issues = issues.slice(0, MAX_ISSUES_SHOWN);
  }
  if (out.issues && typeof f.more === 'number' && Number.isInteger(f.more) && f.more > 0) out.more = f.more;
  if (typeof f.base === 'string') out.base = f.base;
  return out;
}

/**
 * 失敗の記録を、いまも画面に出すべきか。記録のあとで、案件の同期の結果が新しくなっていたら（syncAt が、記録したときと違う）、出さない
 * （ほかの端末で同期が成功したあとも、この端末に「同期できませんでした」と、直す前の回答の一覧が残るのを防ぐ）。
 * base を持たない記録（以前の版が書いたもの）は、これまでどおり、次に成功するまで出す。
 */
export function failureIsCurrent(f: SyncFailure, syncAt: string | undefined): boolean {
  return f.base === undefined || f.base === (syncAt ?? '');
}
