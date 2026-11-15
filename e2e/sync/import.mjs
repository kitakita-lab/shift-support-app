// 「日報から案件を作成・更新」（Version 5）を、実ブラウザで確かめる。起動は run.mjs から（エミュレータを立ち上げたうえで、このファイルを実行する）。
//
// 相手にするのは、ローカルの Firebase エミュレータ（ログインと共有データ）と、差し替えた Google Sheets API の応答だけ（sheets.mjs）。
// 実際の Google（認証の画面・Sheets API・実際の日報）にはつながない。回答のデータは、実際の日報と同じ形に似せた、架空のもの。
// ここで確かめられないもの: 実際の Google の確認画面・Sheets API の有効化・実際の日報の閲覧権限・iPhone の Safari そのものの動作
//   （スマホの確認は、Chromium のスマホ表示。実機の Safari ではない）。
import { loadPlaywright } from '../playwright.mjs';
import { TEAM, add, admin, browser, eq, notices, ok, openProject, projectRows, runFile, sheet, signIn, signOut, sleep, space, startApp, tab, until } from './lib.mjs';
import { CONTENT, SHEET_ID, SHEET_URL, TAB, TOKEN, answer, fakeSheets, openPage } from './sheets.mjs';

const T = `teams/${TEAM}`;
const OTHER = 'kkl-preview-check';
const CENTER = '北街モール（中央広場）';
const EAST = '北街モール（東口前）';
const MINATO = 'みなと市場';
const HIKARI = 'ひかり広場（イベントコート）';
/** 実際の日報に似せた回答: テスト回答・空欄の組数・順不同の回答・同じ会場の別の開催・「その他」の会場・イベント名の無い開催 */
const baseRows = () => [
  answer('2026-07-31', 'その他', 13, { other: 'テスト会場', event: '【テスト】通しテスト' }),
  answer('2026-08-01', EAST, 98, { groups: 51, people: 126 }),
  answer('2026-08-02', EAST, 88, { groups: '', people: '' }),
  answer('2026-08-03', EAST, 49, { groups: 26, people: 61 }),
  answer('2026-08-17', CENTER, 80, { event: 'EVENT-夏の花あそび', groups: 45, people: 105 }),
  answer('2026-08-18', CENTER, 78, { event: 'EVENT-夏の花あそび', groups: 43, people: 94 }),
  answer('2026-09-12', 'その他', 48, { other: MINATO, groups: 27, people: 55 }),
  answer('2026-09-11', 'その他', 39, { other: MINATO, groups: 29, people: 48 }),
  answer('2026-09-14', CENTER, 29, { event: 'EVENT-敬老の日', groups: 22, people: 36 }),
  answer('2026-09-15', CENTER, 20, { event: 'EVENT-敬老の日', groups: 15, people: 21 }),
  answer('2026-11-13', HIKARI, 30, { event: 'EVENT-冬を待つ花あそび', groups: 17, people: 29 }),
  answer('2026-11-14', HIKARI, 99, { event: 'EVENT-冬を待つ花あそび', groups: 52, people: 121 }),
];
const NAMES = ['EVENT-冬を待つ花あそび', 'EVENT-夏の花あそび', 'EVENT-敬老の日', `${MINATO}（9/11〜9/12）`, `${EAST}（8/1〜8/3）`];
const hikariRows = (second = 99) => [answer('2026-11-13', HIKARI, 30, { groups: 17, people: 29 }), answer('2026-11-14', HIKARI, second, { groups: 52, people: 121 })];
/** JCOS の粗利（請求 4 万円/日 − 220 円 × 個数。アルバイト代は、配置した日・人数を入れたときだけ計上する＝日報から作った案件では 0 円。実装を使わずに計算） */
const gross = (days, count) => 40000 * days - 220 * count;

