// 日報の同期（Version 4）を、実ブラウザで確かめる。起動は run.mjs から（エミュレータを立ち上げたうえで、このファイルを実行する）。
//
// 相手にするのは、ローカルの Firebase エミュレータ（ログインと共有データ）と、差し替えた Google Sheets API の応答だけ。
// 実際の Google（認証の画面・Sheets API・実際の日報）にはつながない。
//   - 認証: エミュレータのときだけ有効な入口（window.__kkl.sheetsToken）から、テスト用の値を渡す
//   - Sheets API: ブラウザから https://sheets.googleapis.com/ への通信を横取りし、テストが持っている表から応答を作る
// ここで確かめられないもの: 実際の Google の確認画面（未審査アプリの警告・許可のチェック）、Sheets API の有効化、
//   実際の日報の閲覧権限。これらは、実環境での確認事項として残る。
import {
  add, admin, createProject, eq, loadSample, ok, openProject, runFile, sheet, signIn, sleep, space, tab, until, TEAM,
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
 */
async function fakeSheets(d, init = {}) {
  const state = { header: HEADER, rows: baseRows(), tabs: [{ sheetId: 0, title: '集計' }, { sheetId: 1622532141, title: TAB }], fail: null, failBody: null, calls: [], ...init };
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
      await json(200, { spreadsheetId: SHEET_ID, valueRanges: state.calls[state.calls.length - 1].ranges.map((range) => {
        const col = letterIndex(/!([A-Z]+)2:/.exec(range)[1]);
        const values = state.rows.map((r) => r[col] ?? '');
        while (values.length && values[values.length - 1] === '') values.pop();          // 実物と同じく、末尾の空欄は返さない
        return values.length ? { range, majorDimension: 'COLUMNS', values: [values] } : { range, majorDimension: 'COLUMNS' };
      }) });
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

add('R5', '同期に失敗したときは、前回の実績を消さずに残し、失敗の内容を表示する（通信エラー・権限なし・API が無効・認証切れ・見出しの不一致）', async ({ device: mk }) => {
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
    ['見出しの不一致', { header: HEADER.map((h) => (h === 'キットの使用数' ? 'キット数' : h)) }, '「キットの使用数」'],
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
    await sleep(400);
    eq(await saved(), before, `${name}: 共有データの同期結果`);
    if (name === '見出しの不一致') eq(sheets.calls.length - n, 2, '見出しを確かめられないときは、データの列を読まない（問い合わせは 2 回で止まる）');
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
  // この案件の実績にすると決める
  await openProject(a, '秋の花まつり');
  await detail(a);
  await a.locator('[data-testid="report-claim"]').click();
  await until(() => busy(a), (b) => b === '0', 10000);
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
  const { a } = await prepare(mk);
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

await runFile('日報の同期（Version 4）');
