// 「日報を同期」の流れ（認証 → 取得 → 照合）。画面にも Firebase にも依存しない形にしてある（テストで差し替えるため）。
//
// 失敗したときは { ok: false } を返すだけで、案件のデータには一切触れない
// （呼び出し側は、ok のときだけ結果を案件に書く。通信エラー・権限エラー・見出しの不一致で、前回の実績が消えることはない）。
// 日報に読み取れない回答があるときも同じ（code: 'bad-rows'）。一部だけを取り込んだ結果は作らず、どの回答のどの項目かを返す。
import { clearNotHeld, markNotHeld } from '../domain/jcos';
import { PeriodChange, RawReportRow, ReportIssue, hasAutoPeriod, planProjectSync, planReportSync, renamedForPeriod } from '../domain/report';
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
  /**
   * 利用者が選んだ、広げたあとの会期（「会期を広げて取り込む」）。無ければ、日報から自動で決めた会期のままの案件だけ、
   * 日報に連続する日が増えていたら、自動で会期を伸ばす（domain/report.ts の planProjectSync）。
   */
  period?: { startDate: string; endDate: string };
  /**
   * 前回の同期で入った実績が、すべて外れることになる結果でも、書く（利用者が「前回の実績を外す」を押したとき）。
   * 無ければ、そのような結果は書かずに止めて、確認を求める（code: 'confirm-clear'。clearedBySync）。
   */
  allowClear?: boolean;
}

/**
 * 前回の同期で入った実績（外れることになる分。日数・個数の合計）。
 * source … 確認を求めた同期が読んだ日報の場所（「前回の実績を外す」は、同じ日報を読み直して書く。開き直したあとでも、別の日報を読まないように）
 */
export interface ClearedResults { days: number; count: number; source?: ReportSource }

export type SyncOutcome =
  /** period … 同期と一緒に行う、会期の変更（日報に合わせて広げる）。無ければ、会期は変えない */
  | { ok: true; sync: ReportSync; source: ReportSource; period?: PeriodChange }
  /**
   * issues … 読み取れない回答があって止めたとき（code: 'bad-rows'）の、回答ごとの内容
   * clear … 前回の実績が、すべて外れることになるので止めたとき（code: 'confirm-clear'）の、外れることになる実績
   */
  | { ok: false; code: ReportErrorCode; message: string; issues?: ReportIssue[]; clear?: ClearedResults };

/**
 * この結果を書くと、前回の同期で入った実績が、**すべて**外れることになるか（前回の実績の日数・個数。そうでなければ null）。
 * 案件の回答が、日報から 1 件も無くなったとき（削除された・別の会場名や開催日に直された）のほか、照合が切れたとき
 * （会場マスタの会場名・別名を変えた・案件の会場や会期を変えた・別のスプレッドシートを指定した）にも起きる。
 * 自動で外すと、利用者が気づかないうちに、案件の実績が消える。書かずに止めて、利用者に確かめる（オーナーの判断 2026-11-15「自動では削除せず、確認を求める」）。
 *
 * 確認を求めないもの（これまでどおり書く）:
 *   - 回答が一部だけ無くなった（今回の結果に、実績の日が残っている）… 日報のとおりに置き換える
 *   - 前回の実績のあった日が、**どれも**、今回は「保留の日」（会期が重なる案件があって、どちらの実績か決まっていない）か、
 *     「相手の案件が、自分の実績にすると決めた日」になっている … 回答は日報に残っていて、行き先が変わっただけ（割り当ての操作の結果）
 * 保留の日・相手の案件の日が 1 日でもあれば止めない、とはしない（その日とは関係の無い日の実績が、確かめずに外れるため）。
 */
export function clearedBySync(stored: ReportSync | undefined, next: ReportSync): ClearedResults | null {
  const days = Array.isArray(stored?.days) ? stored!.days : [];
  if (days.length === 0 || next.days.length > 0) return null;
  const explained = new Set<string>([
    ...next.held.map((h) => h.date),
    ...next.skipped.filter((s) => s.reason === 'other-project').flatMap((s) => s.dates),
  ]);
  if (days.every((d) => explained.has(d.date))) return null;
  // 個数は、表示のための合計（保存してあった値の形が崩れていても、0 以上の整数になるようにする）
  const whole = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
  return { days: days.length, count: days.reduce((n, d) => n + whole(d.count), 0) };
}

export const clearMessage = (c: ClearedResults): string =>
  `この日報に、この案件の実績になる回答が、1 件もありません。前回の同期で入った実績（${c.days} 日・キット ${c.count} 個）は、外していません（自動では外しません）。`
  + '回答が日報から削除されたか、別の会場名・開催日に直された可能性があります（会場マスタの会場名・別名や、案件の会場・会期を変えたとき、別のスプレッドシートを指定したときにも起きます）。'
  + '日報を確かめて、日報のとおりにするときだけ、「前回の実績を外す」を押してください。';

