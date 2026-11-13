// 日報の同期（Version 4）を、実ブラウザで確かめる。起動は run.mjs から（エミュレータを立ち上げたうえで、このファイルを実行する）。
//
// 相手にするのは、ローカルの Firebase エミュレータ（ログインと共有データ）と、差し替えた Google Sheets API の応答だけ。
// 実際の Google（認証の画面・Sheets API・実際の日報）にはつながない。
//   - 認証: エミュレータのときだけ有効な入口（window.__kkl.sheetsToken）から、テスト用の値を渡す
//   - Sheets API: ブラウザから https://sheets.googleapis.com/ への通信を横取りし、テストが持っている表から応答を作る
// ここで確かめられないもの: 実際の Google の確認画面（未審査アプリの警告・許可のチェック）、Sheets API の有効化、
//   実際の日報の閲覧権限。これらは、実環境での確認事項として残る。
import {
  LEGACY_COLLS, V3_COLLS, add, admin, createProject, eq, loadSample, notices, ok, openProject, runFile, sheet, signIn, signOut, sleep, space, startApp, tab,
  until, TEAM,
} from './lib.mjs';

const T = `teams/${TEAM}`;
const SHEET_ID = '1TestSheetIdForReportSync0123456789abcdefghij';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1622532141#gid=1622532141`;
const TAB = 'フォームの回答 1';
const TOKEN = 'test-sheets-token';
// 実際の日報と同じ並びの見出し（必要な列のほかに、取り込んではいけない列がある）
const HEADER = ['タイムスタンプ', 'メールアドレス', '入力者', '開催日', '天気', '会場', '会場（その他の場合）', 'イベント名', 'イベント内容', '参加組数', '参加人数', 'キットの使用数', 'ピークだった時間帯', '内部用メモ', '印象的な参加者エピソード'];
const CENTER = '北街モール（中央広場）';
const EAST = '北街モール（東口前）';
/** 回答 1 件。取り込んではいけない列には、見つけやすい目印を入れておく */
const answer = (date, venue, count, other = '', event = '') =>
  ['2026/11/13 20:00:00', 'SECRET-MAIL@example.com', 'SECRET-NAME', date, '晴れ', venue, other, event, 'フラワーボトルWS（無料参加）', '10', '20', count, '14時', 'SECRET-MEMO', 'SECRET-EPISODE'];
/** 日付の通し番号（スプレッドシートが、表示形式なしで返す値） */
const serial = (ymd) => Math.round((Date.UTC(...ymd.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))) - Date.UTC(1899, 11, 30)) / 86400000);
const baseRows = () => [
  answer(serial('2026-07-31'), 'その他', 13, 'テスト会場', '【テスト】通しテスト'),
  answer(serial('2026-11-12'), CENTER, 40),                            // 会期の前日
  answer(serial('2026-11-13'), CENTER, 62, '', 'EVENT-目印-ハロウィン'),
  answer(serial('2026-11-14'), CENTER, 58, '', ''),
  answer(serial('2026-11-14'), EAST, 33, '', 'EVENT-目印-ハロウィン'),   // 同じ日の、別の会場
  answer(serial('2026-11-16'), CENTER, 55),                            // 会期の翌日
];

const letterIndex = (col) => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'GET, OPTIONS' };

/**
 * 端末（ブラウザ）に、差し替えの日報をつなぐ。返した state を書き換えると、次の同期からその内容になる。
 *   state.rows … 回答／state.header … 見出し／state.fail … 'network' | 状態コード（403 など）| null／state.failBody … エラーの本文
 *   state.calls … ブラウザが送った問い合わせの記録
 *   state.hold … Promise を入れておくと、次の回答の取得への応答を、それが済むまで止める（通信が遅い場合の再現。応答の内容は、要求が届いた時点の日報）
 *   state.answered … 回答の取得に応答した回数
 */
async function fakeSheets(d, init = {}) {
  const state = { header: HEADER, rows: baseRows(), tabs: [{ sheetId: 0, title: '集計' }, { sheetId: 1622532141, title: TAB }], fail: null, failBody: null, calls: [], hold: null, answered: 0, ...init };
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
async function openPage(d) {
  const page = await d.open();
  await page.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  return page;
}

// ── 画面操作 ────────────────────────────────────────────────
async function addVenue(page, name) {
  await tab(page, '会場');
  await page.getByRole('button', { name: '＋ 会場を追加' }).click();
  await page.locator('[data-c="name"]').last().fill(name);
}
/** JCOS 案件を作って開く（会場・会期つき） */
async function jcosProject(page, { name, venue, start, end }) {
  await createProject(page, name);
  await openProject(page, name);
  const row = (label) => page.locator('table.kv tr', { has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) });
  if ((await row('会場').locator('select option:checked').innerText()) !== venue) await row('会場').locator('select').selectOption({ label: venue });
  await row('開始日').locator('input').fill(start);
  await row('終了日').locator('input').fill(end);
  await page.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
  await page.waitForSelector('[data-testid="report-bar"]');
}
const status = (page) => page.locator('[data-testid="report-status"]').innerText();
const busy = (page) => page.locator('[data-testid="report-bar"]').getAttribute('data-busy');
/** 「日報を同期」を押して、終わるまで待つ（url を渡すと、先に日報の場所を入力する） */
async function syncNow(page, url) {
  if (url) await page.locator('[data-testid="report-url"]').fill(url);
  await page.locator('[data-testid="report-sync"]').click();
  await until(() => busy(page), (b) => b === '0', 10000);
  await sleep(150);
}
/** 回答の取得（同期 1 回につき 1 回）が、何回届いたか */
const fetches = (sheets) => sheets.calls.filter((c) => c.path.endsWith('/values:batchGet')).length;
/**
 * 「日報を同期」を押して、回答の取得への応答を待っているところで止める（通信が遅い場合の再現）。
 * 返した関数を呼ぶと、止めていた応答（押した時点の日報の内容）が届く。
 */
async function startHeld(page, sheets) {
  const n = fetches(sheets);
  let release;
  sheets.hold = new Promise((r) => { release = r; });
  await page.locator('[data-testid="report-sync"]').click();
  const clickedAt = Date.now();
  eq(await until(() => fetches(sheets), (v) => v === n + 1, 5000), n + 1, '回答の取得の要求が届くこと（ここで応答を止める）');
  eq(sheets.hold, null, '止める仕掛けが、この要求に使われたこと');
  eq(await busy(page), '1', '同期中の表示');
  const deliver = async () => {
    const answered = sheets.answered;
    release();
    eq(await until(() => sheets.answered, (v) => v === answered + 1, 5000), answered + 1, '止めていた応答が、ブラウザに渡ること');
  };
  deliver.clickedAt = clickedAt;
  return deliver;
}
/** 「同期をやめる」を押す（同期が長引くと出る） */
async function stopSync(page) {
  await page.locator('[data-testid="report-stop"]').click({ timeout: 10000 });
  eq(await until(() => busy(page), (b) => b === '0', 3000), '0', '「同期をやめる」のあとの、同期中の表示');
}
const toggleText = (page) => page.locator('[data-testid="report-toggle"]').innerText();
/** 日報の内容（11/13 の個数だけを変える。11/14 は 58 個） */
const twoDays = (first) => [answer(serial('2026-11-13'), CENTER, first), answer(serial('2026-11-14'), CENTER, 58)];
/** あとから届いた応答が処理され、共有データへ送られるまでの時間（送信の待ち 0.7 秒）より、十分に長く待つ */
const SETTLE_MS = 2500;
/** 共有データの案件のうち、書き込みのたびに変わるところ（同期の結果・版の印・更新時刻） */
const written = (doc) => JSON.stringify([doc?.reportSync ?? null, doc?.reportSource ?? null, doc?.rev ?? null, doc?.updatedAt ?? null]);
async function detail(page) {
  if (!(await page.locator('[data-testid="report-detail"]').count())) await page.locator('[data-testid="report-toggle"]').click();
  return (await page.locator('[data-testid="report-detail"]').innerText()).replace(/\s+/g, ' ');
}
const yenNum = (s) => Number(String(s).replace(/−/g, '-').replace(/[^\d.-]/g, ''));
/** JCOS の試算の数値 */
async function jcos(page) {
  await sheet(page, '試算');
  await page.waitForSelector('[data-testid="jcos-view"]');
  const t = (id) => page.locator(`[data-testid="${id}"]`).innerText();
  return { billing: yenNum(await t('jcos-billing')), cost: yenNum(await t('jcos-cost')), gross: yenNum(await t('jcos-gross')), actual: Number(await t('jcos-actual')), basis: await page.locator('[data-testid="jcos-view"]').getAttribute('data-basis') };
}
const projectDoc = async (name) => (await admin.list(`${T}/wsProjects`)).find((p) => p.name === name);
/** 共有データ（サーバー）に、同期の結果が届くまで待って、案件のドキュメントを返す（画面の変更は、少し間を置いてから送られる） */
const syncedDoc = (name, pred = (p) => !!p?.reportSync) => until(() => projectDoc(name), pred, 10000);
const days = (doc) => (doc?.reportSync?.days ?? []).map((d) => [d.date, d.count, d.rows]);

