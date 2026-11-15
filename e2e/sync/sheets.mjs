// 差し替えの日報（Google Sheets API の応答）。import.mjs が使う（report.mjs は、同じ仕組みを自分の中に持っている）。
// 実際の Google（認証の画面・Sheets API・実際の日報）にはつながない。
//   - 認証: エミュレータのときだけ有効な入口（window.__kkl.sheetsToken）から、テスト用の値を渡す
//   - Sheets API: ブラウザから https://sheets.googleapis.com/ への通信を横取りし、テストが持っている表から応答を作る
export const SHEET_ID = '1TestSheetIdForReportImport0123456789abcdefgh';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1622532141#gid=1622532141`;
export const TAB = 'フォームの回答 1';
export const TOKEN = 'test-sheets-token';
// 実際の日報と同じ並びの見出し（必要な列のほかに、取り込んではいけない列がある）
export const HEADER = [
  'タイムスタンプ', 'メールアドレス', '入力者', '開催日', '天気', '会場', '会場（その他の場合）', 'イベント名', 'イベント内容', '参加組数', '参加人数', 'キットの使用数',
  'ピークだった時間帯', '最大待機組数（概算）', '客層の傾向', '今日一番良かったこと', '印象的な参加者エピソード', '内部用メモ',
];
export const CONTENT = '花の小びんづくり（無料）';
/** 日付の通し番号（スプレッドシートが、表示形式なしで返す値） */
export const serial = (ymd) => Math.round((Date.UTC(...ymd.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))) - Date.UTC(1899, 11, 30)) / 86400000);
/**
 * 回答 1 件。取り込んではいけない列には、見つけやすい目印（SECRET-…）を入れておく。
 *   venue が「その他」のときは other に会場名。groups・people は、空欄にするなら ''
 */
export const answer = (date, venue, count, { other = '', event = '', groups = 10, people = 20, content = CONTENT } = {}) => [
  '2026/11/13 20:00:00', 'SECRET-MAIL@example.com', 'SECRET-NAME', serial(date), '晴れ', venue, other, event, content, groups, people, count,
  '14時', 'SECRET-WAIT', 'SECRET-TREND', 'SECRET-GOOD', 'SECRET-EPISODE', 'SECRET-MEMO',
];

const letterIndex = (col) => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'GET, OPTIONS' };

/**
 * 端末（ブラウザ）に、差し替えの日報をつなぐ。返した state を書き換えると、次の取得からその内容になる。
 *   state.rows … 回答／state.header … 見出し／state.fail … 'network' | 状態コード（403 など）| null／state.failBody … エラーの本文
 *   state.calls … ブラウザが送った問い合わせの記録（方法・場所・要求した列・認証）
 *   state.hold … Promise を入れておくと、次の回答の取得への応答を、それが済むまで止める
 */
export async function fakeSheets(d, init = {}) {
  const state = { header: HEADER, rows: [], tabs: [{ sheetId: 0, title: '集計' }, { sheetId: 1622532141, title: TAB }], fail: null, failBody: null, calls: [], hold: null, answered: 0, ...init };
  await d.ctx.route('https://sheets.googleapis.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
    state.calls.push({ method: req.method(), path: decodeURIComponent(u.pathname), ranges: u.searchParams.getAll('ranges'), fields: u.searchParams.get('fields'), auth: req.headers().authorization ?? '' });
    const json = (status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (state.fail === 'network') { await route.abort('internetdisconnected'); return; }
    if (typeof state.fail === 'number') { await json(state.fail, state.failBody ?? { error: { code: state.fail, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }); return; }
    if (!u.pathname.startsWith(`/v4/spreadsheets/${SHEET_ID}`)) { await json(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }); return; }
    if (u.pathname.endsWith('/values:batchGet')) {
      const rows = state.rows.map((r) => [...r]);                                        // 要求が届いた時点の日報
      const ranges = state.calls[state.calls.length - 1].ranges;
      const hold = state.hold;
      state.hold = null;
      if (hold) await hold;
      await json(200, { spreadsheetId: SHEET_ID, valueRanges: ranges.map((range) => {
        const col = letterIndex(/!([A-Z]+)2:/.exec(range)[1]);
        const values = rows.map((r) => r[col] ?? '');
        while (values.length && values[values.length - 1] === '') values.pop();          // 実物と同じく、末尾の空欄は返さない
        return values.length ? { range, majorDimension: 'COLUMNS', values: [values] } : { range, majorDimension: 'COLUMNS' };
      }) });
      state.answered += 1;
      return;
    }
    if (u.pathname.includes('/values/')) { await json(200, { range: `'${TAB}'!A1:Z1`, majorDimension: 'ROWS', values: [state.header] }); return; }
    await json(200, { sheets: state.tabs.map((properties) => ({ properties })) });
  });
  return state;
}

/** ページを開き、テスト用の認証を渡す入口を用意する */
export async function openPage(d) {
  const page = await d.open();
  await page.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  return page;
}
