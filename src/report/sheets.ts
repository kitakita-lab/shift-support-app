// 日報（Google スプレッドシート）の読み取り。Google Sheets API を、読み取り専用の権限（spreadsheets.readonly）で呼ぶ。
//
// 守ること:
//   - 読むのは「見出し行」と、見出し名で特定した必要な列（開催日・会場・会場（その他の場合）・イベント名・キットの使用数）だけ。
//     メールアドレス・入力者・内部メモ・自由記述の列は、要求に含めない（＝取得しない）。
//   - 書き込みの API は呼ばない（権限も読み取り専用）。日報の原本は変更しない。
//   - 見出しを確かめられないときは、データの列を読まずにエラーにする（列がずれた日報から、別の列の数字を取り込まないため）。
//   - 公開リンクは使わない（API キーだけの読み取りはしない。必ず、利用者本人の認証で読む）。
import { DEFAULT_SHEET_TITLE, RawReportRow, ReportField, columnLetter, findReportColumns, venueKey } from '../domain/report';
import { ReportSource } from '../types';

export type ReportErrorCode =
  | 'network'        // 通信できない・時間切れ
  | 'auth-expired'   // 認証の有効期限切れ
  | 'no-scope'       // スプレッドシートを読む許可が無い（確認画面でチェックを外した）
  | 'api-disabled'   // Google Sheets API が、プロジェクトで有効になっていない
  | 'no-access'      // このアカウントに、日報の閲覧権限が無い
  | 'not-found'      // スプレッドシートが無い
  | 'no-sheet'       // 日報のタブが見つからない
  | 'bad-header'     // 見出しを確かめられない
  | 'rate'           // 問い合わせが多すぎる
  | 'server'         // Google 側のエラー
  | 'sign-in'        // ログインしていない・認証できなかった
  | 'popup-blocked'  // 認証のポップアップが開けなかった
  | 'popup-closed'   // 認証の画面を閉じた
  | 'wrong-account'  // 認証の画面で、別のアカウントを選んだ
  | 'setup'          // 案件の会場・会期が決まっていない／日報の場所が決まっていない
  | 'unknown';

export class ReportError extends Error {
  code: ReportErrorCode;
  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 20000;

interface HttpResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type HttpGet = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; cache?: 'no-store' }) => Promise<HttpResponse>;
/** ブラウザの fetch（読み取りだけ。既定の GET を使う） */
const browserGet: HttpGet = (url, init) => fetch(url, init);

interface ApiError { error?: { status?: string; message?: string; details?: { reason?: string }[] } }

/** Google からのエラー応答を、利用者に伝えられる形にする */
export function toReportError(status: number, body: unknown): ReportError {
  const e = (body as ApiError | null)?.error ?? {};
  const msg = String(e.message ?? '');
  const reasons = (Array.isArray(e.details) ? e.details : []).map((d) => String(d?.reason ?? ''));
  if (status === 401) return new ReportError('auth-expired', 'Google の認証の有効期限が切れました。もう一度「日報を同期」を押してください。');
  if (status === 403) {
    if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|it is disabled/i.test(msg)) {
      return new ReportError('api-disabled', 'Google Sheets API が、このアプリの Google Cloud プロジェクトで有効になっていません。管理者が一度だけ有効にする必要があります（無料）。有効にしたあと、数分待ってからもう一度お試しください。');
    }
    if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(msg)) {
      return new ReportError('no-scope', 'スプレッドシートを読む許可がありません。もう一度「日報を同期」を押し、Google の確認画面で、スプレッドシートの参照にチェックを入れて許可してください。');
    }
    return new ReportError('no-access', 'ログイン中の Google アカウントには、この日報を閲覧する権限がありません。日報の持ち主に、このアカウントへの共有（閲覧者）を依頼してください。');
  }
  if (status === 404) return new ReportError('not-found', '日報のスプレッドシートが見つかりません。日報の場所（URL）を確認してください。');
  if (status === 429) return new ReportError('rate', 'Google への問い合わせが混み合っています。1 分ほど待ってから、もう一度お試しください。');
  if (status === 400 && /unable to parse range/i.test(msg)) return new ReportError('no-sheet', '日報のタブを読み取れませんでした。タブの名前が変わっていないか確認してください。');
  if (status >= 500) return new ReportError('server', `Google 側でエラーが起きました（${status}）。少し待ってから、もう一度お試しください。`);
  return new ReportError('unknown', `日報を取得できませんでした（${status}）。`);
}

