// 共有（ログイン）での同期を、複数の端末に見立てたブラウザで確かめる。
// 起動は run.mjs から（エミュレータを立ち上げたうえで、このファイルを実行する）。
import {
  add, addStaff, admin, appFormat, closeBrowser, createProject, deleteProject, device, eq, kv, loadSample, names, notices, ok,
  openProject, projectRows, runAll, server, setStaffRate, signIn, sleep, space, staffNames, startApp, syncLabel, tab, until,
} from './lib.mjs';

/** 端末を開き直したあと、ログイン状態が戻って共有データが使えるようになるまで待つ */
async function reopened(d) {
  const page = await d.open();
  await page.waitForSelector('.auth-user');
  if ((await appFormat(page)) === 'v3') await page.waitForSelector('[data-testid="space"][data-space="shared"]');
  else await sleep(1500);
  return page;
}

// ── 1. 置き場所の分離（共有データに、試用データが混ざらない・上書きしない） ──────────
add('S11', 'ログイン中にサンプルを読み込んでも、共有データ（他の人の案件・スタッフ）は変わらない', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '本番の案件');
  await addStaff(a, '山田（本物）', 1300);
  await until(async () => { const s = await server(format); return s.staff.length === 1 && s.projects.length === 1; });
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await loadSample(b);
  await sleep(2500);
  const s = await server(format);
  eq([names(s.projects), names(s.staff)], [['本番の案件'], ['山田（本物）']], 'サーバーの共有データ');
  await space(a, 'shared');
  eq(await staffNames(a), ['山田（本物）'], 'A の画面のスタッフ');
});

add('S12', '未ログインでサンプルを試してからログインしても、共有の案件に混ざらず、共有のスタッフも上書きされない', async ({ device: mk, format }) => {
  const A = await mk('A'), C = await mk('C');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '本番の案件');
  await addStaff(a, '山田（本物）', 1300);
  await addStaff(a, '佐藤（本物）', 1250);
  await until(async () => (await server(format)).staff.length === 2);
  await sleep(1200);
  const c = await C.open();
  await loadSample(c);                        // C は未ログインのまま試す
  await sleep(600);
  await signIn(c, 'c@example.com');
  await sleep(3000);
  const s = await server(format);
  eq(names(s.projects), ['本番の案件'], 'サーバーの案件（サンプルが混ざっていないこと）');
  eq(names(s.staff), ['佐藤（本物）', '山田（本物）'], 'サーバーのスタッフ（サンプルで上書きされていないこと）');
  eq(C.dialogs.filter((m) => m.includes('置き換え')).length, 0, '共有データを置き換える確認が出ていないこと');
  eq((await staffNames(a)).sort(), ['佐藤（本物）', '山田（本物）'], 'A の画面のスタッフ');
  if (format === 'v3') {
    await space(c, 'local');                  // 試したデータは「この端末だけのデータ」に残っている
    ok((await projectRows(c)).includes('ikyu'), 'C の端末のサンプルが消えています');
  }
});

// ── 2. 削除（消したものが戻らない） ──────────────────────────────────
add('S21', '削除した案件は、そのとき閉じていた別の端末を開き直しても復活しない', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '残す案件');
  await createProject(a, '消す案件');
  await until(async () => (await server(format)).projects.length === 2);
  let b = await B.open();
  await signIn(b, 'b@example.com');
  eq((await until(() => projectRows(b), (r) => r.length === 2)).sort(), ['残す案件', '消す案件'], 'B の一覧');
  await b.close();                            // B の端末を閉じる
  await deleteProject(a, '消す案件');
  eq(names((await until(() => server(format), (s) => s.projects.length === 1)).projects), ['残す案件'], '削除直後のサーバー');
  b = await reopened(B);                      // B の端末を開き直す
  await sleep(3500);
  eq(names((await server(format)).projects), ['残す案件'], 'B を開き直した後のサーバー（復活していないこと）');
  eq(await projectRows(a), ['残す案件'], 'A の一覧');
  eq(await projectRows(b), ['残す案件'], 'B の一覧');
});

add('S22', '他の端末で削除された案件を圏外で編集していても、復活しない。編集内容は控えとして端末に残り、表示が出る', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '消される案件');
  await until(async () => (await server(format)).projects.length === 1);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(b, '消される案件');
  await B.offline(true);
  await kv(b, 'メモ').fill('B が圏外で書いたメモ');
  await sleep(1200);
  await deleteProject(a, '消される案件');
  await until(() => server(format), (s) => s.projects.length === 0);
  await B.offline(false);
  await sleep(4500);
  eq(names((await server(format)).projects), [], 'サーバーの案件（復活していないこと）');
  if (format === 'v3') {
    ok((await notices(b)).some((t) => t.includes('削除')), `削除された旨の表示がありません: ${JSON.stringify(await notices(b))}`);
    await space(b, 'local');
    ok((await projectRows(b)).some((n) => n.includes('消される案件') && n.includes('控え')), `控えが端末に残っていません: ${JSON.stringify(await projectRows(b))}`);
  }
});