// ── 画面操作 ────────────────────────────────────────────────
const list = async (page) => { await tab(page, '案件'); if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click(); };
const busy = (page) => page.locator('[data-testid="import"]').getAttribute('data-busy');
const status = async (page) => (await page.locator('[data-testid="import-status"]').innerText()).replace(/\s+/g, ' ').trim();
/** 「日報から案件を作成・更新」を押して、取得が終わるまで待つ（url を渡すと、先に日報の場所を入力する） */
async function importNow(page, url) {
  await list(page);
  if (url) await page.locator('[data-testid="import-url"]').fill(url);
  await page.locator('[data-testid="import-start"]').click();
  eq(await until(() => busy(page), (b) => b === '0', 10000), '0', '取得が終わること');
  await sleep(400);
}
const detail = async (page) => (await page.locator('[data-testid="import-detail"]').innerText()).replace(/\s+/g, ' ');
const candidates = (page) => page.locator('[data-testid="import-create"]');
const candidateNames = (page) => candidates(page).locator('.rimport__name').allInnerTexts();
async function createAll(page) {
  await page.locator('[data-testid="import-create-go"]').click();
  await sleep(300);
}
const updateStates = (page) => page.locator('[data-testid="import-update"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
const projects = () => admin.list(`${T}/wsProjects`);
const venues = () => admin.list(`${T}/wsVenues`);
/** 共有データ（サーバー）に、条件を満たす内容が届くまで待つ（画面の変更は、少し間を置いてから送られる） */
const serverProjects = (pred, timeout = 12000) => until(projects, pred, timeout);
const byName = (docs, name) => docs.find((p) => p.name === name);
const days = (doc) => (doc?.reportSync?.days ?? []).map((d) => [d.date, d.count]);
const yenNum = (s) => Number(String(s).replace(/−/g, '-').replace(/[^\d.-]/g, ''));
async function jcos(page) {
  await sheet(page, '試算');
  await page.waitForSelector('[data-testid="jcos-view"]');
  const t = (id) => page.locator(`[data-testid="${id}"]`).innerText();
  return { billing: yenNum(await t('jcos-billing')), cost: yenNum(await t('jcos-cost')), gross: yenNum(await t('jcos-gross')), actual: Number(await t('jcos-actual')), basis: await page.locator('[data-testid="jcos-view"]').getAttribute('data-basis') };
}
async function addVenue(page, name) {
  await tab(page, '会場');
  await page.getByRole('button', { name: '＋ 会場を追加' }).click();
  await page.locator('[data-c="name"]').last().fill(name);
}
const row = (page, label) => page.locator('table.kv tr', { has: page.locator('th', { hasText: new RegExp(`^${label}`) }) });
/** 手で、案件を作って開く（会場・会期つき）。jcos: false なら、収支の計算方法は「汎用」のまま */
async function manualProject(page, { name, venue, start, end, jcos: asJcos = true }) {
  await list(page);
  await page.getByRole('button', { name: '＋ 新しい案件' }).click();
  await row(page, '案件名').locator('input').fill(name);
  if ((await row(page, '会場').locator('select option:checked').innerText()) !== venue) await row(page, '会場').locator('select').selectOption({ label: venue });
  await row(page, '開始日').locator('input').fill(start);
  await row(page, '終了日').locator('input').fill(end);
  if (!asJcos) return;
  await page.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
  await page.waitForSelector('[data-testid="report-bar"]');
}
/** A がログインして、差し替えの日報をつないだ状態にする */
async function prepare(mk, rows = baseRows()) {
  const A = await mk('A');
  const sheets = await fakeSheets(A, { rows });
  const a = await openPage(A);
  await signIn(a, 'a@example.com');
  return { A, a, sheets };
}
/** スマホ（iPhone 相当の幅・タッチ）の端末 */
async function phone(url) {
  const { devices } = loadPlaywright();
  const ctx = await (await browser()).newContext({ ...devices['iPhone 13'], timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const d = { name: 'phone', ctx, url, dialogs: [], errors: [], accept: true };
  d.open = async () => {
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    page.on('dialog', async (dlg) => { d.dialogs.push(dlg.message().replace(/\s+/g, ' ')); if (d.accept) await dlg.accept(); else await dlg.dismiss(); });
    page.on('pageerror', (e) => d.errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => !!window.__kkl);
    return page;
  };
  d.close = () => ctx.close();
  return d;
}

// ── 確認項目 ────────────────────────────────────────────────
add('I1', '日報から新規案件を作成できる: 「日報から案件を作成・更新」を押すと、開催ごとの候補が出て、1 回の操作で、会場・開催日・実績つきの案件になる（会場と開催日を、入力し直さない）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  eq(await status(a), 'まだ取得していません', '取得前の表示');
  await importNow(a, SHEET_URL);
  eq((await candidateNames(a)).sort(), [...NAMES].sort(), '新しい案件の候補');
  const before = await detail(a);
  ok(before.includes('会場マスタに新しく登録') && before.includes('3 日・キット 235 個・組数 77（未入力 1 日）・人数 187（未入力 1 日）'), `候補の内容: ${before}`);
  ok((await status(a)).includes('回答 11 件（テスト回答 1 件を除く）') && (await status(a)).includes('新しい案件の候補 5 件'), `取得後の表示: ${await status(a)}`);
  // 候補を見ただけでは、何も作られない
  await sleep(1200);
  eq([(await projects()).length, (await venues()).length], [0, 0], '候補を表示しただけの時点の、案件と会場の数');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 5 && xs.every((p) => p.reportSync));
  eq(docs.map((p) => p.name).sort(), [...NAMES].sort(), '作られた案件');
  const vs = await until(venues, (xs) => xs.length === 4);
  eq(vs.map((v) => v.name).sort(), [CENTER, EAST, MINATO, HIKARI].sort(), '会場マスタに登録された会場（同じ会場は 1 件）');
  // 案件の中身: 会場・開催日・実績・JCOS 案件・日報の場所
  const hikari = byName(docs, 'EVENT-冬を待つ花あそび');
  eq([hikari.venueId, hikari.startDate, hikari.endDate, hikari.status, hikari.jcos.enabled], [vs.find((v) => v.name === HIKARI).id, '2026-11-13', '2026-11-14', '実施済', true], '案件の会場・会期・状態・収支の計算方法');
  eq(hikari.reportSync.days.map((d) => [d.date, d.count, d.groups, d.people]), [['2026-11-13', 30, 17, 29], ['2026-11-14', 99, 52, 121]], '日別の実績（個数・組数・人数）');
  eq(hikari.reportSource, { spreadsheetId: SHEET_ID, gid: 1622532141 }, '日報の場所');
  eq(hikari.reportSync.contents, [{ label: CONTENT, rows: 2, count: 129 }], 'イベント内容');
  const east = byName(docs, `${EAST}（8/1〜8/3）`);
  eq(east.reportSync.days.map((d) => [d.date, d.count, d.groups ?? null, d.people ?? null]), [['2026-08-01', 98, 51, 126], ['2026-08-02', 88, null, null], ['2026-08-03', 49, 26, 61]], '組数・人数が空欄の日は、未入力のまま（0 にしない）');
  // 同じ会場の、別の期間の開催は、別の案件になる（会場は同じ）
  const c1 = byName(docs, 'EVENT-夏の花あそび'), c2 = byName(docs, 'EVENT-敬老の日');
  eq([c1.venueId === c2.venueId, c1.startDate, c1.endDate, c2.startDate, c2.endDate], [true, '2026-08-17', '2026-08-18', '2026-09-14', '2026-09-15'], '同じ会場の 2 つの開催');
  // 画面: 一覧に 5 件。候補は無くなり、作成の知らせが出る
  eq((await projectRows(a)).sort(), [...NAMES].sort(), '案件一覧');
  eq(await candidates(a).count(), 0, '作成のあとの、候補の数');
  ok((await notices(a)).some((t) => t.includes('案件 5 件を作成しました') && t.includes('会場 4 件')), `作成の知らせ: ${JSON.stringify(await notices(a))}`);
  ok((await status(a)).includes('作成 5 件') && (await status(a)).includes('未反映・競合なし'), `作成後の表示: ${await status(a)}`);
  // 収支: 実績個数で、粗利が出る
  await openProject(a, 'EVENT-冬を待つ花あそび');
  eq(await jcos(a), { billing: 80000, cost: 129 * 220, gross: gross(2, 129), actual: 129, basis: 'actual' }, '作った案件の収支');
  ok((await a.locator('[data-testid="jcos-people"]').innerText()).replace(/\s+/g, ' ').includes('組数 69・人数 150'), '試算に、参加組数・参加人数が出ること');
  // 取得は 1 回（3 回の問い合わせ）だけ。読み取りだけ・利用者の認証つき
  eq(sheets.calls.length, 3, '日報への問い合わせの数');
  ok(sheets.calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`), '問い合わせは、読み取りだけ・認証つき');
  // ほかの端末にも届く
  const B = await mk('B');
  const b = await B.open();
  await signIn(b, 'b@example.com');
  eq((await until(() => projectRows(b), (xs) => xs.length === 5, 10000)).sort(), [...NAMES].sort(), 'ほかの端末の案件一覧');
});

add('I2', '読むのは必要な列だけ。メールアドレス・入力者・内部メモ・参加者エピソード・テスト回答の中身・認証は、共有データにも端末にも画面にも残らない', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await importNow(a, SHEET_URL);
  await createAll(a);
  await serverProjects((xs) => xs.length === 5 && xs.every((p) => p.reportSync));
  await sleep(800);
  eq([...sheets.calls[2].ranges].sort(), ['D', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((c) => `'${TAB}'!${c}2:${c}`), '読む列（開催日・会場・会場（その他の場合）・イベント名・イベント内容・参加組数・参加人数・キットの使用数）');
  eq(sheets.calls[0].fields, 'sheets.properties(sheetId,title)', 'タブの一覧は、名前と ID だけ');
  eq(sheets.calls[1].path, `/v4/spreadsheets/${SHEET_ID}/values/'${TAB}'!1:1`, '見出し行');
  const stored = JSON.stringify([await projects(), await venues()]);
  const local = await a.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const secret of ['SECRET', '通しテスト', 'テスト会場', TOKEN]) {
    ok(!stored.includes(secret), `共有データに「${secret}」が入っています`);
    ok(!local.includes(secret), `端末の保存領域に「${secret}」が入っています`);
    ok(!(await a.content()).includes(secret), `画面に「${secret}」が出ています`);
  }
  // イベント名は、案件名にだけ入る（同期の結果・会場には入らない）
  const docs = await projects();
  ok(!JSON.stringify(docs.map((p) => p.reportSync)).includes('EVENT-') && !JSON.stringify(await venues()).includes('EVENT-'), 'イベント名が、同期の結果か会場に入っています');
});

add('I3', '会場が自動登録される・同じ会場が重複登録されない・既存の会場をそのまま使う（全角/半角・空白だけの違いは、同じ会場）', async ({ device: mk }) => {
  const rows = baseRows();
  rows.push(answer('2026-09-16', '北街モール(中央広場)', 11));          // 半角の括弧（9/14〜9/15 の開催に続く日）
  const { a } = await prepare(mk, rows);
  await addVenue(a, CENTER);                                          // 先に、手で登録してある会場
  const first = await until(venues, (xs) => xs.length === 1 && xs[0].name === CENTER);
  await importNow(a, SHEET_URL);
  const text = await detail(a);
  ok(text.includes('登録済み') && text.includes('会場マスタに新しく登録'), `候補の会場の表示: ${text}`);
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 5 && xs.every((p) => p.reportSync));
  const vs = await until(venues, (xs) => xs.length === 4);
  eq(vs.map((v) => v.name).sort(), [CENTER, EAST, MINATO, HIKARI].sort(), '会場マスタ');
  eq(vs.filter((v) => v.name === CENTER).map((v) => v.id), [first[0].id], '手で登録してあった会場は、そのまま（作り直さない・増えない）');
  eq(docs.filter((p) => p.venueId === first[0].id).length, 2, '登録済みの会場を使う案件の数');
  eq(days(byName(docs, 'EVENT-敬老の日')), [['2026-09-14', 29], ['2026-09-15', 20], ['2026-09-16', 11]], '半角の括弧の回答も、同じ会場の実績になる');
  // もう一度取得しても、会場も案件も増えない
  await importNow(a);
  await sleep(1500);
  eq([await candidates(a).count(), (await venues()).length, (await projects()).length], [0, 4, 5], 'もう一度取得したあとの、候補・会場・案件の数');
  // 会場タブ: 自動で登録した会場は、日報での表記を別名にも持つ
  eq(vs.find((v) => v.name === HIKARI).reportNames, [HIKARI], '自動で登録した会場の別名');
});

add('I4', '会場と会期で照合する。イベント名が空欄でも、案件名が違っていても、会場と会期が合う既存の案件に実績が入る（新しい案件は作らない）', async ({ device: mk }) => {
  const { a } = await prepare(mk, [answer('2026-11-13', HIKARI, 30, { event: '' }), answer('2026-11-14', HIKARI, 99, { event: 'EVENT-別の名前' }), answer('2026-11-14', EAST, 7)]);
  await addVenue(a, HIKARI);
  await manualProject(a, { name: '冬の開催（予定）', venue: HIKARI, start: '2026-11-13', end: '2026-11-17' });
  await importNow(a, SHEET_URL);
  // 既存の案件の更新は、そのまま反映される（確認の操作は要らない）
  const docs = await serverProjects((xs) => !!byName(xs, '冬の開催（予定）')?.reportSync);
  eq(days(byName(docs, '冬の開催（予定）')), [['2026-11-13', 30], ['2026-11-14', 99]], '既存の案件に入った実績');
  eq(await until(() => updateStates(a), (s) => s.join() === 'done', 8000), ['done'], '既存の案件の行の状態');
  eq(await candidateNames(a), [`${EAST}（11/14）`], '新しい候補は、別の会場の開催だけ');
  eq((await projects()).length, 1, '案件の数（増えていない）');
  ok((await status(a)).includes('既存の案件 1 件（更新 1 件）'), `表示: ${await status(a)}`);
  await openProject(a, '冬の開催（予定）');
  eq(await jcos(a), { billing: 200000, cost: 129 * 220, gross: gross(5, 129), actual: 129, basis: 'mixed' }, '既存の案件の収支（5 日のうち 2 日が実績）');
});

add('I5', '再同期で、実績が二重に入らない（一覧からの取得を繰り返しても、案件の「日報を同期」を押しても、同じ）', async ({ device: mk }) => {
  const { a } = await prepare(mk);
  await importNow(a, SHEET_URL);
  await createAll(a);
  const first = await serverProjects((xs) => xs.length === 5 && xs.every((p) => p.reportSync));
  const shape = (docs) => JSON.stringify(docs.map((p) => [p.name, p.startDate, p.endDate, days(p)]).sort());
  for (let i = 0; i < 3; i++) await importNow(a);
  await sleep(1500);
  eq(shape(await projects()), shape(first), '3 回取得し直したあとの、案件と実績');
  eq([(await projects()).length, (await venues()).length, await candidates(a).count()], [5, 4, 0], '案件・会場・候補の数');
  eq(await updateStates(a), ['done', 'done', 'done', 'done', 'done'], '既存の案件は、どれも「日報と同じ内容」');
  // 同じ内容なら、案件は書き換えない（同期した日時も変わらない）
  eq(JSON.stringify((await projects()).map((p) => [p.name, p.reportSync.at]).sort()), JSON.stringify(first.map((p) => [p.name, p.reportSync.at]).sort()), '同期した日時（変わっていないこと）');
  await openProject(a, 'EVENT-冬を待つ花あそび');
  await a.locator('[data-testid="report-sync"]').click();
  await until(() => a.locator('[data-testid="report-bar"]').getAttribute('data-busy'), (b) => b === '0', 10000);
  eq((await jcos(a)).actual, 129, '案件の「日報を同期」を押したあとの実績');
  // 案件の「日報を同期」は、同期した日時を書き換える。共有データに届いても、実績は同じ
  const at0 = byName(first, 'EVENT-冬を待つ花あそび').reportSync.at;
  const after = await serverProjects((xs) => byName(xs, 'EVENT-冬を待つ花あそび')?.reportSync?.at !== at0);
  eq(shape(after), shape(first), '案件の「日報を同期」のあとの、案件と実績');
});

add('I6', '日報の修正・削除が反映される: 個数を直した回答・削除した回答は、次の取得で、案件の実績に入る（置き換え。足し込まない）。粗利も計算し直される', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk);
  await importNow(a, SHEET_URL);
  await createAll(a);
  await serverProjects((xs) => xs.length === 5 && xs.every((p) => p.reportSync));
  sheets.rows = baseRows().map((r) => { const x = [...r]; if (x[5] === HIKARI && x[11] === 99) x[11] = 90; return x; }).filter((r) => !(r[5] === EAST && r[11] === 88));
  await importNow(a);
  const docs = await serverProjects((xs) => days(byName(xs, 'EVENT-冬を待つ花あそび')).join() === '2026-11-13,30,2026-11-14,90' && days(byName(xs, `${EAST}（8/1〜8/3）`)).length === 2);
  eq(days(byName(docs, `${EAST}（8/1〜8/3）`)), [['2026-08-01', 98], ['2026-08-03', 49]], '回答を削除した日は、実績から無くなる');
  eq((await projects()).length, 5, '案件の数（増えていない）');
  ok((await status(a)).includes('更新 2 件'), `表示: ${await status(a)}`);
  await openProject(a, 'EVENT-冬を待つ花あそび');
  eq(await jcos(a), { billing: 80000, cost: 120 * 220, gross: gross(2, 120), actual: 120, basis: 'actual' }, '修正のあとの収支');
});

add('I7', '連続していない開催日: 1 日あいた開催は、別々の候補になる。「前の開催と同じ案件にする」を選ぶと 1 件になり、間の日は開催していない日（請求しない・アルバイト 0 人）になる。あとからその日の回答が入れば、開催した日に戻る', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', CENTER, 10), answer('2026-11-14', CENTER, 12), answer('2026-11-16', CENTER, 9), answer('2026-11-17', CENTER, 8)]);
  await importNow(a, SHEET_URL);
  eq(await candidateNames(a), [`${CENTER}（11/13〜11/14）`, `${CENTER}（11/16〜11/17）`], '選ぶ前は、別々の候補');
  await a.locator('[data-testid="import-join"]').click();
  eq(await candidateNames(a), [`${CENTER}（11/13〜11/17）`], '選んだあとは、1 つの候補');
  ok((await detail(a)).includes('開催していない日として扱います'), `まとめた候補の説明: ${await detail(a)}`);
  // 「分ける」で戻せる
  await a.locator('[data-testid="import-split"]').click();
  eq((await candidateNames(a)).length, 2, '「分ける」のあと');
  await a.locator('[data-testid="import-join"]').click();
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq([docs[0].startDate, docs[0].endDate, days(docs[0]), docs[0].jcos.days], ['2026-11-13', '2026-11-17', [['2026-11-13', 10], ['2026-11-14', 12], ['2026-11-16', 9], ['2026-11-17', 8]], { '2026-11-15': { billed: false, partTimers: 0, notHeld: true } }], '作られた案件（会期・実績・開催していない日）');
  await openProject(a, `${CENTER}（11/13〜11/17）`);
  // 開催した 4 日すべてに実績があるので、「全日が実績」（開催していない日は、実績が無くてよい）
  eq(await jcos(a), { billing: 160000, cost: 39 * 220, gross: gross(4, 39), actual: 39, basis: 'actual' }, '収支（開催した 4 日分だけ）');
  const gap = (await a.locator('[data-testid="jcos-day-2026-11-15"]').innerText()).replace(/\s+/g, ' ');
  ok(gap.includes('開催なし') && gap.includes('請求しない') && gap.includes('0人'), `間の日の表示: ${gap}`);
  // あとから、間の日（11/15）の回答が日報に入ったら、次の取得で、開催した日に戻る（請求する日になる）
  sheets.rows = [...sheets.rows, answer('2026-11-15', CENTER, 20)];
  await importNow(a);
  const filled = await serverProjects((xs) => days(xs[0]).length === 5);
  eq(filled[0].jcos.days, {}, '間の日の回答が入ったあとの、日ごとの設定（開催していない日の印が外れる）');
  await openProject(a, `${CENTER}（11/13〜11/17）`);
  eq(await jcos(a), { billing: 200000, cost: 59 * 220, gross: gross(5, 59), actual: 59, basis: 'actual' }, '間の日の回答が入ったあとの収支（5 日分）');
});

add('I8', '同じ会場の別の案件を、誤って 1 つにしない: 会期が重なる案件が 2 件あるときは、どちらにも入れずに確認を求める（新しい案件も作らない）', async ({ device: mk }) => {
  const { a } = await prepare(mk, [answer('2026-11-14', CENTER, 44), answer('2026-11-15', CENTER, 55)]);
  await addVenue(a, CENTER);
  await manualProject(a, { name: '案件ア', venue: CENTER, start: '2026-11-13', end: '2026-11-15' });
  await manualProject(a, { name: '案件イ', venue: CENTER, start: '2026-11-14', end: '2026-11-16' });
  await importNow(a, SHEET_URL);
  const text = (await a.locator('[data-testid="import-ambiguous"]').innerText()).replace(/\s+/g, ' ');
  ok(text.includes('案件が 2 件ある') && text.includes('「案件ア」を開く') && text.includes('「案件イ」を開く'), `確認の表示: ${text}`);
  ok((await status(a)).includes('確認が必要 1 件') && (await status(a)).includes('新しい案件の候補 0 件'), `表示: ${await status(a)}`);
  await sleep(2000);
  const docs = await projects();
  eq([docs.length, docs.map((p) => !!p.reportSync)], [2, [false, false]], '案件の数と、実績（どちらにも入っていない）');
});

add('I9', '権限不足・通信の失敗・見出しの不一致のときは、何も作らず、何も変えない（前回の実績が残る）。失敗として表示する', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, hikariRows());
  await importNow(a, SHEET_URL);
  await createAll(a);
  const before = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  await sleep(1000);
  const snap = async () => JSON.stringify([await projects(), await venues()]);
  const s0 = await snap();
  sheets.rows = [...hikariRows(1), answer('2026-12-01', EAST, 5)];            // 読めていれば、実績が変わり、新しい候補も出る内容
  for (const [name, set, word] of [
    ['権限不足（403）', () => { sheets.fail = 403; }, '閲覧する権限がありません'],
    ['通信の失敗', () => { sheets.fail = 'network'; }, '通信できない'],
    ['Sheets API が無効', () => { sheets.fail = 403; sheets.failBody = { error: { code: 403, message: 'Google Sheets API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }; }, 'Google Sheets API が'],
    ['見出しの不一致', () => { sheets.fail = null; sheets.failBody = null; sheets.header = sheets.header.map((h) => (h === 'キットの使用数' ? '使用数' : h)); }, '見出しを確かめられませんでした'],
  ]) {
    set();
    await importNow(a);
    const err = (await a.locator('[data-testid="import-error"]').innerText()).replace(/\s+/g, ' ');
    ok(err.includes(word) && err.includes('何も変えていません'), `${name}: 失敗の表示: ${err}`);
    ok((await a.locator('[data-testid="import-toggle"]').innerText()).includes('取得できませんでした'), `${name}: 見出しの表示`);
    await sleep(1200);
    eq(await snap(), s0, `${name}: 共有データ（1 文字も変わっていないこと）`);
    eq(await candidates(a).count(), 0, `${name}: 候補は出ない`);
  }
  eq(days((await projects())[0]), days(before[0]), '前回の実績が残っていること');
});

add('I10', '読み取れない回答があるとき: その開催だけ止める（既存の案件は前回の実績のまま・新しい候補は作成できない）。ほかの開催は進められる。どの回答の、どの項目かを示す', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, hikariRows());
  await importNow(a, SHEET_URL);
  await createAll(a);
  await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  // 既存の案件の回答の 1 件が「99個」（数字以外）。別の会場に、読める開催（みなと市場）と、読めない開催（東口前の人数）がある
  sheets.rows = [answer('2026-11-13', HIKARI, 30, { groups: 17, people: 29 }), answer('2026-11-14', HIKARI, '99個', { groups: 52, people: 121 }),
    answer('2026-11-20', 'その他', 21, { other: MINATO }), answer('2026-11-21', EAST, 8, { people: '約 20 人' })];
  await importNow(a);
  eq(await until(() => updateStates(a), (s) => s.join() === 'failed', 8000), ['failed'], '既存の案件の行の状態');
  const upd = (await a.locator('[data-testid="import-updates"]').innerText()).replace(/\s+/g, ' ');
  ok(upd.includes('反映できませんでした') && upd.includes('日報の 3 行目') && upd.includes('「キットの使用数」に数字以外の文字'), `既存の案件の表示: ${upd}`);
  eq(await candidateNames(a), [`${MINATO}（11/20）`], '作成できる候補（読める開催だけ）');
  const blocked = (await a.locator('[data-testid="import-blocked"]').innerText()).replace(/\s+/g, ' ');
  ok(blocked.includes('日報の 5 行目') && blocked.includes('「参加人数」に数字以外の文字'), `作成できない候補の表示: ${blocked}`);
  ok(!(await a.content()).includes('約 20 人') && !(await a.content()).includes('99個'), '回答に書かれていた文字が、画面に出ています');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 2 && xs.every((p) => p.reportSync));
  eq(days(docs.find((p) => p.name !== `${MINATO}（11/20）`)), [['2026-11-13', 30], ['2026-11-14', 99]], '既存の案件は、前回の実績のまま');
  // 既存の案件を開くと、同じ失敗が出ている（案件の「日報を同期」と同じ記録）
  await openProject(a, `${HIKARI}（11/13〜11/14）`);
  ok((await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした'), '案件の画面に、失敗が出ること');
  // 日報を直すと、取り込める
  sheets.rows = [...hikariRows(95), answer('2026-11-20', 'その他', 21, { other: MINATO }), answer('2026-11-21', EAST, 8, { people: 20 })];
  await importNow(a);
  await serverProjects((xs) => days(byName(xs, `${HIKARI}（11/13〜11/14）`)).join() === '2026-11-13,30,2026-11-14,95');
  eq(await candidateNames(a), [`${EAST}（11/21）`], '直したあとの候補');
});

add('I11', '開催中の案件: 日報から作った案件は、次の日の回答が増えると、会期が自動で伸びる（一覧からの取得でも、案件の「日報を同期」でも）。新しい案件は増えず、案件名の開催日も合わせて変わる', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', HIKARI, 30)]);
  await importNow(a, SHEET_URL);
  await createAll(a);
  const first = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq([first[0].startDate, first[0].endDate, first[0].reportPeriod], ['2026-11-13', '2026-11-13', { startDate: '2026-11-13', endDate: '2026-11-13' }], '作った直後の会期');
  sheets.rows = [answer('2026-11-13', HIKARI, 30), answer('2026-11-14', HIKARI, 99)];
  await importNow(a);
  eq(first[0].name, `${HIKARI}（11/13）`, '作った直後の案件名');
  const second = await serverProjects((xs) => xs[0]?.endDate === '2026-11-14');
  eq([second.length, second[0].endDate, second[0].reportPeriod, days(second[0])], [1, '2026-11-14', { startDate: '2026-11-13', endDate: '2026-11-14' }, [['2026-11-13', 30], ['2026-11-14', 99]]], '次の日の回答が増えたあと');
  eq(second[0].name, `${HIKARI}（11/13〜11/14）`, '案件名の開催日も、会期に合わせて変わる');
  sheets.rows = [...sheets.rows, answer('2026-11-15', HIKARI, 41)];
  await openProject(a, `${HIKARI}（11/13〜11/14）`);
  await a.locator('[data-testid="report-sync"]').click();
  await until(() => a.locator('[data-testid="report-bar"]').getAttribute('data-busy'), (b) => b === '0', 10000);
  const third = await serverProjects((xs) => xs[0]?.endDate === '2026-11-15');
  eq([third.length, days(third[0]).length, third[0].name], [1, 3, `${HIKARI}（11/13〜11/15）`], '案件の「日報を同期」でも、会期が伸びる（案件名も合わせる）');
  eq(await jcos(a), { billing: 120000, cost: 170 * 220, gross: gross(3, 170), actual: 170, basis: 'actual' }, '収支（3 日分）');
});

add('I12', '会期を手で決めた案件は、自動では広げない: 会期の外の回答は「取り込んでいません」と示し、利用者が選んだときだけ、会期を広げて取り込む（一覧でも、案件の画面でも）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', EAST, 20), answer('2026-11-14', EAST, 25)]);
  await addVenue(a, EAST);
  await manualProject(a, { name: '手で作った案件', venue: EAST, start: '2026-11-13', end: '2026-11-13' });
  await importNow(a, SHEET_URL);
  const docs = await serverProjects((xs) => !!xs[0]?.reportSync);
  eq([docs[0].endDate, days(docs[0])], ['2026-11-13', [['2026-11-13', 20]]], '会期の中の日だけが入る（会期は変わらない）');
  const out = (await a.locator('[data-testid="import-outside"]').innerText()).replace(/\s+/g, ' ');
  ok(out.includes('会期の外に、この開催の回答があります') && out.includes('11/14'), `一覧の表示: ${out}`);
  ok((await status(a)).includes('確認が必要 1 件'), `表示: ${await status(a)}`);
  eq(await candidates(a).count(), 0, '新しい候補にはしない（同じ開催の続き）');
  // 案件の画面にも、同じ知らせが出る
  await openProject(a, '手で作った案件');
  ok((await a.locator('[data-testid="report-status"]').innerText()).includes('未反映 1 日'), `案件の同期の表示: ${await a.locator('[data-testid="report-status"]').innerText()}`);
  await a.locator('[data-testid="report-toggle"]').click();
  ok((await a.locator('[data-testid="report-outside"]').innerText()).includes('会期のすぐ外に、この会場の日報があります'), '案件の画面の知らせ');
  // 一覧に戻る（案件を開いて戻ってきても、取得した内容は開いたまま残っている）。「会期を広げて取り込む」
  await list(a);
  await a.locator('[data-testid="import-widen"]').click();
  const wide = await serverProjects((xs) => xs[0]?.endDate === '2026-11-14');
  eq([days(wide[0]), wide[0].reportPeriod ?? null, wide[0].name], [[['2026-11-13', 20], ['2026-11-14', 25]], null, '手で作った案件'], '広げたあと（手で決めた会期の案件のまま。手で付けた案件名も、変わらない）');
  // 広げたあとも、自動では伸びない: 次の日の回答が増えても、会期はそのまま。「会期のすぐ外の回答」として示し、選んだときだけ広げる
  sheets.rows = [...sheets.rows, answer('2026-11-15', EAST, 30), answer('2026-11-17', EAST, 12)];
  await openProject(a, '手で作った案件');
  await a.locator('[data-testid="report-sync"]').click();
  await until(() => a.locator('[data-testid="report-bar"]').getAttribute('data-busy'), (b) => b === '0', 10000);
  const still = await serverProjects((xs) => (xs[0]?.reportSync?.outside ?? []).length === 2);
  eq([still[0].endDate, still[0].reportSync.outside.map((o) => o.date)], ['2026-11-14', ['2026-11-15', '2026-11-17']], '同期しても、会期は変わらない（会期の外の回答が 2 日分）');
  await a.locator('[data-testid="report-widen"]').click();
  const last = await serverProjects((xs) => xs[0]?.endDate === '2026-11-17');
  eq([days(last[0]).length, last[0].jcos.days, last[0].reportPeriod ?? null], [4, { '2026-11-16': { billed: false, partTimers: 0, notHeld: true } }, null], '1 日あいた日まで広げたあと（間の日は、開催していない日）');
});

add('I13', '手入力の実績がある案件: 日報と違う値は、上書きせずに「競合」として示す（計算には日報を使い、手入力の値は残す）。「手入力を消す」で解消できる', async ({ device: mk }) => {
  const { a } = await prepare(mk, hikariRows());
  await addVenue(a, HIKARI);
  await manualProject(a, { name: '手入力のある案件', venue: HIKARI, start: '2026-11-13', end: '2026-11-14' });
  await sheet(a, '試算');
  await a.getByLabel('11/13(金) の実績個数（手入力）').fill('50');
  await a.getByLabel('11/14(土) の実績個数（手入力）').fill('99');
  await sheet(a, '基本情報');
  await importNow(a, SHEET_URL);
  const docs = await serverProjects((xs) => !!xs[0]?.reportSync);
  eq([docs[0].actualsManual, days(docs[0])], [{ '2026-11-13': 50, '2026-11-14': 99 }, [['2026-11-13', 30], ['2026-11-14', 99]]], '手入力の値は消えず、日報の実績が入る');
  // 一覧のまとめにも、競合として出る（「未反映・競合なし」とは出さない）
  const sum = await until(() => status(a), (t) => t.includes('確認が必要'), 8000);
  ok(sum.includes('確認が必要 1 件（うち、手入力との競合 1 件）') && !sum.includes('競合なし'), `一覧の表示: ${sum}`);
  ok((await a.locator('[data-testid="import-conflict"]').innerText()).includes('日報の個数が違う日が 1 日あります'), '一覧の、案件の行の知らせ');
  await openProject(a, '手入力のある案件');
  const st = await a.locator('[data-testid="report-status"]').innerText();
  ok(st.includes('競合 1 日'), `案件の同期の表示: ${st}`);
  await a.locator('[data-testid="report-toggle"]').click();
  ok((await a.locator('[data-testid="report-conflicts"]').innerText()).replace(/\s+/g, ' ').includes('11/13(金)：手入力 50 個／日報 30 個'), '競合の内容（値が同じ 11/14 は、競合ではない）');
  eq((await jcos(a)).actual, 129, '計算には、日報の個数を使う');
  ok((await a.locator('[data-testid="jcos-conflicts"]').innerText()).includes('1 日'), '試算の画面の知らせ');
  await a.locator('[data-testid="jcos-clear-manual"]').click();
  await until(() => a.locator('[data-testid="jcos-conflicts"]').count(), (n) => n === 0, 5000);
  ok((await a.locator('[data-testid="report-status"]').innerText()).includes('未反映・競合なし'), '解消したあとの表示');
  const after = await serverProjects((xs) => !('2026-11-13' in (xs[0]?.actualsManual ?? {})));
  eq(after[0].actualsManual, { '2026-11-14': 99 }, '消したのは、その日の手入力だけ');
  // 一覧に戻ると、競合の知らせは消えている
  await list(a);
  ok((await status(a)).includes('未反映・競合なし'), `解消したあとの、一覧の表示: ${await status(a)}`);
  eq(await a.locator('[data-testid="import-conflict"]').count(), 0, '一覧の、競合の知らせ');
});

add('I14', '記号・空白だけが違う会場が登録済みのとき: 勝手にまとめず、勝手に増やさず、確認を求める。「別の会場」を選ぶと新しく登録する候補になり、「同じ会場」を選ぶと、その場で別名が登録されて、登録済みの会場の候補になる', async ({ device: mk }) => {
  const { a } = await prepare(mk, [answer('2026-11-13', CENTER, 10), answer('2026-11-14', CENTER, 12)]);
  await addVenue(a, '北街モール 中央広場');                               // 括弧の無い書き方で、手で登録してある
  const first = await until(venues, (xs) => xs.length === 1 && xs[0].name === '北街モール 中央広場');
  await importNow(a, SHEET_URL);
  eq(await candidates(a).count(), 0, '決めるまでは、作成できる候補にしない');
  const q = (await a.locator('[data-testid="import-blocked"]').innerText()).replace(/\s+/g, ' ');
  ok(q.includes('記号・空白だけが違う会場名「北街モール 中央広場」があります（会場マスタに登録済み）。同じ会場ですか？'), `確認の表示: ${q}`);
  await sleep(1000);
  eq([(await venues()).length, (await projects()).length], [1, 0], '確認の前は、何も増えていない');
  // 「別の会場」を選ぶ → 新しい会場として登録する候補になる（作成するまで、会場は増えない）
  await a.locator('[data-testid="import-venue-new"]').click();
  ok((await detail(a)).includes('会場マスタに新しく登録'), '「別の会場」を選んだあとの候補');
  await sleep(800);
  eq((await venues()).length, 1, '「別の会場」を選んだだけでは、会場は増えない');
  // 選び直す（読み込み直すと、選択は消える）。「同じ会場」→ その場で、別名が登録される。候補は、登録済みの会場のものになる
  await a.reload();
  await a.waitForFunction(() => !!window.__kkl);
  await a.evaluate((t) => { window.__kkl.sheetsToken = () => t; }, TOKEN);
  await a.waitForSelector('[data-testid="space"][data-space="shared"]');
  await importNow(a);
  await a.locator('[data-testid="import-venue-same"]').click();
  eq(await until(() => candidateNames(a), (xs) => xs.length === 1, 5000), ['北街モール 中央広場（11/13〜11/14）'], '「同じ会場」を選んだあとの候補（会場マスタの会場名で作る）');
  ok((await detail(a)).includes('登録済み') && !(await detail(a)).includes('会場マスタに新しく登録'), `候補の会場の表示: ${await detail(a)}`);
  const aliased = await until(venues, (xs) => (xs[0]?.reportNames ?? []).length === 1);
  eq([aliased.length, aliased[0].id, aliased[0].name, aliased[0].reportNames, (await projects()).length], [1, first[0].id, '北街モール 中央広場', [CENTER], 0], '会場マスタ（別名が足され、会場は増えない。案件は、まだ無い）');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq([(await venues()).length, docs[0].venueId, days(docs[0])], [1, first[0].id, [['2026-11-13', 10], ['2026-11-14', 12]]], '会場は増えず、実績が入る');
});

add('I15', '会場の選択欄: 選ぶ前の表示に登録件数が出る。名前の無い会場は「（名称未設定の会場）」と出る。欄から会場を追加でき、同じ名前があれば、増やさずにその会場を選ぶ', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();                                             // ログインしていない（この端末だけのデータ）
  await addVenue(a, CENTER);
  await tab(a, '会場');
  await a.getByRole('button', { name: '＋ 会場を追加' }).click();        // 名前を入れていない会場
  await list(a);
  await a.getByRole('button', { name: '＋ 新しい案件' }).click();
  const sel = a.locator('[data-testid="venue-select"]');
  eq(await sel.locator('option').allInnerTexts(), ['（選択してください：登録済み 2 件）', CENTER, '（名称未設定の会場）', '＋ 新しい会場を追加…'], '会場の選択肢');
  eq(await sel.locator('option:checked').innerText(), '（選択してください：登録済み 2 件）', '選ぶ前の表示');
  // 欄から、新しい会場を追加する
  await a.evaluate(() => { window.prompt = () => ' みなと市場 '; });
  await sel.selectOption({ label: '＋ 新しい会場を追加…' });
  eq(await until(() => sel.locator('option:checked').innerText(), (t) => t === 'みなと市場', 5000), 'みなと市場', '追加した会場が選ばれる');
  // 同じ名前（全角/半角・空白だけの違い）をもう一度入れても、会場は増えない
  await sel.selectOption({ label: CENTER });
  await a.evaluate(() => { window.prompt = () => 'みなと　市場'; });
  await sel.selectOption({ label: '＋ 新しい会場を追加…' });
  eq(await until(() => sel.locator('option:checked').innerText(), (t) => t === 'みなと市場', 5000), 'みなと市場', '登録済みの会場が選ばれる');
  eq((await sel.locator('option').allInnerTexts()).filter((t) => t.includes('みなと')).length, 1, '会場は増えていない');
  // 会場費の既定値がある会場から、欄で足した新しい会場に切り替えると、会場費も、新しい会場のもの（0 円）になる（前の会場の会場費が残らない）
  const fee = () => a.evaluate(() => JSON.parse(localStorage.getItem('kkl_workshop_v1')).projects[0].venueFeePerDay);
  await tab(a, '会場');
  await a.locator('[data-c="feePerDay"]').first().fill('5000');
  await a.locator('[data-c="feePerDay"]').first().press('Enter');
  await list(a);
  await a.locator('.grid__link, [data-testid="project-card"] .pcard__open').first().click();
  await sel.selectOption({ label: 'みなと市場' });
  await sel.selectOption({ label: CENTER });
  eq(await until(fee, (v) => v === 5000, 5000), 5000, '会場費の既定値がある会場を選んだあとの、案件の会場費（日額）');
  await a.evaluate(() => { window.prompt = () => 'あさひ広場'; });
  await sel.selectOption({ label: '＋ 新しい会場を追加…' });
  eq(await until(() => sel.locator('option:checked').innerText(), (t) => t === 'あさひ広場', 5000), 'あさひ広場', '欄で足した会場が選ばれる');
  eq(await until(fee, (v) => v === 0, 5000), 0, '欄で足した会場に切り替えたあとの、案件の会場費（日額）');
  // 会場が 1 件も無いとき
  const B = await mk('B');
  const b = await B.open();
  await b.getByRole('button', { name: '＋ 新しい案件' }).click();
  eq(await b.locator('[data-testid="venue-select"] option:checked').innerText(), '（会場が未登録です。下の「＋ 新しい会場を追加」から登録できます）', '会場が無いときの表示');
  // 会場タブ: 同じ名前の会場を登録すると、警告が出る
  await addVenue(a, '北街モール(中央広場)');
  ok((await a.locator('td.is-warn[title*="同じ名前"]').count()) >= 1, '会場タブの、重複の警告');
});

add('I16', 'この端末だけのデータでも使える: ログイン中に「この端末だけのデータ」を表示して取り込むと、案件と会場は端末の中だけに作られ、共有データには何も書かれない（置き場所が混ざらない）', async ({ device: mk }) => {
  const { a } = await prepare(mk, hikariRows());
  await space(a, 'local');
  await importNow(a, SHEET_URL);
  await createAll(a);
  eq(await projectRows(a), [`${HIKARI}（11/13〜11/14）`], 'この端末だけのデータの案件一覧');
  await openProject(a, `${HIKARI}（11/13〜11/14）`);
  eq((await jcos(a)).gross, gross(2, 129), '収支');
  await sleep(1500);
  eq([(await projects()).length, (await venues()).length], [0, 0], '共有データの案件と会場');
  const local = await a.evaluate(() => JSON.parse(localStorage.getItem('kkl_workshop_v1')));
  eq([local.projects.length, local.venues.map((v) => v.name)], [1, [HIKARI]], '端末の中の案件と会場');
  await space(a, 'shared');
  eq(await projectRows(a), [], '共有データの案件一覧（混ざっていない）');
  // 日報の場所も、置き場所ごとに覚える（この端末だけのデータで使った日報を、共有データで、黙って読まない）
  eq(await a.locator('[data-testid="import-url"]').count(), 1, '共有データでは、日報の場所は未設定のまま（URL の欄が出る）');
  // ログアウトすると、読んだ日報は捨てられる（次の人に、前のアカウントで読んだ候補を見せない）
  await signOut(a);
  await list(a);
  ok((await a.locator('[data-testid="import-login"]').innerText()).includes('Google でのログインが必要です'), 'ログアウト後の表示');
  eq(await a.locator('[data-testid="import-start"]').isDisabled(), true, 'ログアウト中は、押せない');
});

add('I17', 'iPhone 相当の幅でも操作できる: 取得 → 候補の確認 → 作成 → 案件を開く、まで、横にはみ出さず、押すところが小さすぎない', async ({ url }) => {
  const P = await phone(url);
  try {
    // 会場名の入る長いボタン（記号だけが違う会場名の確認）と、読み取れない回答の説明も、出る内容にする
    await fakeSheets(P, { rows: [...baseRows(), answer('2026-11-20', 'その他', 12, { other: 'ひかり広場 イベントコート' }), answer('2026-11-21', EAST, '8個')] });
    const p = await openPage(P);
    await signIn(p, 'a@example.com');
    // スマホの表示では、はみ出した中身に合わせて、ブラウザが「ページの幅」（innerWidth）のほうを広げることがある。端末の画面の幅と比べる
    const W = p.viewportSize().width;
    const overflow = () => p.evaluate((w) => Math.max(0, Math.max(document.documentElement.scrollWidth, window.innerWidth) - w), W);
    const start = p.locator('[data-testid="import-start"]');
    const box = await start.boundingBox();
    ok(box && box.height >= 36 && box.x >= 0 && box.x + box.width <= W, `「日報から案件を作成・更新」の大きさと位置: ${JSON.stringify(box)}`);
    await p.locator('[data-testid="import-url"]').fill(SHEET_URL);
    await start.tap();
    eq(await until(() => busy(p), (b) => b === '0', 10000), '0', '取得が終わること');
    await p.waitForSelector('[data-testid="import-create"]');
    eq([await candidates(p).count(), await p.locator('[data-testid="import-blocked"]').count()], [5, 2], '候補の数と、確認が必要なものの数');
    eq(await overflow(), 0, '候補を表示した画面が、横にはみ出していないこと');
    const wide = () => p.locator('[data-testid="import"] button:visible').evaluateAll((els, w) => els.map((e) => [e.textContent.trim().slice(0, 12), Math.round(e.getBoundingClientRect().right)]).filter(([, r]) => r > w), W);
    eq(await wide(), [], '画面の右にはみ出しているボタン（候補の画面）');
    const small = await p.locator('[data-testid="import"] button:visible').evaluateAll((els) => els.map((e) => [e.textContent.trim().slice(0, 12), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 32));
    eq(small, [], '小さすぎるボタン');
    const check = await p.locator('[data-testid="import-create"] input[type="checkbox"]').first().boundingBox();
    ok(check.width >= 22 && check.height >= 22, `チェック欄の大きさ: ${JSON.stringify(check)}`);
    // 1 件のチェックを外して、残りを作成する
    await p.locator('[data-testid="import-create"] input[type="checkbox"]').first().tap();
    ok((await p.locator('[data-testid="import-create-go"]').innerText()).includes('選んだ 4 件を作成'), '作成ボタンの表示');
    await p.locator('[data-testid="import-create-go"]').tap();
    await until(() => p.locator('[data-testid="project-card"]').count(), (n) => n === 4, 8000);
    eq([await p.locator('[data-testid="project-card"]').count(), await candidates(p).count()], [4, 1], '作成された案件（カード）と、残った候補');
    eq([await overflow(), await wide()], [0, []], '作成のあとの画面が、横にはみ出していないこと（確認のボタンを含む）');
    // 案件を開く: 会場が入っていて、試算に実績が出る
    await p.locator('[data-testid="project-card"] .pcard__open', { hasText: 'EVENT-冬を待つ花あそび' }).tap();
    await p.waitForSelector('[data-testid="report-bar"]');
    eq(await p.locator('[data-testid="venue-select"] option:checked').innerText(), HIKARI, '会場の欄（選ばれている）');
    eq(await overflow(), 0, '案件の画面が、横にはみ出していないこと');
    await p.locator('[data-testid="report-toggle"]').tap();
    await p.waitForSelector('[data-testid="report-detail"]');
    eq(await overflow(), 0, '日報の同期の詳細を開いた画面が、横にはみ出していないこと');
    await p.locator('.sheettabs button', { hasText: '試算' }).tap();
    eq(yenNum(await p.locator('[data-testid="jcos-gross"]').innerText()), gross(2, 129), '粗利');
    ok((await p.locator('[data-testid="jcos-day-2026-11-14"]').innerText()).replace(/\s+/g, ' ').includes('52 組・121 人'), '日別の表に、参加組数・参加人数が出ること');
    eq(P.errors, [], 'ブラウザのエラー');
    // 作った案件が、共有データに届いていること（届く前に端末を閉じると、次の項目の初期化のあとに書き込みが届くことがある）
    const docs = await serverProjects((xs) => xs.length === 4 && xs.every((x) => x.reportSync));
    eq(docs.length, 4, '共有データに届いた案件');
    await until(() => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length), (n) => n === 0, 10000);
  } finally {
    await P.close();
  }
});

add('I18', '検証用のビルド（VITE_TEAM_ID）: 共有データが使えない状態で、この端末だけのデータに取り込む。通常のチーム（本番相当）の場所は 1 回も読み書きせず、Firestore への書き込みの通信は 0 件', async ({ device: mk }) => {
  // 本番相当のデータ（通常のチームの下に、案件と会場がある）
  const { a } = await prepare(mk, hikariRows());
  await importNow(a, SHEET_URL);
  await createAll(a);
  await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  await until(() => a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length), (n) => n === 0, 10000);
  await sleep(800);
  const production = JSON.stringify([await projects(), await venues()]);
  const app = await startApp({ env: { VITE_TEAM_ID: OTHER } });
  try {
    const P = await mk('P', app.url);
    const log = [];
    P.ctx.on('request', (r) => log.push({ url: r.url(), method: r.method(), body: r.postData() ?? '' }));
    await fakeSheets(P, { rows: baseRows() });
    const p = await openPage(P);
    eq(await p.locator('[data-testid="env-team"]').getAttribute('data-team'), OTHER, '検証用のビルドの表示');
    await signIn(p, 'a@example.com', { expectPhase: 'unregistered' });
    await p.getByRole('button', { name: '「この端末だけのデータ」を表示する' }).click();
    await p.waitForSelector('[data-testid="space"][data-space="local"]');
    await importNow(p, SHEET_URL);
    eq(await candidates(p).count(), 5, '候補の数（本番相当のデータの案件・会場とは、照らさない）');
    await createAll(p);
    eq((await projectRows(p)).length, 5, 'この端末だけのデータに作られた案件');
    await importNow(p);
    await sleep(2500);
    const plain = (t) => { try { return decodeURIComponent(t.replace(/\+/g, ' ')); } catch { return t; } };
    const fs = log.filter((r) => new URL(r.url).port === '8085');
    const text = fs.map((r) => plain(`${r.url}\n${r.body}`)).join('\n');
    ok(fs.length > 0, 'Firestore への通信が、記録できていること');
    eq((text.match(new RegExp(`teams/${TEAM}`, 'g')) ?? []).length, 0, `通常のチーム名（${TEAM}）を含む通信の数`);
    ok(text.includes(`teams/${OTHER}`), '検証用のチーム名が、通信に出ていること');
    eq(fs.filter((r) => /\/Write\/channel|:commit|:batchWrite/.test(r.url)).length, 0, 'Firestore への書き込みの通信の数');
    eq([...new Set(log.filter((r) => r.url.includes('sheets.googleapis.com')).map((r) => r.method))].filter((m) => m !== 'OPTIONS'), ['GET'], '日報への通信の方法');
    eq(JSON.stringify([await projects(), await venues()]), production, '本番相当のデータ（1 件も変わっていないこと）');
    eq([(await admin.list(`teams/${OTHER}/wsProjects`)).length, (await admin.list(`teams/${OTHER}/wsVenues`)).length], [0, 0], '検証用のチームの下に書かれたドキュメント');
  } finally {
    app.stop();
  }
});

add('I19', '会場の書き方が日によって違うとき: 登録済みの別名なら、同じ会場の 1 つの開催になる（候補を分けない）。未登録の、記号だけが違う 2 つの書き方は、確認してから 1 つの会場として登録できる（2 つ登録しない）', async ({ device: mk }) => {
  const ALT = 'ひかり広場 イベントコート';
  const { a } = await prepare(mk, [answer('2026-11-13', HIKARI, 30), answer('2026-11-14', HIKARI, 99), answer('2026-11-15', 'その他', 12, { other: ALT })]);
  await importNow(a, SHEET_URL);
  eq(await candidateNames(a), [`${HIKARI}（11/13〜11/14）`], '回答の多い書き方は、そのまま候補になる');
  const q = (await a.locator('[data-testid="import-blocked"]').innerText()).replace(/\s+/g, ' ');
  ok(q.includes(`記号・空白だけが違う会場名「${HIKARI}」があります（この日報の中の、まだ登録していない書き方）。同じ会場ですか？`), `確認の表示: ${q}`);
  await a.locator('[data-testid="import-venue-same"]').click();
  // その場で、1 つの会場として登録される（少ない書き方は別名）。2 つの書き方の回答は、同じ会場の、連続した 1 つの開催になる
  const vs = await until(venues, (xs) => xs.length === 1);
  eq([vs[0].name, vs[0].reportNames], [HIKARI, [HIKARI, ALT]], '登録された会場');
  eq(await until(() => candidateNames(a), (xs) => xs.length === 1 && xs[0].includes('11/15'), 5000), [`${HIKARI}（11/13〜11/15）`], '1 つの開催の候補になる');
  eq(await a.locator('[data-testid="import-blocked"]').count(), 0, '確認が要るものは、無くなる');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq([days(docs[0]), docs[0].venueId, (await venues()).length], [[['2026-11-13', 30], ['2026-11-14', 99], ['2026-11-15', 12]], vs[0].id, 1], '作られた案件（3 日分）と、会場の数');
  await openProject(a, `${HIKARI}（11/13〜11/15）`);
  eq(await jcos(a), { billing: 120000, cost: 141 * 220, gross: gross(3, 141), actual: 141, basis: 'actual' }, '収支');
});

add('I20', '数日しか離れていない、同じ会場の 2 つの開催を、別々の案件として作る: 作った直後に「未反映」や「会期の外の回答」と表示されない。同じイベント名でも、案件名で見分けられる。先に 1 件だけ作ったときは、残りを作ったあとで、先の案件の記録も合わせ直される', async ({ device: mk }) => {
  const rows = [answer('2026-11-13', CENTER, 10, { event: 'EVENT-花あそび' }), answer('2026-11-14', CENTER, 12, { event: 'EVENT-花あそび' }),
    answer('2026-11-16', CENTER, 9, { event: 'EVENT-花あそび' }), answer('2026-11-17', CENTER, 8, { event: 'EVENT-花あそび' })];
  const { a } = await prepare(mk, rows);
  await importNow(a, SHEET_URL);
  eq(await candidateNames(a), ['EVENT-花あそび（11/13〜11/14）', 'EVENT-花あそび（11/16〜11/17）'], '同じイベント名の開催は、開催日を添えた名前になる');
  // 1 件目だけを作る（2 件目のチェックを外す）
  await candidates(a).nth(1).locator('input[type="checkbox"]').click();
  await createAll(a);
  const one = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq((one[0].reportSync.outside ?? []).map((o) => o.date), ['2026-11-16', '2026-11-17'], '1 件目だけのときは、残りの開催日が「会期のすぐ外の回答」として記録される');
  // 残りの開催は、いま作った案件のすぐ近くなので、そのまま候補にはしない（同じ開催か、別の開催かを、利用者が選ぶ）
  const near = (await until(() => a.locator('[data-testid="import-near"]').innerText().catch(() => ''), (t) => t.includes('すぐ近く'), 8000)).replace(/\s+/g, ' ');
  ok(near.includes('同じ会場の案件「EVENT-花あそび（11/13〜11/14）」') && near.includes('取り込んでいません'), `確認の表示: ${near}`);
  eq([await candidates(a).count(), (await status(a)).includes('新しい案件の候補 0 件'), (await status(a)).includes('確認が必要')], [0, true, true], '選ぶまでは、候補にしない');
  // 「別の開催」を選んで、残りを作る → 先の案件の記録が、合わせ直される（会期のすぐ外の回答は、もう無い）
  await a.locator('[data-testid="import-near-separate"]').click();
  eq(await candidateNames(a), ['EVENT-花あそび（11/16〜11/17）'], '「別の開催」を選んだあとの候補');
  await createAll(a);
  const two = await serverProjects((xs) => xs.length === 2 && xs.every((p) => p.reportSync && !(p.reportSync.outside?.length)));
  eq(two.map((p) => [p.name, p.startDate, p.endDate, days(p).length]).sort(), [['EVENT-花あそび（11/13〜11/14）', '2026-11-13', '2026-11-14', 2], ['EVENT-花あそび（11/16〜11/17）', '2026-11-16', '2026-11-17', 2]], '作られた 2 つの案件');
  eq(await until(() => updateStates(a), (xs) => xs.length === 2 && xs.every((x) => x === 'done'), 8000), ['done', 'done'], 'どちらの案件も、日報と同じ内容');
  eq([await a.locator('[data-testid="import-apply"]').count(), await a.locator('[data-testid="import-join"]').count(), await a.locator('[data-testid="import-outside"]').count()], [0, 0, 0], '「反映する」「同じ案件にする」「会期の外の回答」は、出ない');
  ok((await status(a)).includes('未反映・競合なし'), `表示: ${await status(a)}`);
  await openProject(a, 'EVENT-花あそび（11/13〜11/14）');
  ok((await a.locator('[data-testid="report-status"]').innerText()).includes('未反映・競合なし'), `案件の同期の表示: ${await a.locator('[data-testid="report-status"]').innerText()}`);
});

add('I21', '数日しか離れていない、同じ会場の 2 つの開催を、一度に作る: どちらの案件にも「会期のすぐ外の回答」は残らず、作った直後から「日報と同じ内容」になる（余計な書き込みをしない）', async ({ device: mk }) => {
  const { a } = await prepare(mk, [answer('2026-11-13', CENTER, 10), answer('2026-11-14', CENTER, 12), answer('2026-11-16', CENTER, 9), answer('2026-11-17', CENTER, 8)]);
  await importNow(a, SHEET_URL);
  eq((await candidateNames(a)).length, 2, '候補の数');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 2 && xs.every((p) => p.reportSync));
  eq(docs.map((p) => p.reportSync.outside ?? null), [null, null], '会期のすぐ外の回答の記録（どちらにも無い）');
  eq(await until(() => updateStates(a), (xs) => xs.length === 2, 8000), ['done', 'done'], 'どちらの案件も、日報と同じ内容');
  eq([await a.locator('[data-testid="import-apply"]').count(), await a.locator('[data-testid="import-join"]').count()], [0, 0], '「反映する」「同じ案件にする」は、出ない');
  ok((await status(a)).includes('既存の案件 2 件／作成 2 件／未反映・競合なし'), `表示: ${await status(a)}`);
  // 作ったあとで、書き直されない（同期した日時が、そのまま）
  await sleep(2000);
  eq((await projects()).map((p) => p.reportSync.at).sort(), docs.map((p) => p.reportSync.at).sort(), '同期した日時（変わっていないこと）');
});

add('I22', '開催予定として手で作った案件（計算方法は「汎用」のまま）にも、あとから日報の実績が入る: 会場と会期が合えば、新しい案件を作らずに、その案件に記録する。「JCOS案件」に切り替えると、実績個数で粗利が出る', async ({ device: mk }) => {
  const { a } = await prepare(mk, hikariRows());
  await addVenue(a, HIKARI);
  await manualProject(a, { name: '冬の開催（予定・汎用）', venue: HIKARI, start: '2026-11-13', end: '2026-11-14', jcos: false });
  eq(await a.locator('[data-testid="report-bar"]').count(), 0, '汎用の案件の画面には、「日報を同期」は出ない');
  await importNow(a, SHEET_URL);
  const docs = await serverProjects((xs) => !!xs[0]?.reportSync);
  eq([docs.length, days(docs[0]), docs[0].jcos ?? null, await candidates(a).count()], [1, [['2026-11-13', 30], ['2026-11-14', 99]], null, 0], '既存の案件に実績が記録される（計算方法は変えない・新しい候補は出ない）');
  ok((await a.locator('[data-testid="import-generic"]').innerText()).includes('収支には使いません'), '一覧の、案件の行の説明');
  // JCOS 案件に切り替えると、記録してある実績で計算される（同期し直さなくてよい）
  await openProject(a, '冬の開催（予定・汎用）');
  await a.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
  await a.waitForSelector('[data-testid="report-bar"]');
  eq(await jcos(a), { billing: 80000, cost: 129 * 220, gross: gross(2, 129), actual: 129, basis: 'actual' }, '切り替えたあとの収支');
  await list(a);
  eq(await a.locator('[data-testid="import-generic"]').count(), 0, '切り替えたあとは、説明は出ない');
});

add('I23', '手で作った予定の案件の、会期のすぐ前の日の回答: 新しい候補にはせず、「同じ開催（その案件の会期を広げて取り込む）／別の開催」を選ぶ。「同じ開催」なら、案件は増えず、その案件の会期が広がる', async ({ device: mk }) => {
  const { a } = await prepare(mk, [answer('2026-11-13', HIKARI, 30)]);
  await addVenue(a, HIKARI);
  await manualProject(a, { name: '冬の開催（予定）', venue: HIKARI, start: '2026-11-14', end: '2026-11-17' });
  await importNow(a, SHEET_URL);
  const near = (await a.locator('[data-testid="import-near"]').innerText()).replace(/\s+/g, ' ');
  ok(near.includes('同じ会場の案件「冬の開催（予定）」（会期 11/14(土)〜11/17(火)）の、会期のすぐ近くの開催です') && near.includes('取り込んでいません'), `確認の表示: ${near}`);
  eq([await candidates(a).count(), await a.locator('[data-testid="import-create-go"]').count()], [0, 0], '選ぶまでは、作成できる候補にしない');
  ok((await status(a)).includes('確認が必要 1 件') && !(await status(a)).includes('競合なし'), `表示: ${await status(a)}`);
  await sleep(1200);
  eq([(await projects()).length, (await projects())[0].reportSync ?? null], [1, null], '選ぶ前は、何も変わっていない');
  await a.locator('[data-testid="import-near-widen"]').click();
  const docs = await serverProjects((xs) => xs[0]?.startDate === '2026-11-13');
  eq([docs.length, docs[0].startDate, docs[0].endDate, days(docs[0]), docs[0].name, docs[0].reportPeriod ?? null], [1, '2026-11-13', '2026-11-17', [['2026-11-13', 30]], '冬の開催（予定）', null], '会期を広げた案件（案件は増えない・手で決めた会期の案件のまま）');
  eq(await until(() => a.locator('[data-testid="import-near"]').count(), (n) => n === 0, 5000), 0, '確認が要るものは、無くなる');
  ok((await status(a)).includes('未反映・競合なし'), `表示: ${await status(a)}`);
});

add('I24', '会期が隣り合う 2 つの案件: 連続した開催日が両方にまたがっても、日ごとに、それぞれの案件の実績になる（「決められない」にならない）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', HIKARI, 30)]);
  await addVenue(a, HIKARI);
  await manualProject(a, { name: '冬の開催（予定）', venue: HIKARI, start: '2026-11-14', end: '2026-11-17' });
  await importNow(a, SHEET_URL);
  // 前日の回答を、「別の開催」として、別の案件にする
  await a.locator('[data-testid="import-near-separate"]').click();
  eq(await candidateNames(a), [`${HIKARI}（11/13）`], '「別の開催」を選んだあとの候補');
  await createAll(a);
  await serverProjects((xs) => xs.length === 2 && xs.some((p) => p.reportSync));
  // 次の日から、予定の案件の会期の回答が入る。開催日は 11/13〜11/15 と連続しているが、日ごとに、それぞれの案件のもの
  sheets.rows = [...sheets.rows, answer('2026-11-14', HIKARI, 99), answer('2026-11-15', HIKARI, 41)];
  await importNow(a);
  const docs = await serverProjects((xs) => days(byName(xs, '冬の開催（予定）')).length === 2);
  eq([days(byName(docs, `${HIKARI}（11/13）`)), days(byName(docs, '冬の開催（予定）')), byName(docs, `${HIKARI}（11/13）`).endDate], [[['2026-11-13', 30]], [['2026-11-14', 99], ['2026-11-15', 41]], '2026-11-13'], 'それぞれの案件の実績（前日の案件は、予定の案件の会期へは伸びない）');
  eq([await a.locator('[data-testid="import-ambiguous"]').count(), await candidates(a).count(), await a.locator('[data-testid="import-near"]').count()], [0, 0, 0], '「決められない」・新しい候補・確認は、出ない');
  ok((await status(a)).includes('既存の案件 2 件（更新 1 件）') && (await status(a)).includes('未反映・競合なし'), `表示: ${await status(a)}`);
});

add('I25', '取得のあとで、案件の画面で同期した案件は、一覧に残っている古い内容では上書きしない（「この取得のあとに同期済み」と示す）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, hikariRows(99));
  await importNow(a, SHEET_URL);
  await createAll(a);
  await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  // 一覧で、もう一度取得する（99 個の内容を読んだ状態）。そのあとで、日報が 90 個に直され、案件の画面で同期した
  await importNow(a);
  await sleep(1100);                                                    // 同期の日時が、取得の日時より確実にあとになるように
  sheets.rows = hikariRows(90);
  await openProject(a, `${HIKARI}（11/13〜11/14）`);
  await a.locator('[data-testid="report-sync"]').click();
  await until(() => a.locator('[data-testid="report-bar"]').getAttribute('data-busy'), (b) => b === '0', 10000);
  const fresh = await serverProjects((xs) => days(xs[0]).join() === '2026-11-13,30,2026-11-14,90');
  // 一覧に戻ると、読んである内容（99 個）とは違うが、「未反映」とは出さず、反映もできない
  await list(a);
  eq(await updateStates(a), ['newer'], '既存の案件の行の状態');
  ok((await a.locator('[data-testid="import-newer"]').innerText()).includes('上書きしません'), '行の説明');
  eq(await a.locator('[data-testid="import-apply"]').count(), 0, '「反映する」は出ない');
  await sleep(1500);
  eq([days((await projects())[0]), (await projects())[0].reportSync.at], [[['2026-11-13', 30], ['2026-11-14', 90]], fresh[0].reportSync.at], '案件の実績（新しい同期のまま）');
  // もう一度取得すると、最新の日報で確かめた結果になる
  await importNow(a);
  eq(await until(() => updateStates(a), (xs) => xs.join() === 'done', 8000), ['done'], '取り直したあとの行の状態');
});

add('I26', '取り直しが失敗したら、前に読んだ内容（候補・チェックの付け外し）は残さない: 失敗として表示し、前の候補からは作成できない。読めたら、最新の内容で候補が出る', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', HIKARI, 30), answer('2026-11-20', EAST, 5)]);
  await importNow(a, SHEET_URL);
  eq((await candidateNames(a)).length, 2, '候補の数');
  await candidates(a).nth(1).locator('input[type="checkbox"]').click();          // 1 件のチェックを外す
  ok((await a.locator('[data-testid="import-create-go"]').innerText()).includes('選んだ 1 件を作成'), '作成ボタンの表示');
  sheets.fail = 'network';
  await importNow(a);
  eq([await candidates(a).count(), await a.locator('[data-testid="import-create-go"]').count()], [0, 0], '失敗のあとは、前の候補も、作成のボタンも出ない');
  ok((await a.locator('[data-testid="import-error"]').innerText()).includes('通信できない'), '失敗の表示');
  ok((await status(a)).includes('取得できませんでした') && !(await status(a)).includes('競合なし') && !(await status(a)).includes('新しい案件の候補'), `表示: ${await status(a)}`);
  await sleep(1000);
  eq([(await projects()).length, (await venues()).length], [0, 0], '何も作られていない');
  sheets.fail = null;
  await importNow(a);
  eq([await candidates(a).count(), await candidates(a).locator('input[type="checkbox"]:checked').count()], [2, 2], '読めたあとの候補（チェックは、付け直されている）');
});

add('I27', '一覧が画面に出ていないとき（ほかのタブ）にログアウトしても、読んだ日報は捨てられる（同じアカウントでログインし直しても、前の候補は出ない）', async ({ device: mk }) => {
  const { a } = await prepare(mk, hikariRows());
  await importNow(a, SHEET_URL);
  eq(await candidates(a).count(), 1, '候補の数');
  await tab(a, '会場');                                                  // 一覧は、画面から外れる
  await signOut(a);
  await signIn(a, 'a@example.com');
  await list(a);
  eq([await candidates(a).count(), await a.locator('[data-testid="import-detail"]').count()], [0, 0], 'ログインし直したあとの、候補と内容');
  ok((await status(a)).includes('前回の取得') && (await status(a)).includes('回答 2 件'), `表示（いつ・何件読んだかだけが残る）: ${await status(a)}`);
  // 別のアカウントには、前のアカウントが読んだときの記録も見せない
  await signOut(a);
  await signIn(a, 'b@example.com');
  await list(a);
  eq(await status(a), 'まだ取得していません', '別のアカウントでの表示');
});

add('I28', '取得から 10 分を過ぎた内容では、既存の案件の更新も、自動では始めない（取得の途中で一覧を離れ、時間がたってから戻った場合）', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, hikariRows(99));
  await importNow(a, SHEET_URL);
  await createAll(a);
  const first = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  // 日報が直された。取得を始めて、応答が返る前に、一覧を離れる
  sheets.rows = hikariRows(90);
  let release;
  sheets.hold = new Promise((r) => { release = r; });
  await a.locator('[data-testid="import-start"]').click();
  await until(() => busy(a), (b) => b === '1', 5000);
  await tab(a, '会場');
  release();
  await until(() => Promise.resolve(sheets.answered), (n) => n >= 2, 8000);
  await sleep(500);
  // 11 分たってから、一覧に戻る
  await a.evaluate(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 11 * 60 * 1000; });
  await list(a);
  ok((await a.locator('[data-testid="import-stale"]').innerText()).includes('取得から時間がたっています'), '古い内容であることの表示');
  eq(await updateStates(a), ['pending'], '既存の案件の行の状態（未反映のまま）');
  eq(await a.locator('[data-testid="import-apply"]').isDisabled(), true, '「反映する」は押せない');
  ok((await status(a)).includes('確認が必要 1 件（うち、未反映 1 件）'), `表示: ${await status(a)}`);
  await sleep(1500);
  eq([days((await projects())[0]), (await projects())[0].reportSync.at], [days(first[0]), first[0].reportSync.at], '案件の実績（変わっていないこと）');
  // 取り直すと、反映される
  await a.evaluate(() => { Date.now = window.__realNow; });
  await importNow(a);
  await serverProjects((xs) => days(xs[0]).join() === '2026-11-13,30,2026-11-14,90');
});

add('I29', '「同じ会場」と答えた会場に、その日を会期に含む案件があるとき: 新しい候補にはならず、その案件の実績として、そのまま反映される。直した日報で確かめた案件の、古い失敗の表示は消える', async ({ device: mk }) => {
  const { a, sheets } = await prepare(mk, [answer('2026-11-13', CENTER, 10), answer('2026-11-14', CENTER, 12)]);
  await addVenue(a, '北街モール 中央広場');                               // 括弧の無い書き方で登録してある会場と、その案件
  await manualProject(a, { name: '中央広場の開催', venue: '北街モール 中央広場', start: '2026-11-13', end: '2026-11-14' });
  await importNow(a, SHEET_URL);
  eq([await candidates(a).count(), await a.locator('[data-testid="import-blocked"]').count()], [0, 1], '答える前（会場の確認だけ）');
  await a.locator('[data-testid="import-venue-same"]').click();
  const docs = await serverProjects((xs) => !!xs[0]?.reportSync);
  eq([docs.length, days(docs[0]), (await venues()).length], [1, [['2026-11-13', 10], ['2026-11-14', 12]], 1], '既存の案件に実績が入る（案件も会場も増えない）');
  eq(await until(() => updateStates(a), (xs) => xs.join() === 'done', 8000), ['done'], '既存の案件の行の状態');
  ok((await status(a)).includes('既存の案件 1 件（更新 1 件）') && (await status(a)).includes('未反映・競合なし'), `表示: ${await status(a)}`);
  // 読み取れない回答が入ると、案件の同期は止まり、案件の画面にも失敗として出る（まとめは「未反映・競合なし」とは出さない）
  sheets.rows = [...sheets.rows, answer('2026-11-14', CENTER, '5個')];
  await importNow(a);
  eq(await until(() => updateStates(a), (xs) => xs.join() === 'failed', 8000), ['failed'], '読み取れない回答があるときの行の状態');
  await openProject(a, '中央広場の開催');
  ok((await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした'), '案件の画面の表示');
  const failed = await a.locator('[data-testid="report-status"]').innerText();
  ok(failed.includes('最後の同期は失敗') && !failed.includes('競合なし'), `案件の同期のまとめ: ${failed}`);
  // 日報から、その回答を消す（案件の内容は、前回のままで正しい）。取り直すと、案件の画面の失敗の表示も消える
  sheets.rows = sheets.rows.slice(0, 2);
  await importNow(a);
  eq(await until(() => updateStates(a), (xs) => xs.join() === 'done', 8000), ['done'], '直したあとの行の状態');
  await openProject(a, '中央広場の開催');
  const fixed = await a.locator('[data-testid="report-status"]').innerText();
  ok(!(await a.locator('[data-testid="report-toggle"]').innerText()).includes('同期できませんでした') && fixed.includes('未反映・競合なし'), `直したあとの、案件の画面の表示: ${fixed}`);
});

add('I30', '共有データが圏外の間は、読んだ内容での作成をしない（最新の案件の一覧を確認できないため）。戻ると、作成できる', async ({ device: mk }) => {
  const { A, a } = await prepare(mk, hikariRows());
  await importNow(a, SHEET_URL);
  eq(await candidates(a).count(), 1, '候補の数');
  await A.offline(true);
  ok((await a.waitForSelector('[data-testid="import-offline"]').then((el) => el.innerText())).includes('いまは作成・反映できません'), '圏外のときの表示');
  eq(await a.locator('[data-testid="import-create-go"]').isDisabled(), true, '圏外の間は、「作成」を押せない');
  await sleep(800);
  eq((await projects()).length, 0, '何も作られていない');
  await A.offline(false);
  eq(await until(() => a.locator('[data-testid="import-create-go"]').isDisabled(), (v) => v === false, 20000), false, '戻ると、「作成」を押せる');
  await createAll(a);
  const docs = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq(days(docs[0]), [['2026-11-13', 30], ['2026-11-14', 99]], '作られた案件の実績');
});

add('I31', '案件の回答が、日報から 1 件も無くなったとき: 前の実績を、黙って残さない（「未反映」として確認を求める）。自動では外さない。「前回の実績を外す」を押すと、実績が外れ、収支は予定に戻る', async ({ device: mk }) => {
  const minato = () => [answer('2026-09-11', 'その他', 39, { other: MINATO }), answer('2026-09-12', 'その他', 48, { other: MINATO })];
  const { a, sheets } = await prepare(mk, [...hikariRows(), ...minato()]);
  await importNow(a, SHEET_URL);
  await createAll(a);
  const name = `${HIKARI}（11/13〜11/14）`;
  await serverProjects((xs) => xs.length === 2 && xs.every((p) => p.reportSync));
  eq(await until(() => updateStates(a), (xs) => xs.length === 2 && xs.every((x) => x === 'done'), 8000), ['done', 'done'], '作成のあとの行の状態');
  // ひかり広場の回答を、日報からすべて消す（みなと市場は、そのまま）
  sheets.rows = minato();
  await importNow(a);
  const gone = a.locator('[data-testid="import-gone"]');
  await gone.waitFor();
  const text = (await gone.innerText()).replace(/\s+/g, ' ');
  ok(text.includes('2 日・キット 129 個') && text.includes('自動では外していません'), `確認の文: ${text}`);
  const rowOf = a.locator('[data-testid="import-update"]', { hasText: name });
  eq(await rowOf.getAttribute('data-state'), 'pending', '行の状態（未反映）');
  ok((await rowOf.innerText()).includes('この日報に、この案件の実績になる回答はありません'), `行の説明: ${(await rowOf.innerText()).replace(/\s+/g, ' ')}`);
  const st = await status(a);
  ok(st.includes('既存の案件 2 件') && st.includes('確認が必要 1 件（うち、未反映 1 件）') && !st.includes('未反映・競合なし'), `まとめ: ${st}`);
  eq(await candidates(a).count(), 0, '新しい候補は出ない');
  // 自動では外れない（少し待っても、案件の実績は、前のまま）
  await sleep(1200);
  eq(days(byName(await projects(), name)), [['2026-11-13', 30], ['2026-11-14', 99]], '自動では、実績を外さない');
  // 押すと、外れる
  await rowOf.locator('[data-testid="import-apply"]').click();
  const docs = await serverProjects((xs) => !!byName(xs, name)?.reportSync && days(byName(xs, name)).length === 0);
  eq([docs.length, days(byName(docs, `${MINATO}（9/11〜9/12）`))], [2, [['2026-09-11', 39], ['2026-09-12', 48]]], 'ほかの案件は、そのまま');
  eq(await until(() => rowOf.getAttribute('data-state'), (x) => x === 'done', 8000), 'done', '外したあとの行の状態');
  ok((await rowOf.innerText()).includes('日報の内容に更新しました'), '外したあとの行の表示');
  const after = await status(a);
  ok(after.includes('更新 1 件') && after.includes('未反映・競合なし'), `外したあとのまとめ: ${after}`);
  // 収支: 実績が無くなったので、予定（個数 0）に戻る
  await openProject(a, name);
  eq(await jcos(a), { billing: 80000, cost: 0, gross: 80000, actual: 0, basis: 'planned' }, '外したあとの収支');
  // もう一度取得しても、同じ（変更なし。確認も求めない）
  await importNow(a);
  eq(await until(() => updateStates(a), (xs) => xs.length === 2 && xs.every((x) => x === 'done'), 8000), ['done', 'done'], 'もう一度取得したあと');
  ok((await status(a)).includes('未反映・競合なし'), `もう一度取得したあとのまとめ: ${await status(a)}`);
});

add('I32', '日報から作った案件の収支: アルバイト代は、自動では計上しない（0 人）。配置した日・人数を入れると、その分だけ計上される。日報の内容ごとの個数が入り、内容ごとに材料原価を変えられる（取り直しても、配置と原価は残る）', async ({ device: mk }) => {
  const BOTTLE = 'フラワーボトル';
  const BAG = 'フラワーバッグ';
  const { a } = await prepare(mk, [
    answer('2026-11-13', HIKARI, 30, { content: BOTTLE }), answer('2026-11-13', HIKARI, 12, { content: BAG }), answer('2026-11-14', HIKARI, 99, { content: BOTTLE }),
  ]);
  await importNow(a, SHEET_URL);
  await createAll(a);
  const name = `${HIKARI}（11/13〜11/14）`;
  const made = await serverProjects((xs) => xs.length === 1 && !!xs[0].reportSync);
  eq([made[0].jcos.days, made[0].jcos.unitCosts ?? null], [{}, null], '作った案件の、日ごとの設定と、内容ごとの原価（どちらも空。アルバイトの人数を、推測で入れない）');
  eq(made[0].reportSync.days.map((d) => [d.date, d.count, d.contents]), [
    ['2026-11-13', 42, [{ label: BAG, count: 12 }, { label: BOTTLE, count: 30 }]], ['2026-11-14', 99, [{ label: BOTTLE, count: 99 }]],
  ], '日別の、内容ごとの個数');
  await openProject(a, name);
  eq(await jcos(a), { billing: 80000, cost: 141 * 220, gross: 80000 - 141 * 220, actual: 141, basis: 'actual' }, '作った直後の収支（アルバイト代 0 円・どの内容も標準 220 円）');
  ok((await a.locator('[data-testid="jcos-nostaff"]').innerText()).includes('どの日にも配置されていません'), 'アルバイトを配置していないことの表示');
  const contentRows = a.locator('[data-testid="jcos-content"]');
  const rowsText = () => contentRows.evaluateAll((els) => els.map((e) => [...e.querySelectorAll('td')].map((td) => (td.querySelector('input')?.value ?? td.innerText).replace(/\s+/g, ' ').trim())));
  eq(await rowsText(), [[BOTTLE, '実績 129', '', '¥28,380'], [BAG, '実績 12', '', '¥2,640']], '内容ごとの内訳（指定なし）');
  // バッグの原価を 350 円にして、11/13 にアルバイトを 1 人配置する
  await contentRows.nth(1).locator('input').fill('350');
  await a.locator('[data-testid="jcos-day-2026-11-13"]').getByRole('button', { name: /アルバイトを増やす/ }).click();
  const cost = 15000 + 129 * 220 + 12 * 350;
  eq(await jcos(a), { billing: 80000, cost, gross: 80000 - cost, actual: 141, basis: 'actual' }, '配置 1 人日・バッグ 350 円のあとの収支（請求は変わらない）');
  eq(await rowsText(), [[BOTTLE, '実績 129', '', '¥28,380'], [BAG, '実績 12', '350', '¥4,200']], '内容ごとの内訳（バッグだけ 350 円）');
  const saved = await serverProjects((xs) => xs[0]?.jcos?.days?.['2026-11-13']?.partTimers === 1 && !!xs[0].jcos.unitCosts);
  eq([saved[0].jcos.days, Object.values(saved[0].jcos.unitCosts)], [{ '2026-11-13': { partTimers: 1 } }, [350]], '保存された、配置と原価');
  // 取り直しても、配置と原価は残る（日報が同じなら「変更なし」。同期は、実績だけを置き換える）
  await importNow(a);
  eq(await until(() => updateStates(a), (xs) => xs.join() === 'done', 8000), ['done'], '取り直したあとの行の状態');
  const again = await projects();
  eq([again[0].jcos.days, Object.values(again[0].jcos.unitCosts)], [{ '2026-11-13': { partTimers: 1 } }, [350]], '取り直したあとの、配置と原価');
  await openProject(a, name);
  eq((await jcos(a)).cost, cost, '取り直したあとの実費');
});

await runFile('「日報から案件を作成・更新」の確認（Firebase エミュレータ ＋ 差し替えの日報）');
