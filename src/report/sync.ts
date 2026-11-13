// 「日報を同期」の流れ（認証 → 取得 → 照合）。画面にも Firebase にも依存しない形にしてある（テストで差し替えるため）。
//
// 失敗したときは { ok: false } を返すだけで、案件のデータには一切触れない
// （呼び出し側は、ok のときだけ結果を案件に書く。通信エラー・権限エラー・見出しの不一致で、前回の実績が消えることはない）。
import { RawReportRow, planReportSync } from '../domain/report';
import { Project, ReportSource, ReportSync, Venue } from '../types';
import { ReportError, ReportErrorCode } from './sheets';

export interface SyncDeps {
  /** 日報を読むための認証（アクセストークン）。利用者の操作（タップ）の中で、最初に呼ぶ */
  token: () => Promise<string>;
  /** 日報の回答を読む */
  rows: (source: ReportSource, token: string) => Promise<RawReportRow[]>;
  /** いまの時刻（ISO 8601） */
  now: () => string;
  /** 認証が無効だったときに、覚えている認証を捨てる */
  forget: () => void;
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
  | { ok: false; code: ReportErrorCode; message: string };

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
      if (e instanceof ReportError && (e.code === 'auth-expired' || e.code === 'no-scope')) deps.forget();
      throw e;
    }
    const plan = planReportSync({ project, projects, venues, rows, now: deps.now() });
    if (!plan.ok) return fail('setup', plan.message);
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