// ── 3. 圏外・競合 ──────────────────────────────────────────────────
add('S31', '圏外で編集して戻ると、自分の変更は届き、その間に他の人が追加したスタッフも消えない', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await addStaff(a, '佐藤', 1100);
  await until(async () => (await server(format)).staff.length === 2);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => staffNames(b), (n) => n.length === 2);
  await B.offline(true);                      // B が圏外に
  await addStaff(a, '新人D', 1300);           // その間に A が 1 人追加
  await until(async () => (await server(format)).staff.length === 3);
  await setStaffRate(b, '山田', 1250);        // B は圏外のまま時給を直す
  await sleep(1200);
  await B.offline(false);                     // B が圏内に戻る
  const s = await until(() => server(format), (x) => x.staff.find((y) => y.name === '山田')?.hourlyRate === 1250, 9000);
  eq(names(s.staff), ['佐藤', '山田', '新人D'], 'サーバーのスタッフ（新人D が消えていないこと）');
  eq(s.staff.find((y) => y.name === '山田')?.hourlyRate, 1250, '山田の時給（B の変更が届いていること）');
  eq((await until(() => staffNames(b), (n) => n.length === 3)).sort(), ['佐藤', '山田', '新人D'], 'B の画面');
});

add('S33', '同じ案件の別々の項目を 2 人が同時に編集しても、両方の変更が残る', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '共同編集');
  await until(async () => (await server(format)).projects.length === 1);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(a, '共同編集');
  await openProject(b, '共同編集');
  await Promise.all([kv(a, 'メモ').fill('A が書いたメモ'), kv(b, '固定売上').fill('50000')]);
  await b.locator('h3').first().click();
  const p = await until(async () => (await server(format)).projects[0], (x) => x.memo === 'A が書いたメモ' && x.fixedRevenue === 50000, 7000);
  eq([p.memo, p.fixedRevenue], ['A が書いたメモ', 50000], 'サーバーの案件（両方の変更）');
  eq(await until(() => kv(a, '固定売上').inputValue(), (v) => v === '50000'), '50000', 'A の画面の固定売上');
  eq(await until(() => kv(b, 'メモ').inputValue(), (v) => v === 'A が書いたメモ'), 'A が書いたメモ', 'B の画面のメモ');
});

add('S34', '同じ案件の同じ項目を 2 人が同時に編集した場合は、後から保存されたほうが残り、どの端末も同じ内容になる', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '同時編集');
  await until(async () => (await server(format)).projects.length === 1);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(a, '同時編集');
  await openProject(b, '同時編集');
  await kv(a, 'メモ').fill('A の版');
  await sleep(250);
  await kv(b, 'メモ').fill('B の版');
  await a.locator('h3').first().click();
  await b.locator('h3').first().click();
  await sleep(5000);
  const memo = (await server(format)).projects[0].memo;
  ok(['A の版', 'B の版'].includes(memo), `サーバーのメモ: ${memo}`);
  eq([await kv(a, 'メモ').inputValue(), await kv(b, 'メモ').inputValue()], [memo, memo], '両方の画面がサーバーと同じ内容になっていること');
});

add('S35', '圏外で行った変更は、送る前に画面を閉じても失われず、次に開いたときに共有へ届く', async ({ device: mk, format }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await until(async () => (await server(format)).staff.length === 1);
  let b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => staffNames(b), (n) => n.length === 1);
  await B.offline(true);
  await setStaffRate(b, '山田', 1400);
  await sleep(1500);
  await b.close();                            // 圏外のまま画面を閉じる
  await B.offline(false);
  b = await reopened(B);
  eq((await until(() => server(format), (s) => s.staff[0]?.hourlyRate === 1400, 9000)).staff[0]?.hourlyRate, 1400, 'サーバーの時給');
});

add('S36', '入力した直後に再読み込みしても、共有データに保存される', async ({ device: mk, format }) => {
  const A = await mk('A');
  let a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '直前の入力');
  await until(async () => (await server(format)).projects.length === 1);
  await openProject(a, '直前の入力');
  await kv(a, 'メモ').fill('閉じる直前に書いたメモ');
  await a.close();                            // 待たずに閉じる
  a = await reopened(A);
  eq((await until(async () => (await server(format)).projects[0], (p) => p.memo === '閉じる直前に書いたメモ', 8000)).memo, '閉じる直前に書いたメモ', 'サーバーのメモ');
});

add('S37', '圏外になると「オフライン（未送信あり）」と表示され、戻ると「保存済み」になる', async ({ device: mk, format }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await until(async () => (await server(format)).staff.length === 1);
  await A.offline(true);
  await setStaffRate(a, '山田', 1500);
  ok((await until(() => syncLabel(a), (t) => t.includes('オフライン') && t.includes('未送信'))).includes('未送信'), `圏外での表示: ${await syncLabel(a)}`);
  await A.offline(false);
  ok((await until(() => syncLabel(a), (t) => t.includes('保存済み'), 9000)).includes('保存済み'), `圏内に戻った後の表示: ${await syncLabel(a)}`);
  eq((await server(format)).staff[0].hourlyRate, 1500, 'サーバーの時給');
}, { needs: 'v3' });

// ── 実行 ────────────────────────────────────────────────────────
const app = process.env.APP_URL ? { url: process.env.APP_URL, stop: () => {} } : await startApp();
let results = [];
try {
  const probe = await device(app.url, 'probe');
  const format = await appFormat(await probe.open());
  await probe.close();
  console.log(`対象: ${app.url}（共有データの形式: ${format === 'v3' ? 'Version 3' : 'V1・V2'}）\n`);
  results = await runAll({ url: app.url, format });
} finally {
  await closeBrowser();
  app.stop();
}
const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
console.log(`\n${results.length} 項目中 ${results.length - failed.length - skipped.length} 合格／${failed.length} 不合格${skipped.length ? `／${skipped.length} 対象外` : ''}${failed.length ? `（${failed.map((r) => r.id).join(', ')}）` : ''}`);
process.exit(failed.length ? 1 : 0);