async function getJson(url: string, token: string, http: HttpGet): Promise<unknown> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let res: HttpResponse;
  try {
    // cache: 'no-store' … 日報が修正された直後の同期で、ブラウザに残った古い応答を使わない
    res = await http(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctl?.signal, cache: 'no-store' });
  } catch {
    throw new ReportError('network', '日報を取得できませんでした（通信できない、または時間内に応答がありませんでした）。接続を確認して、もう一度お試しください。');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* 本文が読めなくても、状態コードで判断する */ }
  if (!res.ok) throw toReportError(res.status, body);
  return body;
}

/** タブ名を A1 形式の範囲に使える形にする（' は '' と書く） */
const quote = (title: string): string => `'${title.replace(/'/g, "''")}'`;

interface SheetProps { sheetId?: number; title?: string }

/** 日報のタブを決める。URL でタブが指定されていればそれ、無ければ既定の名前のタブ。タブが 1 つだけなら、それ */
export function pickSheet(sheets: SheetProps[], source: ReportSource): string | null {
  const titled = sheets.filter((s) => typeof s.title === 'string' && s.title !== '');
  if (source.gid != null) {
    const byGid = titled.find((s) => s.sheetId === source.gid);
    if (byGid) return byGid.title!;
  }
  const byName = titled.find((s) => venueKey(s.title) === venueKey(DEFAULT_SHEET_TITLE));
  if (byName) return byName.title!;
  return titled.length === 1 ? titled[0].title! : null;
}

/**
 * 日報の回答を読む（見出しを除く。上から順）。問い合わせは 3 回:
 *   1. タブの一覧（名前と ID だけ）
 *   2. 見出し行（1 行目）
 *   3. 必要な列だけ（2 行目以降）
 */
export async function fetchReportRows(source: ReportSource, token: string, http: HttpGet = browserGet): Promise<RawReportRow[]> {
  const base = `${SHEETS_API}/${encodeURIComponent(source.spreadsheetId)}`;

  const meta = await getJson(`${base}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, token, http) as { sheets?: { properties?: SheetProps }[] };
  const sheets = (meta?.sheets ?? []).map((s) => s.properties ?? {});
  const title = pickSheet(sheets, source);
  if (!title) {
    throw new ReportError('no-sheet', `日報のタブ「${DEFAULT_SHEET_TITLE}」が見つかりません（タブ: ${sheets.map((s) => s.title).filter(Boolean).join('、') || 'なし'}）。日報の場所に、タブを開いた状態の URL を指定してください。`);
  }

  const head = await getJson(`${base}/values/${encodeURIComponent(`${quote(title)}!1:1`)}`, token, http) as { values?: unknown[][] };
  const found = findReportColumns(head?.values?.[0] ?? []);
  if (!found.ok) {
    const parts = [
      found.missing.length ? `見つからない見出し: ${found.missing.map((m) => `「${m}」`).join('')}` : '',
      found.duplicated.length ? `2 つ以上ある見出し: ${found.duplicated.map((m) => `「${m}」`).join('')}` : '',
    ].filter(Boolean).join('／');
    throw new ReportError('bad-header', `日報の見出しを確かめられませんでした（${parts}）。列の構成が変わった可能性があるため、取り込みを中止しました。`);
  }

  const fields = (Object.keys(found.cols) as ReportField[]).filter((k) => found.cols[k] != null);
  const params = new URLSearchParams();
  for (const k of fields) {
    const col = columnLetter(found.cols[k]!);
    params.append('ranges', `${quote(title)}!${col}2:${col}`);
  }
  params.set('majorDimension', 'COLUMNS');
  params.set('valueRenderOption', 'UNFORMATTED_VALUE');      // 日付は通し番号、数は数値で受け取る（表示形式に左右されない）
  params.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  const data = await getJson(`${base}/values:batchGet?${params.toString()}`, token, http) as { valueRanges?: { values?: unknown[][] }[] };
  const ranges = data?.valueRanges ?? [];
  if (ranges.length !== fields.length) throw new ReportError('unknown', '日報の応答が、要求した列の数と合いません。取り込みを中止しました。');

  // 列ごとに返ってくる（末尾の空欄は省かれる）ので、行にそろえる
  const columns = fields.map((_, i) => ranges[i]?.values?.[0] ?? []);
  const length = columns.reduce((m, c) => Math.max(m, c.length), 0);
  const rows: RawReportRow[] = [];
  for (let r = 0; r < length; r += 1) {
    const row: RawReportRow = { date: '', venue: '', venueOther: '', event: '', count: '' };
    fields.forEach((k, i) => { row[k] = columns[i][r] ?? ''; });
    rows.push(row);
  }
  return rows;
}