const fail = (code: ReportErrorCode, message: string): SyncOutcome => ({ ok: false, code, message });

export async function runReportSync({ project, projects, venues, source, period, allowClear }: SyncInput, deps: SyncDeps): Promise<SyncOutcome> {
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
    const { plan, change } = planProjectSync({ project, projects, venues, rows, now: deps.now(), period });
    if (!plan.ok) {
      // 読み取れない回答がある … 何も取り込まずに止める（前回の実績は、呼び出し側にそのまま残る。会期も変えない）
      return plan.issues?.length ? { ok: false, code: 'bad-rows', message: plan.message, issues: plan.issues } : fail('setup', plan.message);
    }
    // 前回の実績が、すべて外れることになる結果は、利用者が確かめるまで書かない（前回の実績は、呼び出し側にそのまま残る。会期も変えない）
    const clear = allowClear ? null : clearedBySync(project.reportSync, plan.sync);
    if (clear) return { ok: false, code: 'confirm-clear', message: clearMessage(clear), clear: { ...clear, source } };
    return { ok: true, sync: plan.sync, source, ...(change ? { period: change } : {}) };
  } catch (e) {
    if (e instanceof ReportError) return fail(e.code, e.message);
    return fail('unknown', '日報を同期できませんでした（予期しないエラー）。もう一度お試しください。');
  }
}

/**
 * 同期の結果を案件に書く（実績を丸ごと置き換える。使った日報の場所も記録する）。
 * 会期の変更をともなう同期（日報に合わせて会期を変える）は、案件の会期が、同期を始めたときのままのときだけ、会期も変える。
 * 利用者が、同期の途中で会期を変えていたら、会期はそのままにする（実績だけを書く。画面は「会期が変わっています」と知らせ、
 * いまの会期の中の日の実績だけを使う）。
 */
export function applySync(p: Project, outcome: Extract<SyncOutcome, { ok: true }>): Project {
  const next: Project = { ...p, reportSync: outcome.sync, reportSource: outcome.source };
  // 「開催していない日」としてあった日に、回答が入っていたら、印を外す（開催した日＝請求する日に戻る。アルバイトは、配置を入れるまで 0 人）
  if (next.jcos) next.jcos = clearNotHeld(next.jcos, outcome.sync.days.map((d) => d.date));
  const c = outcome.period;
  if (!c || p.startDate !== c.from.startDate || p.endDate !== c.from.endDate) return next;
  next.startDate = c.to.startDate;
  next.endDate = c.to.endDate;
  // 日報から決めた会期の案件は、控えも合わせる（次からも、日報に合わせる）。
  // 会期を手で決めた案件を、利用者が選んで広げたときは、控えを付けない（手で決めた会期の案件のまま。自動では変えない）
  if (hasAutoPeriod(p)) next.reportPeriod = { startDate: c.to.startDate, endDate: c.to.endDate };
  // 新しく会期に入った日のうち、回答の無い日は、開催していない日として扱う（請求しない・アルバイト 0 人。手で決めた日は変えない）
  if (c.notHeld.length > 0 && next.jcos) next.jcos = markNotHeld(next.jcos, c.notHeld);
  // 案件名の末尾が、前の会期の書き方（日報から作った案件の名前）のままなら、新しい会期に合わせる
  next.name = renamedForPeriod(p.name, c.from, c.to);
  return next;
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
   * 前回の実績が、すべて外れることになるので止めたとき（失敗ではなく、利用者の確認待ち）の、外れることになる実績。
   * 画面は、これがあるときに「前回の実績を外す」を出す
   */
  clear?: ClearedResults;
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
  if (out.clear) {
    f.clear = { days: out.clear.days, count: out.clear.count };
    const src = out.clear.source;
    if (src?.spreadsheetId) f.clear.source = { spreadsheetId: src.spreadsheetId, gid: src.gid ?? null };
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
  const c = f.clear as Record<string, unknown> | null | undefined;
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (c && typeof c === 'object' && !Array.isArray(c) && whole(c.days) && c.days > 0 && whole(c.count)) {
    out.clear = { days: c.days, count: c.count };
    const src = c.source as Record<string, unknown> | null | undefined;
    if (src && typeof src === 'object' && !Array.isArray(src) && typeof src.spreadsheetId === 'string' && src.spreadsheetId) {
      out.clear.source = { spreadsheetId: src.spreadsheetId, gid: typeof src.gid === 'number' && Number.isFinite(src.gid) ? src.gid : null };
    }
  }
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