/** A がログインして、会場と JCOS 案件（11/13〜11/15）を作り、差し替えの日報をつないだ状態にする */
async function prepare(mk, opts = {}) {
  const A = await mk('A');
  const sheets = await fakeSheets(A, opts.sheets);
  const a = await openPage(A);
  await signIn(a, 'a@example.com');
  await addVenue(a, CENTER);
  await jcosProject(a, { name: '秋の花まつり', venue: CENTER, start: '2026-11-13', end: '2026-11-15' });
  return { A, a, sheets };
}
// 11/13〜11/15（3 日）・請求 40,000/日・アルバイト 15,000/日・材料原価 220/個・予定 0 個のときの粗利（実装を使わずに計算）
const gross = (count) => 40000 * 3 - 15000 * 3 - count * 220;

// ── 確認項目 ────────────────────────────────────────────────
add('R1', '最初の同期: URL を貼って「日報を同期」を 1 回押すと、会場＋会期が一致する回答だけが日別の実績になり、粗利が実績で計算される', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  eq((await status(a)).trim(), 'まだ同期していません', '同期前の表示');
  eq(await jcos(a), { billing: 120000, cost: 45000, gross: gross(0), actual: 0, basis: 'planned' }, '同期前の収支');
  await syncNow(a, SHEET_URL);
  const st = await status(a);
  ok(/最終同期 \d+\/\d+ \d\d:\d\d・2 日分 120 個（取り込み 2 件／読んだ回答 6 件）/.test(st), `同期後の表示: ${st}`);
  eq(await jcos(a), { billing: 120000, cost: 45000 + 120 * 220, gross: gross(120), actual: 120, basis: 'mixed' }, '同期後の収支（実績 62＋58 個）');
  const text = await detail(a);
  ok(text.includes('11/13(金) 62 個') && text.includes('11/14(土) 58 個'), `取り込んだ実績の表示: ${text}`);
  ok(text.includes('テスト回答 1 件は除きました'), `テスト回答の表示: ${text}`);
  ok(text.includes(`「${EAST}」1 件・33 個`), `会場名が一致しない回答の表示: ${text}`);
  // 共有データに入ったもの
  const doc = await until(() => projectDoc('秋の花まつり'), (p) => !!p?.reportSync);
  eq(days(doc), [['2026-11-13', 62, 1], ['2026-11-14', 58, 1]], '共有データの実績');
  eq(doc.reportSource, { spreadsheetId: SHEET_ID, gid: 1622532141 }, '共有データに記録した日報の場所');
  eq([doc.reportSync.rowsRead, doc.reportSync.rowsUsed, doc.reportSync.tests], [6, 2, 1], '件数');
  // 問い合わせは読み取りだけ・必要な列だけ・利用者の認証つき
  eq(sheets.calls.length, 3, '問い合わせの数');
  ok(sheets.calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`), `問い合わせの方法と認証: ${JSON.stringify(sheets.calls.map((c) => [c.method, c.auth]))}`);
  eq(sheets.calls[0].fields, 'sheets.properties(sheetId,title)', 'タブの一覧は、名前と ID だけ');
  eq(sheets.calls[1].path, `/v4/spreadsheets/${SHEET_ID}/values/'${TAB}'!1:1`, '見出し行');
  eq(sheets.calls[2].ranges, ['D', 'F', 'G', 'H', 'L'].map((c) => `'${TAB}'!${c}2:${c}`), '読む列（開催日・会場・会場（その他の場合）・イベント名・キットの使用数）');
});

add('R2', '取り込んではいけない情報（メールアドレス・入力者・内部メモ・参加者エピソード・イベント名・認証）は、共有データにも端末にも保存されない', async ({ device: mk }) => {
  const { a } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  await until(() => projectDoc('秋の花まつり'), (p) => !!p?.reportSync);
  await sleep(800);
  const stored = JSON.stringify([await admin.list(`${T}/wsProjects`), await admin.list(`${T}/wsVenues`)]);
  const local = await a.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  // SECRET-…＝メールアドレス・入力者・内部メモ・参加者エピソード／EVENT-目印＝イベント名／通しテスト・テスト会場＝テスト回答の中身
  for (const secret of ['SECRET', 'EVENT-目印', '通しテスト', 'テスト会場', TOKEN]) {
    ok(!stored.includes(secret), `共有データに「${secret}」が入っています`);
    ok(!local.includes(secret), `端末の保存領域に「${secret}」が入っています`);
    ok(!(await a.content()).includes(secret), `画面に「${secret}」が出ています`);
  }
});

add('R3', '同じ日報を何度同期しても、実績は同じ（二重計上しない）', async ({ device: mk }) => {
  const { a } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  const first = await jcos(a);
  const firstAt = (await syncedDoc('秋の花まつり')).reportSync.at;
  await sleep(1100);                                              // 同期の時刻（秒）が変わるだけの間を置く
  for (let i = 0; i < 3; i++) await syncNow(a);
  eq(await jcos(a), first, '4 回同期したあとの収支');
  const doc = await syncedDoc('秋の花まつり', (p) => !!p?.reportSync && p.reportSync.at !== firstAt);
  ok(doc.reportSync.at !== firstAt, '2 回目以降の同期の結果が、共有データに届いていません');
  eq(days(doc), [['2026-11-13', 62, 1], ['2026-11-14', 58, 1]], '共有データの実績');
  await a.reload();
  await a.waitForSelector('[data-testid="space"][data-space="shared"]');
  await openProject(a, '秋の花まつり');
  eq(await jcos(a), first, '再読み込み後の収支');
});

add('R4', '日報が修正・削除・追加されたら、次の同期で実績が置き換わる', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  eq((await jcos(a)).actual, 120, '最初の実績');
  sheets.rows = [
    answer(serial('2026-11-13'), CENTER, 70),                      // 62 → 70 に修正
    answer('', '', ''),                                            // 11/14 の回答を消した（空行）
    answer(serial('2026-11-15'), CENTER, 44),                      // 追加
    answer(serial('2026-11-15'), CENTER, 6),                       // 同じ日にもう 1 件（合算）
  ].map((r, i) => (i === 1 ? r.map(() => '') : r));
  await syncNow(a);
  eq(await jcos(a), { billing: 120000, cost: 45000 + 120 * 220, gross: gross(120), actual: 120, basis: 'mixed' }, '修正後の収支（70 ＋ 50 個）');
  eq(days(await until(() => projectDoc('秋の花まつり'), (p) => p?.reportSync?.days?.[0]?.count === 70)), [['2026-11-13', 70, 1], ['2026-11-15', 50, 2]], '共有データの実績');
  ok((await detail(a)).includes('11/15(日) 50 個（2 件の合計）'), `複数の回答を合算した日の表示: ${await detail(a)}`);
  sheets.rows = [];                                                // 回答がすべて消えた
  await syncNow(a);
  eq(await jcos(a), { billing: 120000, cost: 45000, gross: gross(0), actual: 0, basis: 'planned' }, '回答がすべて消えたあと');
});

add('R5', '同期に失敗したときは、前回の実績を消さずに残し、失敗の内容を表示する（通信エラー・権限なし・API が無効・認証切れ・見出しの不一致・見出しの重複）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  const good = await jcos(a);
  const saved = async () => { const p = await syncedDoc('秋の花まつり'); return JSON.stringify([p.reportSync, p.reportSource]); };
  const before = await saved();
  const cases = [
    ['通信エラー', { fail: 'network' }, '通信できない'],
    ['閲覧権限なし', { fail: 403 }, '閲覧する権限がありません'],
    ['API が無効', { fail: 403, failBody: { error: { code: 403, message: 'Google Sheets API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } } }, 'Google Sheets API が、このアプリの Google Cloud プロジェクトで有効になっていません'],
    ['認証切れ', { fail: 401, failBody: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } } }, '認証の有効期限が切れました'],
    ['混雑', { fail: 429, failBody: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } }, '混み合っています'],
    ['見出しの不一致', { header: HEADER.map((h) => (h === 'キットの使用数' ? 'キット数' : h)) }, '見つからない見出し: 「キットの使用数」'],
    ['見出しの重複', { header: [...HEADER, 'キットの使用数'] }, '2 つ以上ある見出し: 「キットの使用数」'],
  ];
  for (const [name, patch, expect] of cases) {
    Object.assign(sheets, { fail: null, failBody: null, header: HEADER }, patch);
    const n = sheets.calls.length;
    await syncNow(a);
    const err = (await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' ');
    ok(err.includes(expect), `${name}: 表示された内容「${err}」に「${expect}」がありません`);
    ok(err.includes('そのまま残しています'), `${name}: 前回の実績を残していることの表示がありません: ${err}`);
    ok((await status(a)).includes('2 日分 120 個'), `${name}: 最終同期の表示が変わっています: ${await status(a)}`);
    eq(await jcos(a), good, `${name}: 収支`);
    await sleep(1000);                                              // 共有データへの送信は、変更の約 0.7 秒後。それより長く待ってから確かめる
    eq(await saved(), before, `${name}: 共有データの同期結果`);
    if (name.startsWith('見出し')) eq(sheets.calls.length - n, 2, `${name}: 見出しを確かめられないときは、データの列を読まない（問い合わせは 2 回で止まる）`);
  }
  // 再読み込みしても、失敗の内容は表示される（この端末に記録）
  await a.reload();
  await a.waitForSelector('[data-testid="space"][data-space="shared"]');
  await openProject(a, '秋の花まつり');
  ok((await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした'), '再読み込み後に、失敗が表示されていません');
  // 直ったあとの同期で、失敗の表示は消える
  Object.assign(sheets, { fail: null, failBody: null, header: HEADER });
  await a.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  await syncNow(a);
  eq(await a.locator('[data-testid="report-error"]').count(), 0, '成功後の、失敗の表示');
  eq(await jcos(a), good, '成功後の収支');
});

add('R6', '会場名の書き方が違う回答は取り込まない。「別名として登録して同期」を押すと、その書き方の回答も取り込む（明示的な対応づけ）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  sheets.rows = [
    answer(serial('2026-11-13'), CENTER, 62),
    answer(serial('2026-11-14'), 'その他', 58, '北街モール1F 中央広場'),   // 自由入力の、別の書き方
    answer(serial('2026-11-14'), '北街モール', 9),                          // 名前の一部だけ（別の場所かもしれない）
    answer(serial('2026-11-15'), '北街モール(中央広場) ', 30),              // 半角かっこ・末尾の空白（同じ会場とみなす）
  ];
  await syncNow(a, SHEET_URL);
  eq((await jcos(a)).actual, 92, '全角/半角・空白の違いだけの回答は取り込む（62 ＋ 30）');
  const item = a.locator('[data-testid="report-unmatched"] li', { hasText: '北街モール1F 中央広場' });
  ok((await item.innerText()).replace(/\s+/g, ' ').includes('1 件・58 個（11/14(土)）'), `一致しない回答の表示: ${await item.innerText()}`);
  await item.getByRole('button', { name: /別名として登録して同期/ }).click();
  await until(() => busy(a), (b) => b === '0', 10000);
  eq((await until(() => jcos(a), (j) => j.actual === 150)).actual, 150, '別名を登録したあとの実績（62 ＋ 58 ＋ 30）');
  const venue = await until(async () => (await admin.list(`${T}/wsVenues`)).find((v) => v.name === CENTER), (v) => (v?.reportNames ?? []).length > 0);
  eq(venue.reportNames, ['北街モール1F 中央広場'], '会場マスタの別名');
  // 名前の一部だけの回答は、登録しない限り取り込まれない
  ok((await detail(a)).includes('「北街モール」1 件・9 個'), `残っている一致しない回答: ${await detail(a)}`);
  // 会場マスタの画面でも、別名を確認・編集できる
  await tab(a, '会場');
  eq(await a.locator('[data-c="reportNames"]').first().inputValue(), '北街モール1F 中央広場', '会場マスタの別名の欄');
});

add('R7', '同じ会場で会期が重なる案件があると、重なる日は取り込まずに確認を求める。「この案件の実績として取り込む」と決めた日だけ取り込む', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await jcosProject(a, { name: '週末フェア', venue: CENTER, start: '2026-11-14', end: '2026-11-16' });   // 11/14・11/15 が重なる
  sheets.rows = [answer(serial('2026-11-13'), CENTER, 10), answer(serial('2026-11-14'), CENTER, 20), answer(serial('2026-11-15'), CENTER, 30), answer(serial('2026-11-16'), CENTER, 40)];
  await openProject(a, '秋の花まつり');
  await syncNow(a, SHEET_URL);
  eq((await jcos(a)).actual, 10, '重なっていない日（11/13）だけ取り込む');
  const held = (await a.locator('[data-testid="report-held"]').innerText()).replace(/\s+/g, ' ');
  ok(held.includes('取り込んでいません') && held.includes('11/14(土)：20 個') && held.includes('11/15(日)：30 個') && held.includes('「週末フェア」'), `保留の表示: ${held}`);
  ok((await a.locator('.warnbtn').innerText()).includes('警告 1件'), `警告の件数: ${await a.locator('.warnbtn').innerText()}`);
  // 相手の案件でも、同じ日は取り込まれない（どちらにも黙って入れない）
  await openProject(a, '週末フェア');
  await syncNow(a);
  eq((await jcos(a)).actual, 40, '相手の案件: 重なっていない日（11/16）だけ');
  // この案件の実績にすると決める。直後の同期が失敗しても（通信エラー）、決定は残る。
  // 表示は「次に同期が成功したときに取り込む」（相手の案件は決めていないので、「相手も決めている」とは表示しない）
  await openProject(a, '秋の花まつり');
  await detail(a);
  sheets.fail = 'network';
  await a.locator('[data-testid="report-claim"]').click();
  await until(() => busy(a), (b) => b === '0', 10000);
  const pending = (await a.locator('[data-testid="report-held"]').innerText()).replace(/\s+/g, ' ');
  ok(pending.includes('次に同期が成功したときに、取り込みます') && !pending.includes('相手の案件も'), `決めた直後の同期が失敗したときの表示: ${pending}`);
  eq(await a.locator('[data-testid="report-claim"]').count(), 0, '決めた日には、もう一度決めるボタンを出さない');
  eq((await jcos(a)).actual, 10, '同期が失敗している間の実績（前回のまま）');
  sheets.fail = null;
  await syncNow(a);
  eq((await until(() => jcos(a), (j) => j.actual === 60)).actual, 60, '決めたあとの実績（10 ＋ 20 ＋ 30）');
  eq(await a.locator('[data-testid="report-held"]').count(), 0, '保留の表示');
  eq((await until(() => projectDoc('秋の花まつり'), (p) => (p?.reportClaims ?? []).length === 2)).reportClaims, ['2026-11-14', '2026-11-15'], '共有データに記録した決定');
  // 相手の案件では、その日は「別の案件に割り当て済み」になり、取り込まれない
  await openProject(a, '週末フェア');
  await syncNow(a);
  eq((await jcos(a)).actual, 40, '相手の案件の実績（変わらない）');
  ok((await detail(a)).includes('別の案件の実績として割り当て済みの回答が 2 件'), `相手の案件の表示: ${await detail(a)}`);
});

add('R8', '同期の結果は、ほかのメンバーの端末にも届く。別の案件・別の端末では、日報の場所を入れ直さずに同期できる', async ({ device: mk }) => {
  const { a, sheets: aSheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  await until(() => projectDoc('秋の花まつり'), (p) => !!p?.reportSync);
  // 別のメンバー（B）の端末
  const B = await mk('B');
  const bSheets = await fakeSheets(B, { rows: [answer(serial('2026-11-13'), CENTER, 62), answer(serial('2026-11-14'), CENTER, 58), answer(serial('2026-11-15'), CENTER, 41)] });
  const b = await openPage(B);
  await signIn(b, 'b@example.com');
  await openProject(b, '秋の花まつり');
  ok((await status(b)).includes('2 日分 120 個'), `B の端末の表示: ${await status(b)}`);
  eq((await jcos(b)).actual, 120, 'B の端末の実績');
  eq(await b.locator('[data-testid="report-url"]').count(), 0, 'B の端末では、日報の場所の入力欄を出さない');
  await syncNow(b);                                               // B が同期（URL は入れない）
  eq(bSheets.calls.length, 3, 'B の端末からの問い合わせ');
  eq((await jcos(b)).actual, 161, 'B が同期したあとの実績');
  eq((await until(() => jcos(a), (j) => j.actual === 161, 8000)).actual, 161, 'A の端末にも、B の同期の結果が届く');
  // A の同期が失敗したあとで、B の端末の同期が成功すると、A に残った「同期できませんでした」は消える（古い失敗を出し続けない）
  aSheets.fail = 'network';
  await syncNow(a);
  ok((await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした'), `A の失敗の表示: ${await a.locator('[data-testid="report-toggle"]').innerText()}`);
  eq((await jcos(a)).actual, 161, 'A の同期が失敗しても、実績は変わらない');
  bSheets.rows = [answer(serial('2026-11-13'), CENTER, 62), answer(serial('2026-11-14'), CENTER, 58), answer(serial('2026-11-15'), CENTER, 45)];
  await syncNow(b);
  eq((await until(() => jcos(a), (j) => j.actual === 165, 8000)).actual, 165, 'A の端末に、B の 2 回目の同期の結果が届く');
  await until(() => a.locator('[data-testid="report-toggle"]').innerText(), (t) => !t.includes('同期できませんでした'), 5000);
  eq(await a.locator('[data-testid="report-error"]').count(), 0, 'B の同期が成功したあとの、A の失敗の表示');
  aSheets.fail = null;
  // A が別の案件を作る → 場所を入れ直さずに同期できる
  await jcosProject(a, { name: '冬の花まつり', venue: CENTER, start: '2026-12-01', end: '2026-12-02' });
  eq(await a.locator('[data-testid="report-url"]').count(), 0, '2 件目の案件では、日報の場所の入力欄を出さない');
  await syncNow(a);
  ok((await status(a)).includes('0 日分 0 個'), `2 件目の案件の同期: ${await status(a)}`);
});

add('R9', '会場や会期が決まっていない案件・正しくない URL では、Google に問い合わせる前に知らせる', async ({ device: mk }) => {
  const A = await mk('A');
  const sheets = await fakeSheets(A);
  const a = await openPage(A);
  await signIn(a, 'a@example.com');
  await addVenue(a, CENTER);
  await createProject(a, '準備中の案件');
  await openProject(a, '準備中の案件');
  await a.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
  // 正しくない URL（スプレッドシートでない・公開用のリンク）
  for (const bad of ['https://example.com/sheet', 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml', 'abc']) {
    await a.locator('[data-testid="report-url"]').fill(bad);
    await a.locator('[data-testid="report-sync"]').click();
    ok((await a.locator('[data-testid="report-url-error"]').innerText()).includes('スプレッドシートの URL'), `「${bad}」を受け付けています`);
  }
  // 会期が未入力
  await syncNow(a, SHEET_URL);
  ok((await a.locator('[data-testid="report-error"]').innerText()).includes('会期'), `会期が未入力のときの表示: ${await a.locator('[data-testid="report-error"]').innerText()}`);
  eq(sheets.calls.length, 0, 'Google への問い合わせ');
  await sleep(1500);
  eq((await until(() => projectDoc('準備中の案件'), (p) => !!p, 10000))?.reportSync ?? null, null, '共有データの同期結果');
});

add('R10', '「この端末だけのデータ」の案件でも、ログイン中なら同期できる。共有データには何も書かれない', async ({ device: mk }) => {
  const A = await mk('A');
  const sheets = await fakeSheets(A, { rows: [answer(serial('2026-11-13'), 'ラソラ札幌', 81), answer(serial('2026-11-14'), 'ラソラ札幌', 64), answer(serial('2026-11-14'), CENTER, 5)] });
  const a = await openPage(A);
  await signIn(a, 'a@example.com');
  await space(a, 'local');
  await loadSample(a);
  await openProject(a, 'ikyu');
  await a.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
  await syncNow(a, SHEET_URL);
  ok((await status(a)).includes('2 日分 145 個'), `同期後の表示: ${await status(a)}`);
  // 5 日・予定 300 個（60 個/日）・その他実費 22,000: 実績 81＋64、残り 3 日は予定 180 個
  const count = 81 + 64 + 180;
  eq(await jcos(a), { billing: 200000, cost: 75000 + count * 220 + 22000, gross: 200000 - (75000 + count * 220 + 22000), actual: 145, basis: 'mixed' }, '同期後の収支');
  await sleep(1500);
  eq((await admin.list(`${T}/wsProjects`)).length, 0, '共有データの案件（増えていないこと）');
  eq(sheets.calls.length, 3, '問い合わせの数');
});

add('R11', '「この案件の実績にする」を取り消したあとの同期が失敗しても、取り消した日の実績は使わない。相手の案件が取り込んでも、同じ回答を二重には数えない', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);                                                             // 秋の花まつり 11/13〜11/15
  await jcosProject(a, { name: '週末フェア', venue: CENTER, start: '2026-11-15', end: '2026-11-16' });   // 11/15 が重なる
  sheets.rows = [answer(serial('2026-11-13'), CENTER, 10), answer(serial('2026-11-15'), CENTER, 100), answer(serial('2026-11-16'), CENTER, 40)];
  await openProject(a, '秋の花まつり');
  await syncNow(a, SHEET_URL);
  eq((await jcos(a)).actual, 10, '重なる日（11/15）は保留');
  await detail(a);
  await a.locator('[data-testid="report-claim"]').click();                                             // 11/15 を、この案件の実績にする
  await until(() => busy(a), (b) => b === '0', 10000);
  eq((await until(() => jcos(a), (j) => j.actual === 110)).actual, 110, '決めたあとの実績（10 ＋ 100）');
  // 決定を取り消す。ただし、続く同期は失敗する（通信エラー）
  sheets.fail = 'network';
  await detail(a);
  await a.locator('[data-testid="report-claims"] button').click();
  await until(() => busy(a), (b) => b === '0', 10000);
  ok((await a.locator('[data-testid="report-error"]').innerText()).includes('通信できない'), `同期の失敗の表示: ${await a.locator('[data-testid="report-error"]').innerText()}`);
  ok((await status(a)).includes('2 日分 110 個'), `保存してある同期の結果は、前のまま: ${await status(a)}`);
  const contested = (await a.locator('[data-testid="report-contested"]').innerText()).replace(/\s+/g, ' ');
  ok(contested.includes('いまは使っていません') && contested.includes('11/15(日)：100 個') && contested.includes('「週末フェア」'), `使っていない日の表示: ${contested}`);
  eq((await jcos(a)).actual, 10, '取り消した日の 100 個は、同期が失敗しても数えない');
  const cleared = await until(() => projectDoc('秋の花まつり'), (p) => !!p && (p.reportClaims ?? []).length === 0, 10000);
  eq([cleared?.reportClaims ?? null, days(cleared)], [[], [['2026-11-13', 10, 1], ['2026-11-15', 100, 1]]], '共有データ: 決定は取り消され、同期の結果は前のまま（失敗した同期は、何も書いていない）');
  // 相手の案件が、同じ日を自分の実績と決めて同期する（今度は成功）
  sheets.fail = null;
  await openProject(a, '週末フェア');
  await syncNow(a);
  eq((await jcos(a)).actual, 40, '相手の案件: 重なっていない日（11/16）だけ');
  await detail(a);
  await a.locator('[data-testid="report-claim"]').click();
  await until(() => busy(a), (b) => b === '0', 10000);
  eq((await until(() => jcos(a), (j) => j.actual === 140)).actual, 140, '相手の案件が決めたあとの実績（100 ＋ 40）');
  // 元の案件は、同期し直していなくても、11/15 を数えない（2 つの案件の合計は 10 ＋ 100 ＋ 40）
  await openProject(a, '秋の花まつり');
  eq((await jcos(a)).actual, 10, '元の案件の実績');
  const assigned = (await detail(a)).replace(/\s+/g, ' ');
  ok(assigned.includes('別の案件の実績として割り当て済み') && assigned.includes('11/15(日)：100 個'), `元の案件の表示: ${assigned}`);
  ok((await status(a)).includes('うち 1 日分は、いまは使っていません'), `元の案件の同期の表示: ${await status(a)}`);
  // 一覧の粗利も、同じ数え方（元の案件: 3 日・10 個／相手の案件: 2 日・140 個）
  await a.getByRole('button', { name: '← 案件一覧' }).click();
  const rowText = async (name) => (await a.locator('.grid tbody tr', { has: a.locator('td', { hasText: new RegExp(`^${name}$`) }) }).innerText()).replace(/\s+/g, ' ');
  ok((await rowText('秋の花まつり')).includes(`¥${(40000 * 3 - 15000 * 3 - 10 * 220).toLocaleString('ja-JP')}（粗利）`), `元の案件の一覧の粗利: ${await rowText('秋の花まつり')}`);
  ok((await rowText('週末フェア')).includes(`¥${(40000 * 2 - 15000 * 2 - 140 * 220).toLocaleString('ja-JP')}（粗利）`), `相手の案件の一覧の粗利: ${await rowText('週末フェア')}`);
});

add('R12', '日報に読み取れない回答があるときは、取り込みを中止して前回の実績を残し、どの回答（開催日・日報の行）のどの項目が、なぜ読み取れないかを表示する。この案件のものでない回答では止まらない。日報を直すと取り込める', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  const good = await jcos(a);                                       // 実績 62 ＋ 58 個
  const saved = async () => { const p = await syncedDoc('秋の花まつり'); return JSON.stringify([p.reportSync, p.reportSource]); };
  const base = baseRows();                                          // 日報の 2〜7 行目
  const ROW = base.length + 2;                                      // このあと足す回答の、日報での行番号
  // 止まる同期では、読み取れる回答の個数も変えておく（11/13: 62 → 99）。止まったのに一部だけ取り込んでいれば、実績が 120 個でなくなる
  const changed = () => baseRows().map((r) => (r[3] === serial('2026-11-13') && r[5] === CENTER ? r.map((c, i) => (i === 11 ? 99 : c)) : r));

  // この案件のものでないと確実に言える回答（会期の外・別の会場名・テスト回答）は、読み取れない項目があっても、同期を止めない
  sheets.rows = [...base, answer(serial('2026-11-20'), CENTER, 'たくさん'), answer('きのう', EAST, 5), answer(serial('2026-11-14'), EAST, ''), answer('', 'その他', 'x', 'テスト会場')];
  await syncNow(a);
  eq(await a.locator('[data-testid="report-error"]').count(), 0, '対象外の回答だけが読み取れないとき: 失敗の表示');
  ok((await status(a)).includes('2 日分 120 個'), `対象外の回答だけが読み取れないとき: 同期の表示: ${await status(a)}`);
  eq(await jcos(a), good, '対象外の回答だけが読み取れないとき: 収支');
  await until(() => projectDoc('秋の花まつり'), (p) => p?.reportSync?.unmatched?.[0]?.rows === 2, 10000);   // この同期の結果が、共有データに届くまで待つ
  const before = await saved();

  // この案件の回答（会場名が一致）か、この案件のものかどうかを決められない回答（会場名が空欄）に、読み取れない項目がある
  const cases = [
    // [説明, 足す回答, 表示に含まれるはずの文]
    ['個数が文字列', answer(serial('2026-11-15'), CENTER, '80個'), ['開催日：11/15(日)', '「キットの使用数」に数字以外の文字（空白・区切りを含む）が入っています']],
    ['個数に 2 つの数', answer(serial('2026-11-15'), CENTER, '62 58'), ['開催日：11/15(日)', '「キットの使用数」に数字以外の文字（空白・区切りを含む）が入っています']],
    ['個数のセルが日付になっている', answer(serial('2026-11-15'), CENTER, serial('2026-10-20')), ['開催日：11/15(日)', '「キットの使用数」が大きすぎます', 'セルが日付の形式になっている場合も']],
    ['個数が空欄', answer(serial('2026-11-15'), CENTER, ''), ['開催日：11/15(日)', '「キットの使用数」が空欄です']],
    ['個数がマイナス', answer(serial('2026-11-15'), CENTER, -5), ['開催日：11/15(日)', '「キットの使用数」がマイナスの値です']],
    ['個数が小数', answer(serial('2026-11-15'), CENTER, 12.5), ['開催日：11/15(日)', '「キットの使用数」が整数ではありません']],
    ['個数が大きすぎる', answer(serial('2026-11-15'), CENTER, 100000000), ['開催日：11/15(日)', '「キットの使用数」が大きすぎます']],
    ['開催日が日付でない', answer('きのう', CENTER, 30), ['開催日：読み取れません', '「開催日」を日付として読み取れません']],
    ['開催日が空欄', answer('', CENTER, 30), ['開催日：読み取れません', '「開催日」が空欄です']],
    ['会場名が空欄', answer(serial('2026-11-15'), '', 30), ['開催日：11/15(日)', '「会場」が空欄です']],
    ['「その他」で会場名が未入力', answer(serial('2026-11-15'), 'その他', 30, ''), ['開催日：11/15(日)', '会場名（「会場（その他の場合）」の列）が入っていません']],
  ];
  for (const [name, bad, expects] of cases) {
    sheets.rows = [...changed(), bad];
    await syncNow(a);
    const err = (await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' ');
    ok(err.includes('読み取れない回答が 1 件') && err.includes('取り込みを中止'), `${name}: 失敗の表示: ${err}`);
    ok(err.includes('そのまま残しています'), `${name}: 前回の実績を残していることの表示がありません: ${err}`);
    const list = (await a.locator('[data-testid="report-issues"]').innerText()).replace(/\s+/g, ' ');
    ok(list.includes(`日報の ${ROW} 行目`), `${name}: 日報の行番号がありません: ${list}`);
    for (const e of expects) ok(list.includes(e), `${name}: 表示「${list}」に「${e}」がありません`);
    ok((await status(a)).includes('2 日分 120 個'), `${name}: 最終同期の表示が変わっています: ${await status(a)}`);
    eq(await jcos(a), good, `${name}: 収支（前回の実績のまま。読み取れた回答＝11/13 の 99 個も、取り込んでいないこと）`);
    await sleep(1000);                                              // 共有データへの送信は、変更の約 0.7 秒後。それより長く待ってから確かめる
    eq(await saved(), before, `${name}: 共有データの同期結果（何も書いていないこと）`);
  }

  // 読み取れない回答が多いときは、先頭の 20 件と、残りの件数を出す
  sheets.rows = [...changed(), ...Array.from({ length: 23 }, () => answer(serial('2026-11-15'), CENTER, ''))];
  await syncNow(a);
  ok((await a.locator('[data-testid="report-error"]').innerText()).includes('読み取れない回答が 23 件'), `多いとき: ${await a.locator('[data-testid="report-error"]').innerText()}`);
  const many = (await a.locator('[data-testid="report-issues"] li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  eq([many.length, many[0].includes(`日報の ${ROW} 行目`), many[19].includes(`日報の ${ROW + 19} 行目`), many[20]], [21, true, true, 'ほか 3 件'], `多いときの一覧: ${JSON.stringify(many.slice(18))}`);
  // 読み取れない回答が複数あれば、すべて挙げる
  sheets.rows = [...changed(), answer(serial('2026-11-15'), CENTER, ''), answer('きのう', CENTER, 5)];
  await syncNow(a);
  ok((await a.locator('[data-testid="report-error"]').innerText()).includes('読み取れない回答が 2 件'), `複数のとき: ${await a.locator('[data-testid="report-error"]').innerText()}`);
  const items = (await a.locator('[data-testid="report-issues"] li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  eq(items.length, 2, `複数のときの一覧: ${JSON.stringify(items)}`);
  ok(items[0].includes(`日報の ${ROW} 行目`) && items[0].includes('「キットの使用数」が空欄です') && items[1].includes(`日報の ${ROW + 1} 行目`) && items[1].includes('「開催日」を日付として読み取れません'), `複数のときの一覧: ${JSON.stringify(items)}`);
  // 回答に書かれていた文字そのもの・取り込んではいけない列は、端末にも画面にも残さない
  const local = await a.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const secret of ['きのう', 'SECRET', TOKEN]) {
    ok(!local.includes(secret), `端末の保存領域に「${secret}」が入っています`);
    ok(!(await a.content()).includes(secret), `画面に「${secret}」が出ています`);
  }
  // 再読み込みしても、どの回答かの表示は残る（この端末に記録）
  await a.reload();
  await a.waitForSelector('[data-testid="space"][data-space="shared"]');
  await openProject(a, '秋の花まつり');
  ok((await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした'), '再読み込み後に、失敗が表示されていません');
  await detail(a);
  eq(await a.locator('[data-testid="report-issues"] li').count(), 2, '再読み込み後の、読み取れない回答の一覧');
  eq(await jcos(a), good, '再読み込み後の収支');
  eq(await saved(), before, '止まった同期を繰り返したあとの、共有データの同期結果（何も書いていないこと）');

  // 日報を直して同期すると、取り込める（失敗の表示は消える）
  sheets.rows = [...base, answer(serial('2026-11-15'), CENTER, 80)];
  await a.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  await syncNow(a);
  eq([await a.locator('[data-testid="report-error"]').count(), await a.locator('[data-testid="report-issues"]').count()], [0, 0], '直したあとの、失敗の表示');
  eq(await jcos(a), { billing: 120000, cost: 45000 + 200 * 220, gross: gross(200), actual: 200, basis: 'actual' }, '直したあとの収支（62 ＋ 58 ＋ 80 個）');
  eq(days(await until(() => projectDoc('秋の花まつり'), (p) => p?.reportSync?.days?.length === 3, 10000)), [['2026-11-13', 62, 1], ['2026-11-14', 58, 1], ['2026-11-15', 80, 1]], '共有データの実績');
});

add('R13', '最初の同期が、読み取れない回答で止まったとき: 実績を作らない（2 つの数が書かれた個数を、つなげて取り込まない）。日報の場所は、この端末が覚えている。端末に置いた記録が壊れていても、同期の欄は表示できる。「コンテスト」という催しの回答は、テスト回答として捨てない', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  const contest = answer(serial('2026-11-13'), CENTER, 62, '', 'ハロウィン仮装コンテスト');
  sheets.rows = [contest, answer(serial('2026-11-14'), CENTER, '62 58')];                 // 3 行目: 個数に、2 つの数が書かれている
  await syncNow(a, SHEET_URL);
  const err = (await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' ');
  ok(err.includes('読み取れない回答が 1 件') && err.includes('取り込みを中止') && !err.includes('そのまま残しています'), `失敗の表示: ${err}`);
  const list = (await a.locator('[data-testid="report-issues"]').innerText()).replace(/\s+/g, ' ');
  ok(list.includes('日報の 3 行目') && list.includes('開催日：11/14(土)') && list.includes('数字以外の文字（空白・区切りを含む）'), `読み取れない回答の表示: ${list}`);
  eq((await status(a)).trim(), 'まだ同期していません', '同期の表示');
  eq(await jcos(a), { billing: 120000, cost: 45000, gross: gross(0), actual: 0, basis: 'planned' }, '止まったあとの収支（予定のまま。6258 個として取り込んでいないこと）');
  await sleep(1000);
  const stopped = await projectDoc('秋の花まつり');
  eq([stopped?.reportSync ?? null, stopped?.reportSource ?? null], [null, null], '共有データ（同期の結果も、日報の場所も、書いていないこと）');
  // 日報そのものは読めたので、場所は、この端末が覚えている（URL の欄を、もう出さない）
  eq(await a.locator('[data-testid="report-url"]').count(), 0, '止まったあとの、日報の場所の入力欄');
  // 端末に置いた失敗の記録が壊れていても、同期の欄は表示できる（記録の名前は、置き場所 ＋ 案件の ID）
  const mine = `shared:${stopped.id}`;
  for (const junk of ['null', '[1,2]', JSON.stringify({ [mine]: 5 }), JSON.stringify({ [mine]: { at: 't', message: 'm', issues: 'x', more: 'y' } }), JSON.stringify({ [stopped.id]: 5 }), '{壊れた']) {
    await a.evaluate((v) => localStorage.setItem('kkl_report_error_v1', v), junk);
    await a.reload();
    await a.waitForSelector('[data-testid="space"][data-space="shared"]');
    await openProject(a, '秋の花まつり');
    ok(await a.locator('[data-testid="report-sync"]').isVisible(), `壊れた記録（${junk}）のとき、同期の欄が表示されません`);
  }
  eq(await a.locator('[data-testid="report-url"]').count(), 0, '再読み込み後の、日報の場所の入力欄');
  // 日報を直して同期する（URL は貼らない）
  sheets.rows = [contest, answer(serial('2026-11-14'), CENTER, 58)];
  await a.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  await syncNow(a);
  eq(await a.locator('[data-testid="report-error"]').count(), 0, '直したあとの、失敗の表示');
  eq((await jcos(a)).actual, 120, '直したあとの実績（コンテストの回答 62 個を含む）');
  const done = await until(() => projectDoc('秋の花まつり'), (p) => !!p?.reportSync, 10000);
  eq([days(done), done.reportSync.tests, done.reportSource], [[['2026-11-13', 62, 1], ['2026-11-14', 58, 1]], 0, { spreadsheetId: SHEET_ID, gid: 1622532141 }], '共有データ（実績・テスト回答の数・日報の場所）');
});

// ── 同じ案件の同期が重なったとき（古い同期の結果で、新しい実績を上書きしない） ──────────
add('R14', '同期の途中で案件を閉じて開き直しても、同期中のままに見え、もう一度は始められない。結果は 1 回だけ届き、成功も失敗も、開き直した画面に出る', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  eq((await jcos(a)).actual, 120, '最初の実績（62 ＋ 58）');
  // 同期の途中（応答が止まっている）で、案件一覧に戻って、同じ案件を開き直す
  sheets.rows = twoDays(70);
  const release = await startHeld(a, sheets);
  await a.getByRole('button', { name: '← 案件一覧' }).click();
  await openProject(a, '秋の花まつり');
  eq(await busy(a), '1', '開き直した画面でも、同期中');
  const button = a.locator('[data-testid="report-sync"]');
  eq([await button.isDisabled(), (await button.innerText()).trim()], [true, '同期中…'], '「日報を同期」のボタン');
  // 開き直しただけでは、2 つ目の同期は始まらない（同期を始める処理そのものが、動いている同期があると始めないことは、
  // 単体テスト syncJob.test.ts で確かめている。画面では、ボタンが押せないことを確かめる）
  await sleep(400);
  eq([fetches(sheets), await busy(a)], [2, '1'], '回答の取得の回数・同期中の表示');
  await release();
  await until(() => busy(a), (b) => b === '0', 10000);
  ok((await status(a)).includes('2 日分 128 個'), `開き直した画面に、同期の結果が出る: ${await status(a)}`);
  eq((await jcos(a)).actual, 128, '実績（70 ＋ 58）');
  eq(days(await syncedDoc('秋の花まつり', (p) => days(p)[0]?.[1] === 70)), [['2026-11-13', 70, 1], ['2026-11-14', 58, 1]], '共有データ');
  // 失敗で終わったときも、開き直した画面に出る（内容が開く）。前回の実績は残る
  sheets.rows = twoDays('たくさん');
  const release2 = await startHeld(a, sheets);
  await a.getByRole('button', { name: '← 案件一覧' }).click();
  await openProject(a, '秋の花まつり');
  eq(await busy(a), '1', '開き直した画面でも、同期中（2 回目）');
  await release2();
  await until(() => busy(a), (b) => b === '0', 10000);
  ok((await toggleText(a)).includes('同期できませんでした'), `開き直した画面に、失敗が出る: ${await toggleText(a)}`);
  await a.waitForSelector('[data-testid="report-issues"]', { timeout: 3000 });
  ok((await a.locator('[data-testid="report-issues"]').innerText()).includes('日報の 2 行目'), `読み取れない回答の表示: ${await a.locator('[data-testid="report-issues"]').innerText()}`);
  ok((await status(a)).includes('2 日分 128 個'), `前回の実績が残る: ${await status(a)}`);
  eq(fetches(sheets), 3, '回答の取得の回数（同期 1 回につき 1 回）');
});

add('R15', '同期の完了の順序が逆転しても、先に始めた同期の結果は、新しい実績を上書きしない（画面も、共有データも）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  // 1 つ目の同期: 直される前の日報（11/13 = 70）を読んだ応答が、止まっている。利用者は、同期をやめる
  sheets.rows = twoDays(70);
  const release = await startHeld(a, sheets);
  // 「同期をやめる」は、同期が長引く（4 秒）まで出ない（ここまでに時間がかかりすぎた場合は、確かめない）
  const shown = await a.locator('[data-testid="report-stop"]').count();
  if (Date.now() - release.clickedAt < 3000) eq(shown, 0, '押した直後の「同期をやめる」');
  await stopSync(a);
  // 日報が直された（11/13 = 99）。2 つ目の同期は、すぐに終わる
  sheets.rows = twoDays(99);
  await syncNow(a);
  ok((await status(a)).includes('2 日分 157 個'), `2 つ目の同期の結果: ${await status(a)}`);
  const second = await syncedDoc('秋の花まつり', (p) => days(p)[0]?.[1] === 99);
  // 1 つ目の同期の応答が、あとから届く
  await release();
  await sleep(SETTLE_MS);
  ok((await status(a)).includes('2 日分 157 個'), `あとから届いた古い結果で、表示が変わっていないこと: ${await status(a)}`);
  eq((await jcos(a)).actual, 157, '実績（99 ＋ 58 のまま）');
  eq(await busy(a), '0', '同期中の表示');
  ok(!(await toggleText(a)).includes('同期できませんでした'), `失敗の表示は出ない: ${await toggleText(a)}`);
  const after = await projectDoc('秋の花まつり');
  eq(days(after), [['2026-11-13', 99, 1], ['2026-11-14', 58, 1]], '共有データの実績（2 つ目の同期の結果のまま）');
  eq(written(after), written(second), '共有データへの書き込み（古い結果を、書き戻していないこと）');
  eq(fetches(sheets), 3, '回答の取得の回数');
  // やめただけで、次の同期を始めていないときも、あとから届いた結果は使わない
  sheets.rows = twoDays(11);
  const release3 = await startHeld(a, sheets);
  await stopSync(a);
  await release3();
  await sleep(SETTLE_MS);
  ok((await status(a)).includes('2 日分 157 個'), `やめた同期の結果は使わない: ${await status(a)}`);
  eq(written(await projectDoc('秋の花まつり')), written(second), '共有データ（やめた同期の結果を、書いていないこと）');
});

add('R16', '最新の同期が失敗したとき、先に始めた同期の結果は、あとから届いても確定されない（前回の実績のまま。表示は、最新の同期の失敗）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  const first = await syncedDoc('秋の花まつり');                 // 前回の実績（120 個）
  const cases = [
    ['Google 側のエラー', { fail: 503 }, 'Google 側でエラーが起きました'],
    ['読み取れない回答', { rows: twoDays('たくさん') }, '読み取れない'],
  ];
  for (const [name, patch, expect] of cases) {
    // 先の同期（成功するはずの応答が、止まっている）→ やめる → 次の同期は、失敗する
    Object.assign(sheets, { fail: null, rows: twoDays(70) });
    const release = await startHeld(a, sheets);
    await stopSync(a);
    Object.assign(sheets, patch);
    await syncNow(a);
    ok((await toggleText(a)).includes('同期できませんでした'), `${name}: 最新の同期の失敗が出る: ${await toggleText(a)}`);
    const shown = (await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' ');
    ok(shown.includes(expect), `${name}: 失敗の内容「${shown}」に「${expect}」がありません`);
    // 先の同期の応答が、あとから届く
    sheets.fail = null;
    await release();
    await sleep(SETTLE_MS);
    ok((await status(a)).includes('2 日分 120 個'), `${name}: 前回の実績のまま: ${await status(a)}`);
    eq((await jcos(a)).actual, 120, `${name}: 実績（先の同期の 128 個が、確定されていないこと）`);
    eq(written(await projectDoc('秋の花まつり')), written(first), `${name}: 共有データ（1 項目も変わっていないこと）`);
    eq((await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' '), shown, `${name}: 表示は、最新の同期の失敗のまま`);
  }
});

add('R17', 'ほかの端末の同期の結果が先に届いていたら、あとから届いた自分の同期の結果で上書きしない。そのことを知らせ、もう一度同期すると取り込める', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  await syncedDoc('秋の花まつり');
  const B = await mk('B');
  await fakeSheets(B, { rows: twoDays(99) });
  const b = await openPage(B);
  await signIn(b, 'b@example.com');
  await openProject(b, '秋の花まつり');
  // A: 同期の途中（直される前の日報〔11/13 = 70〕を読んだ応答が、止まっている）
  sheets.rows = twoDays(70);
  const release = await startHeld(a, sheets);
  // B: 直されたあとの日報（11/13 = 99）で同期して、結果が共有データに保存される。A にも届く（A は、まだ同期中）
  await syncNow(b);
  const theirs = await syncedDoc('秋の花まつり', (p) => days(p)[0]?.[1] === 99);
  await until(() => status(a), (t) => t.includes('2 日分 157 個'), 8000);
  eq(await busy(a), '1', 'A は、まだ同期中');
  // A の応答が、あとから届く
  await release();
  await until(() => busy(a), (v) => v === '0', 10000);
  await sleep(SETTLE_MS);
  ok((await status(a)).includes('2 日分 157 個'), `A の表示（B の結果のまま）: ${await status(a)}`);
  eq(written(await projectDoc('秋の花まつり')), written(theirs), '共有データ（B の結果のまま。A の古い結果を、書き戻していないこと）');
  ok((await status(b)).includes('2 日分 157 個'), `B の表示: ${await status(b)}`);
  ok((await toggleText(a)).includes('同期できませんでした'), `A に、知らせが出る: ${await toggleText(a)}`);
  const note = (await a.locator('[data-testid="report-error"]').innerText()).replace(/\s+/g, ' ');
  ok(note.includes('ほかの端末') && note.includes('使っていません') && note.includes('もう一度「日報を同期」'), `知らせの内容: ${note}`);
  // もう一度同期すると、取り込める（知らせは消える）。B にも届く
  await syncNow(a);
  ok((await status(a)).includes('2 日分 128 個'), `A がもう一度同期したあと: ${await status(a)}`);
  ok(!(await toggleText(a)).includes('同期できませんでした'), `知らせは消える: ${await toggleText(a)}`);
  await until(() => status(b), (t) => t.includes('2 日分 128 個'), 8000);
  eq(days(await syncedDoc('秋の花まつり', (p) => days(p)[0]?.[1] === 70)), [['2026-11-13', 70, 1], ['2026-11-14', 58, 1]], '共有データ');
});

add('R18', '2 台の同期が、ほぼ同時に終わったとき（守れない範囲）: どちらか一方の、欠けのない結果が残り、2 台の表示は同じ結果にそろう（2 つの結果が混ざらない）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  await syncedDoc('秋の花まつり');
  const B = await mk('B');
  // B の日報は、会期の外の回答が 1 件多い（読んだ回答の数で、どちらの結果かを見分ける）
  const sheetsB = await fakeSheets(B, { rows: [...twoDays(99), answer(serial('2026-12-01'), CENTER, 5)] });
  const b = await openPage(B);
  await signIn(b, 'b@example.com');
  await openProject(b, '秋の花まつり');
  sheets.rows = twoDays(70);
  const releaseA = await startHeld(a, sheets);
  const releaseB = await startHeld(b, sheetsB);
  // 2 台の応答が、同時に届く（相手の結果は、まだどちらにも届いていない）
  await Promise.all([releaseA(), releaseB()]);
  await until(async () => [await busy(a), await busy(b)].join(''), (v) => v === '00', 10000);
  await sleep(SETTLE_MS + 1500);
  const doc = await projectDoc('秋の花まつり');
  const got = JSON.stringify([days(doc), doc.reportSync.rowsRead, doc.reportSync.rowsUsed]);
  const fromA = JSON.stringify([[['2026-11-13', 70, 1], ['2026-11-14', 58, 1]], 2, 2]);
  const fromB = JSON.stringify([[['2026-11-13', 99, 1], ['2026-11-14', 58, 1]], 3, 2]);
  ok(got === fromA || got === fromB, `共有データは、どちらか一方の結果そのもの: ${got}`);
  const expected = got === fromA ? '2 日分 128 個（取り込み 2 件／読んだ回答 2 件）' : '2 日分 157 個（取り込み 2 件／読んだ回答 3 件）';
  await until(() => status(a), (t) => t.includes(expected), 8000);
  await until(() => status(b), (t) => t.includes(expected), 8000);
  eq(await status(a), await status(b), '2 台の表示が、同じ結果にそろう');
  eq([(await jcos(a)).actual, (await jcos(b)).actual], got === fromA ? [128, 128] : [157, 157], '2 台の実績');
});

add('R21', '同じ端末の別のタブ（共有データ）の同期の結果が先に届いていたら、あとから届いた自分の同期の結果で上書きしない（同期中の状態は、タブごと）', async ({ device: mk }) => {
  const { A, a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  await syncedDoc('秋の花まつり');
  // 同じ端末の 2 つ目のタブ（ログインの状態は、引き継がれる）
  const t2 = await openPage(A);
  await t2.waitForSelector('[data-testid="space"][data-space="shared"]', { timeout: 20000 });
  await openProject(t2, '秋の花まつり');
  // タブ 1: 同期の途中（直される前の日報〔11/13 = 70〕を読んだ応答が、止まっている）
  sheets.rows = twoDays(70);
  const release = await startHeld(a, sheets);
  eq(await busy(t2), '0', 'タブ 2 は、同期中ではない');
  // タブ 2: 直されたあとの日報（11/13 = 99）で同期して、結果が共有データに保存される。タブ 1 にも届く
  sheets.rows = twoDays(99);
  await syncNow(t2);
  const theirs = await syncedDoc('秋の花まつり', (p) => days(p)[0]?.[1] === 99);
  eq(await until(() => status(a), (t) => t.includes('2 日分 157 個'), 8000).then((t) => t.includes('2 日分 157 個')), true, 'タブ 1 に、タブ 2 の結果が届くこと');
  eq(await busy(a), '1', 'タブ 1 は、まだ同期中');
  // タブ 1 の応答が、あとから届く
  await release();
  eq(await until(() => busy(a), (v) => v === '0', 10000), '0', 'タブ 1 の同期が終わること');
  await sleep(SETTLE_MS);
  ok((await status(a)).includes('2 日分 157 個'), `タブ 1 の表示（タブ 2 の結果のまま）: ${await status(a)}`);
  eq(written(await projectDoc('秋の花まつり')), written(theirs), '共有データ（タブ 2 の結果のまま）');
  ok((await toggleText(a)).includes('同期できませんでした'), `タブ 1 に、知らせが出る: ${await toggleText(a)}`);
  ok(!(await toggleText(t2)).includes('同期できませんでした'), `タブ 2 には、出ない: ${await toggleText(t2)}`);
});

add('R22', '端末に失敗の記録を置けないとき（保存領域がいっぱい、など）でも、同期の失敗は画面に出る。案件を開き直しても出て、次に成功すると消える', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  // 失敗の記録の保存だけを、失敗させる
  await a.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(k, v) {
      if (k === 'kkl_report_error_v1') throw new DOMException('quota exceeded', 'QuotaExceededError');
      return set.call(this, k, v);
    };
  });
  const stored = () => a.evaluate(() => localStorage.getItem('kkl_report_error_v1'));
  const before = await stored();
  sheets.fail = 'network';
  await syncNow(a);
  eq(await stored(), before, '端末の記録（保存できていないこと）');
  ok((await toggleText(a)).includes('同期できませんでした'), `失敗が出る: ${await toggleText(a)}`);
  ok((await a.locator('[data-testid="report-error"]').innerText()).includes('そのまま残しています'), '失敗の内容（前回の実績を残していること）');
  await a.getByRole('button', { name: '← 案件一覧' }).click();
  await openProject(a, '秋の花まつり');
  ok((await toggleText(a)).includes('同期できませんでした'), `開き直しても、失敗が出る: ${await toggleText(a)}`);
  sheets.fail = null;
  await syncNow(a);
  ok(!(await toggleText(a)).includes('同期できませんでした'), `成功すると消える: ${await toggleText(a)}`);
  ok((await status(a)).includes('2 日分 120 個'), `同期の表示: ${await status(a)}`);
});

add('R20', '同期の途中でログアウトしたとき、あとから届いた結果は、共有データにも、送信待ちの控えにも書かれない（次のログインで「前回の残り」として扱われない）。保存できなかったことは、同期の欄に出る', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await syncNow(a, SHEET_URL);
  const first = await syncedDoc('秋の花まつり');
  const outbox = () => a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length);
  await until(outbox, (n) => n === 0, 8000);                    // 最初の同期の結果は、送り終わっている
  // 同期の途中（応答が止まっている）で、ログアウトする。そのあとで、応答が届く
  sheets.rows = twoDays(70);
  const release = await startHeld(a, sheets);
  await signOut(a);
  await release();
  await sleep(SETTLE_MS);
  eq(written(await projectDoc('秋の花まつり')), written(first), 'ログアウトのあとに届いた結果は、共有データに書かれない');
  eq(await outbox(), 0, '送信待ちの控えにも入らない');
  // もう一度ログインしても、何も送られず、控えの案件もできない
  await signIn(a, 'a@example.com');
  await sleep(4000);
  eq(written(await projectDoc('秋の花まつり')), written(first), '次のログインのあとも、共有データは変わらない');
  eq((await notices(a)).filter((t) => t.includes('控え') || t.includes('前回')), [], '「前回の残り」のお知らせ（出ないこと）');
  await openProject(a, '秋の花まつり');
  ok((await status(a)).includes('2 日分 120 個'), `実績は、前回のまま: ${await status(a)}`);
  ok((await toggleText(a)).includes('同期できませんでした'), `保存できなかったことが出る: ${await toggleText(a)}`);
  ok((await detail(a)).includes('同期の結果を保存できませんでした'), `知らせの内容: ${await detail(a)}`);
  // もう一度同期すると、取り込める
  await a.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  await syncNow(a);
  ok((await status(a)).includes('2 日分 128 個'), `もう一度同期したあと: ${await status(a)}`);
  ok(!(await toggleText(a)).includes('同期できませんでした'), `知らせは消える: ${await toggleText(a)}`);
});

// ── 実機での確認を、安全に行うための前提 ──────────────────────────
add('R19', '実機確認の安全策: 現在のルールが許可していないチーム名（VITE_TEAM_ID）でビルドしたアプリは、ログインしても共有データを読めず、書けない。「この端末だけのデータ」では日報を同期でき、Firestore には 1 件も書かれない', async ({ device: mk }) => {
  const OTHER = 'kkl-preview-check';
  const app = await startApp({ env: { VITE_TEAM_ID: OTHER } });
  try {
    const P = await mk('P', app.url);
    const sheets = await fakeSheets(P, { rows: [answer(serial('2026-11-13'), 'ラソラ札幌', 81), answer(serial('2026-11-14'), 'ラソラ札幌', 64)] });
    const p = await openPage(P);
    // ログインすると、共有データは「表示できません」になる（使い始める・移行するためのボタンは出ない）
    await signIn(p, 'a@example.com', { expectPhase: 'unregistered' });
    const panel = (await p.locator('[data-testid="shared-phase"]').innerText()).replace(/\s+/g, ' ');
    ok(panel.includes('共有データは表示できません') && panel.includes('「この端末だけのデータ」は、これまでどおり使えます'), `ログイン直後の表示: ${panel}`);
    eq(await p.locator('[data-testid="shared-phase"] button').allInnerTexts(), ['「この端末だけのデータ」を表示する', '登録されたので、もう一度確認する'], '押せるボタン');
    await p.getByRole('button', { name: '登録されたので、もう一度確認する' }).click();
    await sleep(1500);
    eq(await p.locator('[data-testid="space"]').getAttribute('data-phase'), 'unregistered', 'もう一度確認しても、共有データは使えないまま');
    // 「この端末だけのデータ」で、案件を用意して、日報を同期する
    await p.getByRole('button', { name: '「この端末だけのデータ」を表示する' }).click();
    await p.waitForSelector('[data-testid="space"][data-space="local"]');
    await loadSample(p);
    await openProject(p, 'ikyu');
    await p.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
    await syncNow(p, SHEET_URL);
    ok((await status(p)).includes('2 日分 145 個'), `同期後の表示: ${await status(p)}`);
    eq((await jcos(p)).actual, 145, '実績（81 ＋ 64）');
    eq(sheets.calls.length, 3, '日報への問い合わせの数');
    // 案件一覧の「共有へコピー」を押しても、共有データには書かれない（共有データを使える状態ではないため、何も起きない）
    await p.getByRole('button', { name: '← 案件一覧' }).click();
    await p.getByRole('button', { name: '共有へコピー' }).first().click();
    await sleep(2500);
    // Firestore には、本番と同じチーム名の下にも、このチーム名の下にも、1 件も無い
    const counts = {};
    for (const team of [TEAM, OTHER]) {
      for (const c of [...V3_COLLS, ...LEGACY_COLLS, 'members', 'wsRulesProbe']) {
        const n = (await admin.list(`teams/${team}/${c}`)).length;
        if (n > 0) counts[`teams/${team}/${c}`] = n;
      }
    }
    eq(counts, {}, 'Firestore に書かれたドキュメント');
  } finally {
    app.stop();
  }
});

await runFile('日報の同期（Version 4）');
