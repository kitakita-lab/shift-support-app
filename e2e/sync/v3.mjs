// Version 3 で追加した確認項目（承認時の追加条件 A〜D）。main.mjs（修正前後を比べる 10 項目）とは別に置く。
//   M … データ移行（バックアップ・照合・やり直し・途中失敗）            ＝ 条件 B
//   C … 古いアプリ（Version 2・旧シフトアプリ）との互換性                ＝ 条件 C
//   A … メンバー制の画面側（未登録・アカウントの切り替え・名簿・権限）    ＝ 条件 A（ルールそのものは rules.mjs）
//   D … 圏外・競合・書き込みが拒否されたときの表示                      ＝ 条件 D
// 起動は run.mjs から（エミュレータを立ち上げたうえで、このファイルを実行する）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEGACY_COLLS, ROOT, TEAM, V3_COLLS, add, addStaff, admin, cachedKeys, canon, createProject, deleteProject, eq, kv, legacyApp,
  loadSample, names, notices, ok, openProject, projectRows, rawAll, roster, runFile, same, seedLegacy, server, setStaffRate,
  sheet, shownSpace, signIn, signOut, signOutUi, sleep, space, staffNames, stopLegacyApp, syncLabel, tab, until, waitPhase, waitShared,
} from './lib.mjs';

const T = `teams/${TEAM}`;
const V3 = { needs: 'v3' };
const MEMBER_RULES = { needs: 'v3', rules: 'firestore.v3.rules' };
const COLLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/store/collections.json'), 'utf8'));

const strip = ({ order, rev, updatedBy, ...x }) => x;     // 管理用の項目を除いた中身
const byId = (xs) => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const phaseText = (page) => page.locator('[data-testid="shared-phase"]').innerText();
const hasTab = async (page, label) => (await page.locator('.app__tabs button', { hasText: label }).count()) > 0;
async function staffRate(page, name) {
  await tab(page, 'スタッフ');
  const i = (await page.locator('[data-c="name"]').evaluateAll((els) => els.map((e) => e.value))).indexOf(name);
  return i < 0 ? null : page.locator('[data-c="hourlyRate"]').nth(i).inputValue();
}
const row = (page, name) => page.locator('.grid tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first();
async function copyProject(page, name) {
  await tab(page, '案件');
  await row(page, name).locator('[data-testid="copy-project"]').click();
}
const partCount = async (page, id) => Number(await page.locator(`[data-testid="count-${id}"]`).innerText());
const countOf = (project, partTypeId) => project.layout.items.filter((i) => i.partTypeId === partTypeId).length;
/** 端末を開き直す（ログイン状態が戻り、共有データが使えるようになるまで待つ） */
async function reopen(d, timeout = 20000) {
  const page = await d.open();
  await page.waitForSelector('.auth-user');
  await waitShared(page, timeout);
  return page;
}
/** 以前の形式のデータがある状態から、管理者として移行を実行し、使える状態になるまで待つ。端末に保存されたバックアップを返す */
async function migrate(page) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('[data-testid="migrate"]').click()]);
  await waitShared(page, 40000);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}
const legacyCounts = (docs) => ({
  projects: docs.workshopProjects.length,
  ...Object.fromEntries(docs.workshopData.map((d) => [d.id, (d.body.items ?? []).length])),
});
// メンバー画面
async function openMembers(page) { await tab(page, 'メンバー'); await page.waitForSelector('[data-testid="members"] tbody tr'); }
async function addMember(page, email, role = 'member') {
  await page.locator('[data-testid="member-email"]').fill(email);
  await page.locator('[data-testid="member-role"]').selectOption(role);
  await page.locator('[data-testid="member-add"]').click();
}
const memberRows = (page) => page.locator('[data-testid="members"] tbody tr[data-email]').evaluateAll((trs) => trs.map((tr) => `${tr.dataset.email}=${tr.querySelector('select').value}`));
const membersError = async (page) => ((await page.locator('[data-testid="members-error"]').count()) ? page.locator('[data-testid="members-error"]').innerText() : '');

// ══ M. データ移行（条件 B） ═══════════════════════════════════════════
add('M11', '移行: 移行前バックアップを取り、新しい形式へ写し、件数と内容の照合が通って初めて使えるようになる。以前の形式のデータは変わらない', async ({ device: mk }) => {
  const legacy = await seedLegacy(mk);
  const before = await rawAll(LEGACY_COLLS);
  const n = legacyCounts(legacy);
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'owner@example.com', { expectPhase: 'needs-migration' });
  const panel = await phaseText(a);
  ok(panel.includes(`案件 ${n.projects} 件`) && panel.includes(`スタッフ ${n.staff} 件`), `移行前の件数の表示: ${panel.replace(/\s+/g, ' ')}`);
  eq(names((await server('v3')).projects), [], '移行するまで、新しい置き場所に案件が無いこと');
  eq(await shownSpace(a), 'none', '移行するまで、共有データは表示されないこと');
  const file = await migrate(a);

  // 1. 操作した端末に保存されたバックアップ（このアプリの「バックアップから復元」で読める形）
  eq([file.projects.length, file.staff.length, file.venues.length], [n.projects, n.staff, n.venues], '端末に保存されたバックアップの件数');
  // 2. 新しい形式の内容が、移行元と 1 件ずつ一致する（並び順も同じ）
  const s3 = await server('v3'), s2 = await server('legacy');
  for (const key of ['staff', 'venues', 'contents', 'partTypes', 'composites']) {
    eq(s3[key].length, n[key], `${key} の件数`);
    same(s3[key].map(strip), s2[key], `${key} の内容`);
  }
  same(byId(s3.projects.map(strip)), byId(s2.projects.map(strip)), '案件の内容');
  // 3. 以前の形式のデータは、1 件も変わっていない
  same(await rawAll(LEGACY_COLLS), before, '以前の形式のデータ（変わっていないこと）');
  // 4. 共有側の移行前バックアップ（以前の形式のドキュメントをそのまま写したもの）
  const backups = await admin.docs(`${T}/wsBackups`);
  eq(backups.length, 1 + legacy.workshopData.length + n.projects, 'バックアップの件数（目録 1 ＋ マスタの種類 ＋ 案件）');
  for (const d of legacy.workshopData) same(backups.find((b) => b.id.endsWith(`__data__${d.id}`))?.body.doc, d.body, `バックアップ（${d.id}）`);
  for (const d of legacy.workshopProjects) same(backups.find((b) => b.id.endsWith(`__project__${d.id}`))?.body.doc, d.body, `バックアップ（案件 ${d.id}）`);
  // 5. 「移行済み」の印と、件数表の記録
  const meta = await admin.get(`${T}/wsMeta/state`);
  eq([meta.status, meta.formatVersion, meta.source, meta.report.ok, meta.attempt], ['done', 1, 'legacy', true, 1], '形式の情報');
  ok(meta.report.rows.every((r) => r.match && r.source === r.target), `件数表の記録: ${JSON.stringify(meta.report.rows)}`);
  // 6. 画面に移行後のデータが出ている。データ画面に件数表が出ている
  eq((await projectRows(a)).sort(), names(s2.projects), 'A の案件一覧');
  eq((await staffNames(a)).sort(), names(s2.staff), 'A のスタッフ');
  await tab(a, 'データ');
  eq(await a.locator('[data-testid="migration-report"]').getAttribute('data-ok'), '1', 'データ画面の移行の記録');
  // 7. ほかの端末は、移行の案内なしでそのまま使える（再実行されない）
  const B = await mk('B');
  const b = await B.open();
  await signIn(b, 'b@example.com');
  eq((await until(() => projectRows(b), (r) => r.length === n.projects)).sort(), names(s2.projects), 'B の案件一覧');
  eq((await admin.get(`${T}/wsMeta/state`)).attempt, 1, '移行が再実行されていないこと');
}, V3);

add('M12', '移行の途中で書き込みが拒否されたら「移行済み」にならず、どの端末も移行先を使わない。やり直すと完了し、データもバックアップも重複しない', async ({ device: mk }) => {
  const legacy = await seedLegacy(mk);
  const before = await rawAll(LEGACY_COLLS);
  const n = legacyCounts(legacy);
  await admin.loadRules('e2e/sync/rules/deny-project-writes.rules');      // 案件の新しい置き場所にだけ書けない
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'owner@example.com', { expectPhase: 'needs-migration' });
  await a.locator('[data-testid="migrate"]').click();
  const err = await a.locator('[data-testid="shared-error"]').innerText({ timeout: 40000 });
  ok(err.includes('完了できませんでした') && err.includes('権限'), `失敗の表示: ${err}`);
  eq(await shownSpace(a), 'none', '失敗後も、共有データは表示されないこと');
  let meta = await admin.get(`${T}/wsMeta/state`);
  eq([meta.status, meta.attempt], ['failed', 1], '形式の情報（「移行済み」になっていないこと）');
  let s3 = await server('v3');
  eq([s3.staff.length, s3.projects.length], [n.staff, 0], '途中まで書かれた状態（スタッフは書かれ、案件は書かれていない）');
  same(await rawAll(LEGACY_COLLS), before, '以前の形式のデータ（失敗しても変わっていないこと）');
  // ほかの端末も、印が無いので移行先を使わない
  const B = await mk('B');
  const b = await B.open();
  await signIn(b, 'b@example.com', { expectPhase: 'needs-migration' });
  ok((await phaseText(b)).includes('完了していません'), `B の表示: ${(await phaseText(b)).replace(/\s+/g, ' ')}`);
  // 原因を取り除いて、やり直す
  await admin.loadRules('firestore.rules');
  ok((await a.locator('[data-testid="migrate"]').innerText()).includes('やり直す'), 'やり直しのボタン');
  await migrate(a);
  await waitShared(b, 20000);                                             // B は、完了すると自動で切り替わる
  s3 = await server('v3');
  eq([s3.staff.length, s3.venues.length, s3.contents.length, s3.partTypes.length, s3.composites.length, s3.projects.length],
    [n.staff, n.venues, n.contents, n.partTypes, n.composites, n.projects], '件数（やり直しても重複していないこと）');
  same(byId(s3.projects.map(strip)), byId((await server('legacy')).projects.map(strip)), '案件の内容');
  meta = await admin.get(`${T}/wsMeta/state`);
  eq([meta.status, meta.attempt, meta.report.ok], ['done', 2, true], '形式の情報（2 回目で完了）');
  eq((await admin.docs(`${T}/wsBackups`)).length, 1 + legacy.workshopData.length + n.projects, 'バックアップ（やり直しても増えないこと）');
  same(await rawAll(LEGACY_COLLS), before, '以前の形式のデータ');
  eq((await until(() => projectRows(b), (r) => r.length === n.projects)).length, n.projects, 'B の案件一覧');
}, V3);

add('M13', 'メンバー制のルールでは、移行できるのは管理者だけ。メンバーの画面は、管理者の移行が終わると自動で使えるようになる', async ({ device: mk }) => {
  const legacy = await seedLegacy(mk, 'firestore.v3.rules');
  const before = await rawAll(LEGACY_COLLS);
  await roster({ 'owner@example.com': 'owner', 'member@example.com': 'member' });
  const M = await mk('M');
  const m = await M.open();
  await signIn(m, 'member@example.com', { expectPhase: 'needs-migration' });
  eq(await m.locator('[data-testid="migrate"]').count(), 0, 'メンバーには、移行のボタンが出ないこと');
  ok((await phaseText(m)).includes('管理者'), 'メンバーへの案内');
  const O = await mk('O');
  const o = await O.open();
  await signIn(o, 'owner@example.com', { expectPhase: 'needs-migration' });
  await migrate(o);
  await waitShared(m, 20000);
  eq((await until(() => projectRows(m), (r) => r.length === legacy.workshopProjects.length)).length, legacy.workshopProjects.length, 'メンバーの案件一覧');
  same(await rawAll(LEGACY_COLLS), before, '以前の形式のデータ');
  eq((await admin.get(`${T}/wsMeta/state`)).status, 'done', '形式の情報');
}, MEMBER_RULES);

add('M14', '「移行せず、空の状態から始める」を選ぶと、以前の形式のデータには触れずに、空の共有データで始まる', async ({ device: mk }) => {
  await seedLegacy(mk);
  const before = await rawAll(LEGACY_COLLS);
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'owner@example.com', { expectPhase: 'needs-migration' });
  await a.locator('[data-testid="start-fresh"]').click();
  await waitShared(a);
  ok(A.dialogs.some((t) => t.includes('空の状態から')), '確認が出ること');
  const s3 = await server('v3');
  eq([s3.projects.length, s3.staff.length, s3.venues.length], [0, 0, 0], '共有データは空');
  ok(s3.partTypes.length >= 10 && s3.partTypes.every((p) => p.unitCost === 0), 'パーツは初期値');
  eq((await admin.get(`${T}/wsMeta/state`)).source, 'fresh-skip-legacy', '形式の情報');
  same(await rawAll(LEGACY_COLLS), before, '以前の形式のデータ（変わっていないこと）');
  eq((await admin.docs(`${T}/wsBackups`)).length, 0, 'バックアップは作られない（移行していないため）');
}, V3);

add('M15', '新しいチーム（データなし）: ログインしただけでは共有側に何も書き込まれない。管理者が「使い始める」を押すと用意され、待っていたメンバーの画面も切り替わる', async ({ device: mk }) => {
  await roster({ 'owner@example.com': 'owner', 'member@example.com': 'member' });
  const M = await mk('M');
  const m = await M.open();
  await signIn(m, 'member@example.com', { expectPhase: 'needs-init' });
  eq(await m.locator('[data-testid="init-shared"]').count(), 0, 'メンバーには「使い始める」のボタンが出ないこと');
  const O = await mk('O');
  const o = await O.open();
  await signIn(o, 'owner@example.com', { expectPhase: 'needs-init' });
  await sleep(1500);
  eq(Object.values(await rawAll(V3_COLLS)).flat().length, 0, '管理者がログインしただけでは、共有側に 1 件も書き込まれていないこと');
  await o.locator('[data-testid="init-shared"]').click();
  await waitShared(o);
  await waitShared(m, 20000);
  const meta = await admin.get(`${T}/wsMeta/state`);
  eq([meta.status, meta.source, meta.formatVersion], ['done', 'fresh', 1], '形式の情報');
  ok((await server('v3')).partTypes.length >= 10, 'パーツの初期値');
  await createProject(o, '管理者が作った案件');
  eq(await until(() => projectRows(m), (r) => r[0] === '管理者が作った案件'), ['管理者が作った案件'], 'メンバーの案件一覧');
}, MEMBER_RULES);

add('M16', '以前の形式のデータがあるチーム: ログインしただけでは、以前の形式にも新しい形式にも 1 件も書き込まれない（現在のルール）', async ({ device: mk }) => {
  await seedLegacy(mk);
  const before = await rawAll([...LEGACY_COLLS, ...V3_COLLS]);
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'someone@example.com', { expectPhase: 'needs-migration' });
  await tab(a, 'データ');
  await tab(a, '案件');
  await sleep(2500);
  same(await rawAll([...LEGACY_COLLS, ...V3_COLLS]), before, '共有側のデータ（変わっていないこと）');
  eq((await admin.docs(`${T}/members`)).length, 0, '名簿にも何も書かれていないこと');
}, V3);

// ══ C. 古いアプリとの互換性（条件 C） ═══════════════════════════════════
/**
 * Version 2 のアプリで、共有データを書き換える操作をひととおり行う。
 * 書き込みが拒否される状況（メンバー制のルール）では、Version 2 の画面は作ったばかりの案件を消すなど不安定になるので、
 * 個々の操作ができなくても先へ進む（確かめたいのは「何をしても、共有データが変わらないこと」）。
 */
async function useOldApp(mk, email) {
  const app = await legacyApp();
  const L = await mk('V2', app.url);
  const l = await L.open();
  l.setDefaultTimeout(4000);
  const done = [];
  const step = async (label, fn) => { try { await fn(); done.push(label); } catch { /* この操作はできなかった */ } };
  await step('未ログインでサンプル読込', () => loadSample(l));            // 古いデータを持った端末
  await signIn(l, email);                                                 // そのままログイン（V2 は、端末のデータを共有へ書き込む）
  await sleep(2500);
  await step('スタッフ追加', () => addStaff(l, 'V2 で追加したスタッフ', 999));
  await step('案件作成', () => createProject(l, 'V2 で作った案件'));
  await sleep(1800);
  await step('案件削除', () => deleteProject(l, 'V2 で作った案件'));
  await sleep(1500);
  await step('ログイン中のサンプル読込', () => loadSample(l));            // V2 では共有データを丸ごと置き換える操作
  await sleep(2500);
  L.errors.length = 0;                                                    // 古いアプリ自身のエラーは、この確認の対象外
  return done;
}
async function migratedTeam(mk, rules) {
  await seedLegacy(mk, rules);
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'owner@example.com', { expectPhase: 'needs-migration' });
  await migrate(a);
  await createProject(a, 'V3 で作った案件');
  await addStaff(a, 'V3 のスタッフ', 1500);
  await until(() => server('v3'), (s) => s.projects.some((p) => p.name === 'V3 で作った案件') && s.staff.some((x) => x.hourlyRate === 1500));
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  await sleep(800);
  return { A, a };
}

add('C11', '移行後に古いアプリ（Version 2）を使っても、新しい形式の共有データは 1 件も変わらない（現在のルール）', async ({ device: mk }) => {
  const { a } = await migratedTeam(mk, 'firestore.rules');
  const v3Before = await rawAll(V3_COLLS);
  const legacyBefore = await rawAll(LEGACY_COLLS);
  const rows = (await projectRows(a)).sort();
  const done = await useOldApp(mk, 'old@example.com');
  eq(done.length, 5, `Version 2 での操作がすべて行えたこと: ${done.join('、')}`);
  ok(canon(await rawAll(LEGACY_COLLS)) !== canon(legacyBefore), 'Version 2 の操作が、以前の形式の置き場所には届いていること（テストが空振りしていないことの確認）');
  same(await rawAll(V3_COLLS), v3Before, '新しい形式の共有データ（1 件も変わっていないこと）');
  eq((await projectRows(a)).sort(), rows, 'Version 3 の画面の案件一覧');
  ok((await staffNames(a)).includes('V3 のスタッフ') && !(await staffNames(a)).includes('V2 で追加したスタッフ'), 'Version 3 の画面のスタッフ');
}, V3);

add('C12', 'メンバー制のルールでは、古いアプリ（Version 2）からは、以前の形式の置き場所にも書けない（新しい形式も変わらない）', async ({ device: mk }) => {
  await roster({ 'owner@example.com': 'owner', 'old@example.com': 'member' });
  const { a } = await migratedTeam(mk, 'firestore.v3.rules');
  const v3Before = await rawAll(V3_COLLS);
  const legacyBefore = await rawAll(LEGACY_COLLS);
  const done = await useOldApp(mk, 'old@example.com');     // 名簿にあるメンバーが、古いアプリを使い続けていた場合
  ok(done.includes('未ログインでサンプル読込') && done.length >= 2, `Version 2 での操作: ${done.join('、')}`);
  same(await rawAll(LEGACY_COLLS), legacyBefore, '以前の形式のデータ（古いアプリからも変わらないこと）');
  same(await rawAll(V3_COLLS), v3Before, '新しい形式の共有データ（1 件も変わっていないこと）');
  ok((await staffNames(a)).includes('V3 のスタッフ'), 'Version 3 の画面');
}, MEMBER_RULES);

add('C13', '古いアプリ（Version 2・旧シフトアプリ）のコードは、新しい形式の置き場所の名前を参照していない', async () => {
  const pattern = [...COLLS.app, COLLS.meta, COLLS.backups].join('|');
  const grep = (ref, dir) => spawnSync('git', ['grep', '-l', '-E', pattern, ref, '--', dir], { cwd: ROOT, encoding: 'utf8' });
  const v2 = grep('9daa441199ff493bc3cd048b074c24c02bb9e777', 'src');
  ok(v2.status === 1, `Version 2 のコードに参照があります: ${v2.stdout || v2.stderr}`);
  const arch = spawnSync('grep', ['-rlE', pattern, 'archive'], { cwd: ROOT, encoding: 'utf8' });
  ok(arch.status === 1, `旧シフトアプリ（archive）のコードに参照があります: ${arch.stdout}`);
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/main'], { cwd: ROOT }).status === 0) {
    const main = grep('origin/main', 'src');
    ok(main.status === 1, `本番公開中の旧シフトアプリ（main）のコードに参照があります: ${main.stdout}`);
  }
}, V3);

// ══ A. メンバー制の画面側（条件 A） ════════════════════════════════════
async function teamWithData(mk) {
  await roster({ 'owner@example.com': 'owner', 'member@example.com': 'member', 'member2@example.com': 'member' });
  const O = await mk('O');
  const o = await O.open();
  await signIn(o, 'owner@example.com');
  await createProject(o, '共有の案件');
  await addStaff(o, '山田', 1200);
  await until(() => server('v3'), (s) => s.projects.length === 1 && s.staff[0]?.hourlyRate === 1200);
  return { O, o };
}
const SHARED_KEYS = /wsStaff|wsVenues|wsContents|wsPartTypes|wsComposites|wsProjects|wsBackups/;

add('A11', '名簿に無いアカウント・メール未確認のアカウントでログインすると「登録されていません」と表示され、共有データは読み込まれない', async ({ device: mk }) => {
  await teamWithData(mk);
  const before = await rawAll(V3_COLLS);
  const X = await mk('X');
  const x = await X.open();
  await signIn(x, 'stranger@example.com', { expectPhase: 'unregistered' });
  const text = await phaseText(x);
  ok(text.includes('stranger@example.com') && text.includes('登録されていません'), `未登録の表示: ${text.replace(/\s+/g, ' ')}`);
  eq(await shownSpace(x), 'none', '共有データが表示されていないこと');
  eq(await x.locator('.grid').count(), 0, '一覧が出ていないこと');
  eq(await hasTab(x, 'メンバー'), false, 'メンバー画面が出ないこと');
  ok(!SHARED_KEYS.test(await cachedKeys(x)), '端末内に共有データの控えが無いこと');
  // 「この端末だけのデータ」は使える。そこで何をしても共有データは変わらない
  await x.getByRole('button', { name: '「この端末だけのデータ」を表示する' }).click();
  eq(await shownSpace(x), 'local', 'この端末だけのデータに切り替わること');
  await loadSample(x);
  await createProject(x, '未登録の人の案件');
  await sleep(2000);
  same(await rawAll(V3_COLLS), before, '共有データ（変わっていないこと）');
  // 名簿にあっても、メールアドレスが未確認のアカウントは通さない
  await admin.set(`${T}/members/unverified@example.com`, { role: 'member', addedAt: 1, addedBy: 'test' });
  const U = await mk('U');
  const u = await U.open();
  await signIn(u, 'unverified@example.com', { verified: false, expectPhase: 'unregistered' });
  eq(await shownSpace(u), 'none', 'メール未確認のアカウントにも表示されないこと');
}, MEMBER_RULES);

add('A12', '同じ端末でアカウントを切り替えると、前のアカウントの共有データは、画面にも端末内の控えにも残らない', async ({ device: mk }) => {
  await teamWithData(mk);
  const D = await mk('D');
  const d = await D.open();
  await signIn(d, 'member@example.com');
  eq(await until(() => projectRows(d), (r) => r.length === 1), ['共有の案件'], 'メンバーの画面');
  ok(SHARED_KEYS.test(await until(() => cachedKeys(d), (k) => SHARED_KEYS.test(k))), 'ログイン中は、端末内に控えがあること（テストが空振りしていないことの確認）');
  await signOutUi(d);
  await d.waitForSelector('.auth-user', { state: 'detached' });
  eq(await shownSpace(d), 'local', 'ログアウト後は「この端末だけのデータ」');
  eq(await projectRows(d), [], 'ログアウト後の案件一覧（共有の案件が残っていないこと）');
  ok(!SHARED_KEYS.test(await until(() => cachedKeys(d), (k) => !SHARED_KEYS.test(k))), 'ログアウト後、端末内に共有データの控えが残っていないこと');
  await signIn(d, 'stranger@example.com', { expectPhase: 'unregistered' });
  eq(await d.locator('.grid').count(), 0, '未登録のアカウントに、前の人のデータが見えないこと');
  ok(!SHARED_KEYS.test(await cachedKeys(d)), '未登録のアカウントでログインした後も、控えが無いこと');
  await signOut(d);
  await signIn(d, 'member2@example.com');     // 別のメンバーに切り替えても、正しく読み直される
  eq(await until(() => projectRows(d), (r) => r.length === 1), ['共有の案件'], '別のメンバーの画面');
  eq(D.errors, [], 'ブラウザのエラーが無いこと');
}, MEMBER_RULES);

add('A13', '未送信の変更は、ログアウト時に確認が出て破棄され、別のアカウントの名前で送られることはない', async ({ device: mk }) => {
  await teamWithData(mk);
  const D = await mk('D');
  const d = await D.open();
  await signIn(d, 'member@example.com');
  await until(() => staffNames(d), (n) => n[0] === '山田');
  const writer = (await server('v3')).staff[0].updatedBy.uid;             // 最後に書いた人（管理者）
  await D.offline(true);
  await setStaffRate(d, '山田', 1999);
  await until(() => syncLabel(d), (t) => t.includes('未送信'));
  D.accept = false;                           // 確認で「キャンセル」→ ログアウトしない
  await signOutUi(d);
  await sleep(800);
  ok(D.dialogs.some((t) => t.includes('送れていない変更が 1 件')), `未送信の確認: ${JSON.stringify(D.dialogs)}`);
  eq(await d.locator('.auth-user').count(), 1, 'キャンセルするとログアウトしないこと');
  D.accept = true;                            // 「OK」→ 破棄してログアウト
  await signOutUi(d);
  await d.waitForSelector('.auth-user', { state: 'detached' });
  await sleep(500);
  await D.offline(false);
  await signIn(d, 'member2@example.com');
  await sleep(4000);
  const s = (await server('v3')).staff[0];
  eq([s.hourlyRate, s.updatedBy.uid], [1200, writer], 'サーバーのスタッフ（前の人の未送信の変更が、別の人の名前で送られていないこと）');
  await signOut(d);
  await signIn(d, 'member@example.com');      // 元の人が入り直しても、破棄した変更は送られない
  await sleep(3000);
  eq((await server('v3')).staff[0].hourlyRate, 1200, 'サーバーの時給（破棄した変更が、あとから送られないこと）');
}, MEMBER_RULES);

add('A14', '名簿から外されたメンバーは、開いたままの画面からも書けなくなり、その旨が表示される', async ({ device: mk }) => {
  const { o } = await teamWithData(mk);
  const L = await mk('L');
  const l = await L.open();
  await signIn(l, 'member@example.com');
  await until(() => staffNames(l), (n) => n[0] === '山田');
  await openMembers(o);
  await o.locator('[data-testid="members"] tr[data-email="member@example.com"] button').click();
  await until(() => admin.get(`${T}/members/member@example.com`), (m) => m === null);
  ok((await memberRows(o)).every((r) => !r.startsWith('member@example.com')), '名簿の画面から消えること');
  await setStaffRate(l, '山田', 1888);        // 外された人が、開いたままの画面で編集する
  await waitPhase(l, 'unregistered', 20000);
  ok((await notices(l)).some((t) => t.includes('権限')), `権限が無い旨の表示: ${JSON.stringify(await notices(l))}`);
  eq((await server('v3')).staff[0].hourlyRate, 1200, 'サーバーの時給（変わっていないこと）');
  ok(!SHARED_KEYS.test(await until(() => cachedKeys(l), (k) => !SHARED_KEYS.test(k))), '外された人の端末に、共有データの控えが残らないこと');
}, MEMBER_RULES);

add('A15', 'メンバー画面: 名簿を変更できるのは管理者だけ。メールアドレスは小文字で登録され、大文字まじりでログインしても通る。最後の管理者は外せない', async ({ device: mk }) => {
  await roster({ 'owner@example.com': 'owner' });
  const O = await mk('O');
  const o = await O.open();
  await signIn(o, 'owner@example.com');
  await openMembers(o);
  eq(await o.locator('[data-testid="rules-state"]').getAttribute('data-enforced'), '1', 'メンバー制の表示（適用中）');
  await addMember(o, '  New.Member@Example.COM ');
  await until(() => memberRows(o), (r) => r.length === 2);
  eq(await memberRows(o), ['owner@example.com=owner', 'new.member@example.com=member'], '名簿（小文字で登録されること）');
  eq((await admin.get(`${T}/members/new.member@example.com`))?.role, 'member', 'サーバーの名簿（小文字の名前）');
  eq(await admin.get(`${T}/members/New.Member@Example.COM`), null, '大文字まじりの名前では登録されていないこと');
  await addMember(o, 'メールではない文字');
  ok((await until(() => membersError(o), (t) => !!t)).includes('形式'), '形式が正しくないメールアドレスは登録できないこと');
  // 最後の管理者は、外すことも、メンバーに下げることもできない
  await o.locator('[data-testid="members"] tr[data-email="owner@example.com"] button').click();
  ok((await until(() => membersError(o), (t) => t.includes('管理者'))).includes('1 人もいなくなる'), '最後の管理者は外せないこと');
  await o.locator('[data-testid="members"] tr[data-email="owner@example.com"] select').selectOption('member');
  ok((await until(() => membersError(o), (t) => t.includes('管理者'))).includes('1 人もいなくなる'), '最後の管理者はメンバーに下げられないこと');
  eq((await admin.get(`${T}/members/owner@example.com`))?.role, 'owner', 'サーバーの名簿（管理者のまま）');
  // 登録された人は、大文字まじりのメールアドレスでログインしても使える。メンバーには名簿の画面が出ない
  const N = await mk('N');
  let n = await N.open();
  await signIn(n, 'New.Member@Example.COM');
  eq(await hasTab(n, 'メンバー'), false, 'メンバーには、メンバー画面が出ないこと');
  await createProject(n, '新メンバーの案件');
  eq(await until(() => projectRows(o), (r) => r[0] === '新メンバーの案件'), ['新メンバーの案件'], '管理者の画面に届くこと');
  // 管理者に上げると、名簿を扱えるようになる
  await openMembers(o);
  await o.locator('[data-testid="members"] tr[data-email="new.member@example.com"] select').selectOption('owner');
  await until(() => admin.get(`${T}/members/new.member@example.com`), (m) => m?.role === 'owner');
  await n.close();
  n = await reopen(N);
  eq(await until(() => hasTab(n, 'メンバー')), true, '管理者に上げると、メンバー画面が出ること');
}, MEMBER_RULES);

add('A16', '現在のルール（メンバー制 未適用）では、その旨が表示され、名簿を先に準備できる。ルールを切り替えると、名簿の人だけが使える', async ({ device: mk }) => {
  const A = await mk('A');
  let a = await A.open();
  await signIn(a, 'admin@example.com');
  ok((await a.locator('[data-testid="space"]').innerText()).includes('未適用'), '画面上部に「メンバー制 未適用」と出ること');
  await createProject(a, '切り替え前の案件');
  await openMembers(a);
  eq(await a.locator('[data-testid="rules-state"]').getAttribute('data-enforced'), '0', 'メンバー画面の表示（未適用）');
  await a.locator('[data-testid="member-self-owner"]').click();
  await until(() => memberRows(a), (r) => r.length === 1);
  eq(await memberRows(a), ['admin@example.com=owner'], '自分を最初の管理者として登録');
  await addMember(a, 'member@example.com');
  await until(() => memberRows(a), (r) => r.length === 2);
  await until(() => server('v3'), (s) => s.projects.length === 1);
  // ここでルールを切り替える（実環境では、Firebase へのルールのデプロイにあたる）
  await admin.loadRules('firestore.v3.rules');
  await a.close();
  a = await reopen(A);
  // 閉じる直前の入力（案件名）が送信前だった場合は、開き直したあとに送り直される。内容がそろうまで待つ
  eq(await until(() => projectRows(a), (r) => r[0] === '切り替え前の案件', 10000), ['切り替え前の案件'], '管理者は、切り替え後もそのまま使える');
  ok(!(await a.locator('[data-testid="space"]').innerText()).includes('未適用'), '「未適用」の表示が消えること');
  const M = await mk('M');
  const m = await M.open();
  await signIn(m, 'member@example.com');
  eq(await until(() => projectRows(m), (r) => r.length === 1), ['切り替え前の案件'], '名簿にあるメンバーは使える');
  const X = await mk('X');
  const x = await X.open();
  await signIn(x, 'stranger@example.com', { expectPhase: 'unregistered' });
}, V3);

// ══ D. 圏外・競合・書き込みが拒否されたときの表示（条件 D） ════════════════════
add('D11', 'サーバーにつながらない状態で開き直しても、最後に受信した共有データが見え、未送信の変更は残って、つながると送られる', async ({ device: mk }) => {
  const A = await mk('A');
  let a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await createProject(a, '圏外の確認');
  await until(() => server('v3'), (s) => s.staff[0]?.hourlyRate === 1200 && s.projects.length === 1);
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  await A.block(true);                        // ここから、Firestore との通信がすべて失敗する
  await a.close();
  a = await reopen(A, 40000);                 // つながらないまま開く → 前回の確認結果と、端末内の控えで表示される
  eq(await projectRows(a), ['圏外の確認'], 'つながらない状態での案件一覧');
  await setStaffRate(a, '山田', 1300);
  await sleep(1500);
  eq((await server('v3')).staff[0].hourlyRate, 1200, 'サーバーの時給（まだ届いていないこと）');
  ok((await until(() => syncLabel(a), (t) => t.includes('未送信'), 15000)).includes('未送信'), `未送信の表示: ${await syncLabel(a)}`);
  await a.close();
  a = await reopen(A, 40000);                 // もう一度開き直しても、未送信の変更が残っている
  eq(await staffRate(a, '山田'), '1300', '開き直した後の画面の時給（未送信の変更が残っていること）');
  eq((await server('v3')).staff[0].hourlyRate, 1200, 'サーバーの時給（まだ届いていないこと）');
  await A.block(false);
  eq((await until(() => server('v3'), (s) => s.staff[0].hourlyRate === 1300, 90000)).staff[0].hourlyRate, 1300, 'つながった後のサーバーの時給');
  ok((await until(() => syncLabel(a), (t) => t.includes('保存済み'), 20000)).includes('保存済み'), `つながった後の表示: ${await syncLabel(a)}`);
}, V3);

add('D12', '書き込みが権限不足で拒否されたときは、表示が出て、画面は共有の内容に戻る。案件の変更は控えとして端末に残る', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await createProject(a, '権限の確認');
  await until(() => server('v3'), (s) => s.staff[0]?.hourlyRate === 1200 && s.projects.length === 1);
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  await admin.loadRules('e2e/sync/rules/deny-app-writes.rules');          // スタッフと案件に書けなくなる
  await setStaffRate(a, '山田', 1700);
  const n1 = await until(() => notices(a), (xs) => xs.some((t) => t.includes('権限')), 12000);
  ok(n1.some((t) => t.includes('スタッフ「山田」') && t.includes('権限')), `スタッフの変更が拒否された表示: ${JSON.stringify(n1)}`);
  await waitShared(a);
  eq(await until(() => staffRate(a, '山田'), (v) => v === '1200'), '1200', '画面の時給（共有の内容に戻ること）');
  eq((await server('v3')).staff[0].hourlyRate, 1200, 'サーバーの時給');
  await openProject(a, '権限の確認');
  await kv(a, 'メモ').fill('拒否されるメモ');
  const n2 = await until(() => notices(a), (xs) => xs.some((t) => t.includes('案件「権限の確認」') && t.includes('控え')), 12000);
  ok(n2.some((t) => t.includes('権限') && t.includes('権限の確認（控え）')), `案件の変更が拒否された表示: ${JSON.stringify(n2)}`);
  eq((await server('v3')).projects[0].memo, '', 'サーバーの案件（変わっていないこと）');
  await waitShared(a);
  await space(a, 'local');
  ok((await projectRows(a)).includes('権限の確認（控え）'), `端末に残った控え: ${JSON.stringify(await projectRows(a))}`);
  await openProject(a, '権限の確認（控え）');
  eq(await kv(a, 'メモ').inputValue(), '拒否されるメモ', '控えの内容（編集していた内容が残っていること）');
}, V3);

add('D13', '書き込みがその他の理由（1 件あたりの大きさの上限超え）で失敗したときも、表示が出て、控えが残る', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '大きすぎる案件');
  await until(() => server('v3'), (s) => s.projects.length === 1);
  await openProject(a, '大きすぎる案件');
  const big = 'あ'.repeat(400000);            // 1 件 1 MB の上限を超える（日本語は 1 文字 3 バイト）
  await kv(a, 'メモ').fill(big);
  const ns = await until(() => notices(a), (xs) => xs.some((t) => t.includes('保存できませんでした')), 20000);
  ok(ns.some((t) => t.includes('案件「大きすぎる案件」') && t.includes('保存できませんでした') && t.includes('控え')), `失敗の表示: ${JSON.stringify(ns.map((t) => t.slice(0, 120)))}`);
  eq((await server('v3')).projects[0].memo, '', 'サーバーの案件（変わっていないこと）');
  await space(a, 'local');
  ok((await projectRows(a)).includes('大きすぎる案件（控え）'), '端末に残った控え');
}, V3);

/** サンプルの案件「ikyu」（スタッフ配置・レイアウト入り）を共有データへコピーして、2 台で開く */
async function sharedSampleProject(mk) {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await loadSample(a);
  await copyProject(a, 'ikyu');
  await until(() => server('v3'), (s) => s.projects.length === 1 && s.staff.length === 3);
  await space(a, 'shared');
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(a, 'ikyu');
  await openProject(b, 'ikyu');
  return { A, B, a, b, p0: (await server('v3')).projects[0] };
}

add('D14', '同じ案件で、一方がスタッフ配置、他方がレイアウトを同時に編集しても、両方の変更が残る', async ({ device: mk }) => {
  const { a, b, p0 } = await sharedSampleProject(mk);
  await sheet(a, 'スタッフ配置');
  await sheet(b, 'レイアウト');
  await Promise.all([
    a.locator('.matrix__cell:not(.is-on) button').first().click(),
    b.getByRole('button', { name: '椅子（制作席）を増やす' }).click(),
  ]);
  const p = await until(async () => (await server('v3')).projects[0], (x) => x.assignments.length === p0.assignments.length + 1 && countOf(x, 'pt-chair') === countOf(p0, 'pt-chair') + 1, 8000);
  eq([p.assignments.length, countOf(p, 'pt-chair')], [p0.assignments.length + 1, countOf(p0, 'pt-chair') + 1], 'サーバーの案件（配置 ＋1 と 椅子 ＋1 の両方）');
  await sheet(a, 'レイアウト');
  eq(await until(() => partCount(a, 'pt-chair'), (n) => n === countOf(p, 'pt-chair')), countOf(p, 'pt-chair'), 'A の画面の椅子の数');
  await sheet(b, 'スタッフ配置');
  eq(await until(() => b.locator('.matrix__cell.is-on').count(), (n) => n === p.assignments.length), p.assignments.length, 'B の画面の配置の数');
}, V3);

add('D15', '後勝ちの限界: 同じ案件のレイアウトを 2 人が同時に編集すると、後から保存されたほうの図になり、先の人の変更は残らない（どの端末も同じ図になる）', async ({ device: mk }) => {
  const { a, b, p0 } = await sharedSampleProject(mk);
  await sheet(a, 'レイアウト');
  await sheet(b, 'レイアウト');
  await Promise.all([
    a.getByRole('button', { name: '椅子（制作席）を増やす' }).click(),
    b.getByRole('button', { name: 'バナースタンドを増やす' }).click(),
  ]);
  await sleep(5000);
  const p = (await server('v3')).projects[0];
  const dChair = countOf(p, 'pt-chair') - countOf(p0, 'pt-chair'), dBanner = countOf(p, 'pt-banner') - countOf(p0, 'pt-banner');
  eq(dChair + dBanner, 1, `残った変更は片方だけ（椅子 ${dChair}／バナー ${dBanner}）`);
  eq([await partCount(a, 'pt-chair'), await partCount(a, 'pt-banner')], [countOf(p, 'pt-chair'), countOf(p, 'pt-banner')], 'A の画面がサーバーと同じ');
  eq([await partCount(b, 'pt-chair'), await partCount(b, 'pt-banner')], [countOf(p, 'pt-chair'), countOf(p, 'pt-banner')], 'B の画面がサーバーと同じ');
}, V3);

add('D16', '入力している最中に、ほかの端末でその案件が削除されても、入力は途切れない。案件は復活せず、表示が出て、入力した内容は控えに残る', async ({ device: mk }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '入力中に消される案件');
  await until(() => server('v3'), (s) => s.projects.length === 1);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(b, '入力中に消される案件');
  const text = 'abcdefghijklmnopqrstuvwxyz';
  await kv(b, 'メモ').click();
  await Promise.all([
    kv(b, 'メモ').pressSequentially(text, { delay: 140 }),                // 約 3.6 秒かけて入力し続ける
    (async () => { await sleep(1000); await deleteProject(a, '入力中に消される案件'); })(),
  ]);
  const ns = await until(() => notices(b), (xs) => xs.some((t) => t.includes('削除')), 10000);
  ok(ns.some((t) => t.includes('削除') && t.includes('控え')), `削除された旨の表示: ${JSON.stringify(ns)}`);
  eq(names((await server('v3')).projects), [], 'サーバーの案件（復活していないこと）');
  await space(b, 'local');
  await openProject(b, '入力中に消される案件（控え）');
  eq(await kv(b, 'メモ').inputValue(), text, '控えのメモ（入力が 1 文字も欠けていないこと）');
}, V3);

add('D17', '開いているだけ（編集していない）の案件が、ほかの端末で削除されたときは、一覧に戻って、その旨が表示される', async ({ device: mk }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '見ているだけの案件');
  await until(() => server('v3'), (s) => s.projects.length === 1);
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await until(() => projectRows(b), (r) => r.length === 1);
  await openProject(b, '見ているだけの案件');
  await deleteProject(a, '見ているだけの案件');
  await b.waitForSelector('text=案件一覧');
  ok((await until(() => notices(b), (xs) => xs.length > 0)).some((t) => t.includes('見ているだけの案件') && t.includes('無くなりました')), `表示: ${JSON.stringify(await notices(b))}`);
  eq(names((await server('v3')).projects), [], 'サーバーの案件');
}, V3);

add('D18', '「共有へコピー」「端末へコピー」: 案件が使う会場・スタッフなども一緒に入り、既にあるものは上書きしない。コピー元は変わらない', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '既存スタッフ', 1111);
  await until(() => server('v3'), (s) => s.staff.length === 1);
  const parts0 = (await server('v3')).partTypes;
  await loadSample(a);                        // サンプルは「この端末だけのデータ」へ
  eq(await shownSpace(a), 'local', 'サンプル読込後は「この端末だけのデータ」を表示');
  const localRows = await projectRows(a);
  await copyProject(a, 'ikyu');
  // 直前に入力した「既存スタッフ」の名前・時給は、入力が止まってから届く。コピーした分と合わせて、そろうまで待つ
  const s = await until(() => server('v3'), (x) => x.projects.length === 1 && x.staff.length === 4 && x.staff.some((y) => y.name === '既存スタッフ' && y.hourlyRate === 1111), 8000);
  eq(names(s.projects), ['ikyu'], '共有の案件');
  eq(names(s.staff), ['スタッフA（サンプル）', 'スタッフB（サンプル）', 'スタッフC（サンプル）', '既存スタッフ'].sort(), '共有のスタッフ（案件が使う 3 人が追加され、既存の 1 人はそのまま）');
  eq(s.staff.find((x) => x.name === '既存スタッフ').hourlyRate, 1111, '既存スタッフの時給');
  eq([names(s.venues), names(s.contents)], [['ラソラ札幌'], ['フラワーボトル']], '共有の会場・コンテンツ');
  same(s.partTypes.map(strip), parts0.map(strip), '共有のパーツ（サンプルの仮の単価で上書きされていないこと）');
  const p = s.projects[0];
  ok(p.assignments.every((x) => s.staff.some((y) => y.id === x.staffId)) && s.venues[0].id === p.venueId, 'コピーした案件の参照先（スタッフ・会場）が共有側にあること');
  ok((await notices(a)).some((t) => t.includes('コピーしました') && t.includes('上書きしていません')), `コピーの表示: ${JSON.stringify(await notices(a))}`);
  eq(await projectRows(a), localRows, 'コピー元（この端末だけのデータ）は変わらないこと');
  await copyProject(a, 'ikyu');               // もう一度コピーしても、マスタは増えない
  const s2 = await until(() => server('v3'), (x) => x.projects.length === 2, 8000);
  eq([s2.projects.length, s2.staff.length, s2.venues.length, s2.contents.length, s2.partTypes.length], [2, 4, 1, 1, parts0.length], '2 回目のコピー後の件数');
  // 共有 → この端末
  await space(a, 'shared');
  await createProject(a, '共有で作った案件');
  await until(() => server('v3'), (x) => x.projects.length === 3);
  await copyProject(a, '共有で作った案件');
  await space(a, 'local');
  ok((await projectRows(a)).includes('共有で作った案件'), 'この端末にコピーされること');
  eq((await server('v3')).projects.length, 3, '共有の案件数（コピー元は変わらないこと）');
}, V3);

add('D19', '共有データが、このアプリより新しい形式になったら、表示と編集を止める（古い版のアプリで書き換えない）', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '新しい形式の確認');
  await until(() => server('v3'), (s) => s.projects.length === 1);
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  const before = await rawAll(V3_COLLS.filter((c) => c !== 'wsMeta'));
  const meta = await admin.get(`${T}/wsMeta/state`);
  const { id: _id, ...body } = meta;
  await admin.set(`${T}/wsMeta/state`, { ...body, formatVersion: 2 });    // 将来の版のアプリが、形式を上げた想定
  await waitPhase(a, 'too-new');
  eq(await shownSpace(a), 'none', '共有データの表示を止めること');
  ok((await phaseText(a)).includes('新しい版の形式'), '案内の表示');
  const B = await mk('B');
  const b = await B.open();
  await signIn(b, 'b@example.com', { expectPhase: 'too-new' });
  await sleep(1500);
  same(await rawAll(V3_COLLS.filter((c) => c !== 'wsMeta')), before, '共有データ（古い版のアプリが書き換えていないこと）');
}, V3);

add('D20', '同じ端末で 2 つの画面（タブ）を開いていても同期し、片方を入力の直後に閉じても、もう片方が引き継いで送る', async ({ device: mk }) => {
  const A = await mk('A');
  const t1 = await A.open();
  await signIn(t1, 'a@example.com');
  await createProject(t1, 'タブの確認');
  await until(() => server('v3'), (s) => s.projects.length === 1);
  const t2 = await reopen(A);                 // 同じ端末の 2 つ目の画面
  eq(await until(() => projectRows(t2), (r) => r[0] === 'タブの確認'), ['タブの確認'], '2 つ目の画面の一覧');
  await addStaff(t2, '山田', 1200);
  eq(await until(() => staffNames(t1), (n) => n[0] === '山田'), ['山田'], '1 つ目の画面に届くこと');
  await openProject(t1, 'タブの確認');
  await kv(t1, 'メモ').fill('1 つ目の画面で、閉じる直前に入力');
  await t1.close();                           // 待たずに閉じる
  eq((await until(async () => (await server('v3')).projects[0], (p) => p.memo === '1 つ目の画面で、閉じる直前に入力', 30000)).memo, '1 つ目の画面で、閉じる直前に入力', 'サーバーのメモ（残った画面が引き継いで送ること）');
  eq(A.errors, [], 'ブラウザのエラーが無いこと');
}, V3);

add('D21', '送る前に閉じられた変更が端末に残っていても、その間にほかの人が同じ案件を変更していたら、古い内容で上書きしない（表示して、控えに残す）', async ({ device: mk }) => {
  const A = await mk('A'), B = await mk('B');
  let a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '後から開く案件');
  await until(() => server('v3'), (s) => s.projects[0]?.name === '後から開く案件');
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  const b = await B.open();
  await signIn(b, 'b@example.com');
  await openProject(a, '後から開く案件');
  await kv(a, 'メモ').fill('A が閉じる直前に書いた古いメモ');
  await a.close();                            // 送る前に閉じる（変更は端末の控えに残る）
  await openProject(b, '後から開く案件');
  await kv(b, 'メモ').fill('B が後から書いた新しいメモ');
  await until(async () => (await server('v3')).projects[0], (p) => p.memo === 'B が後から書いた新しいメモ');
  await sleep(1000);
  a = await reopen(A);                        // A が、後になって開き直す
  const ns = await until(() => notices(a), (xs) => xs.some((t) => t.includes('上書きしない')), 25000);
  ok(ns.some((t) => t.includes('後から開く案件') && t.includes('控え')), `表示: ${JSON.stringify(ns)}`);
  await sleep(1500);
  eq((await server('v3')).projects[0].memo, 'B が後から書いた新しいメモ', 'サーバーのメモ（新しい内容が残っていること）');
  eq(await a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length), 0, '控えが片付いていること');
  await space(a, 'local');
  await openProject(a, '後から開く案件（控え）');
  eq(await kv(a, 'メモ').inputValue(), 'A が閉じる直前に書いた古いメモ', '控えのメモ（A が書いた内容が残っていること）');
}, V3);

add('D22', '閉じる前に送信待ちになっていた変更は、開き直したときに 1 回だけ届く（届いたものを、もう一度送り直さない）', async ({ device: mk }) => {
  const A = await mk('A');
  let a = await A.open();
  await signIn(a, 'a@example.com');
  await addStaff(a, '山田', 1200);
  await until(() => server('v3'), (s) => s.staff[0]?.hourlyRate === 1200);
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  await A.offline(true);
  await setStaffRate(a, '山田', 1400);
  await until(() => syncLabel(a), (t) => t.includes('未送信'));
  await sleep(1200);                          // 送信待ちになる（端末内に残る）
  await a.close();
  await A.offline(false);
  a = await reopen(A);
  const s1 = (await until(() => server('v3'), (s) => s.staff[0]?.hourlyRate === 1400, 12000)).staff[0];
  eq(s1.hourlyRate, 1400, 'サーバーの時給');
  await sleep(16000);                         // 控えの引き取り（定期的に行う）を 1 回以上はさむ
  eq((await server('v3')).staff[0].rev, s1.rev, '届いたあと、同じ変更がもう一度書き込まれていないこと');
  eq(await a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length), 0, '控えが片付いていること');
  eq(await notices(a), [], '余計な表示が出ていないこと');
}, V3);

add('D23', '圏外で編集したまま閉じた案件が、その間にほかの端末で削除されていたら、開き直しても復活せず、表示が出て、控えが残る', async ({ device: mk }) => {
  const A = await mk('A'), B = await mk('B');
  const a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '閉じている間に消される案件');
  await until(() => server('v3'), (s) => s.projects[0]?.name === '閉じている間に消される案件');
  let b = await B.open();
  await signIn(b, 'b@example.com');
  await openProject(b, '閉じている間に消される案件');
  await B.offline(true);
  await kv(b, 'メモ').fill('B が圏外で書いたメモ');
  await sleep(1500);                          // 送信待ちになる
  await b.close();
  await deleteProject(a, '閉じている間に消される案件');
  await until(() => server('v3'), (s) => s.projects.length === 0);
  await B.offline(false);
  b = await reopen(B);
  const ns = await until(() => notices(b), (xs) => xs.some((t) => t.includes('削除')), 25000);
  ok(ns.some((t) => t.includes('削除') && t.includes('控え')), `表示: ${JSON.stringify(ns)}`);
  eq(names((await server('v3')).projects), [], 'サーバーの案件（復活していないこと）');
  await space(b, 'local');
  await openProject(b, '閉じている間に消される案件（控え）');
  eq(await kv(b, 'メモ').inputValue(), 'B が圏外で書いたメモ', '控えのメモ');
}, V3);

/** 突然終了の模擬: 閉じるときの「待たずに送る」処理を走らせずに、画面を閉じる */
async function kill(page) {
  await page.evaluate(() => {
    const stop = (e) => e.stopImmediatePropagation();
    window.addEventListener('pagehide', stop, true);
    document.addEventListener('visibilitychange', stop, true);
  });
  await page.close();
}
const outbox = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kkl_outbox')).length);

add('A17', '名簿を変更できなかった理由は、表示されたまま残る。つながっていない間の変更はその場で失敗し、つながったあとで勝手に適用されない', async ({ device: mk }) => {
  await roster({ 'owner@example.com': 'owner' });
  const O = await mk('O');
  const o = await O.open();
  await signIn(o, 'owner@example.com');
  await openMembers(o);
  // 1. 変更できなかった理由が、直後の名簿の読み直しで消えないこと
  await o.locator('[data-testid="members"] tr[data-email="owner@example.com"] button').click();
  ok((await until(() => membersError(o), (t) => t.includes('1 人もいなくなる'))).includes('1 人もいなくなる'), '最後の管理者は外せないこと');
  await sleep(2500);                           // 名簿の読み直しが終わるのを待つ
  ok((await membersError(o)).includes('1 人もいなくなる'), `読み直しのあとも理由が表示されていること: 「${await membersError(o)}」`);
  // 2. つながっていない間の変更は、その場で失敗する
  await O.block(true);
  await addMember(o, 'late@example.com');
  ok((await until(() => membersError(o), (t) => t.includes('名簿を変更できませんでした'), 60000)).includes('名簿を変更できませんでした'), `つながっていない間の変更の表示: 「${await membersError(o)}」`);
  eq(await admin.get(`${T}/members/late@example.com`), null, '名簿に追加されていないこと');
  // 3. つながったあとで、失敗した変更が勝手に適用されないこと
  await O.block(false);
  await sleep(8000);
  eq(await admin.get(`${T}/members/late@example.com`), null, 'つながったあとも、名簿に追加されていないこと');
  // つながっていれば、同じ操作で追加できる
  await addMember(o, 'late@example.com');
  eq((await until(() => admin.get(`${T}/members/late@example.com`), (m) => !!m, 30000))?.role, 'member', 'つながっていれば追加できること');
}, MEMBER_RULES);

add('A18', '「この端末だけのデータ」の案件を開いたままログインすると、案件は閉じて一覧に戻り、「共有データから無くなりました」という誤った表示は出ない', async ({ device: mk }) => {
  const C = await mk('C');
  const c = await C.open();
  await loadSample(c);                         // 未ログイン: 「この端末だけのデータ」にサンプルを入れる
  const localRows = await projectRows(c);
  await openProject(c, 'ikyu');
  eq(await c.locator('.sheettabs').count(), 1, '案件を開いていること');
  await signIn(c, 'a@example.com');            // ログインすると、表示が共有データに切り替わる
  eq(await shownSpace(c), 'shared', '共有データを表示');
  await sleep(1500);
  eq(await c.locator('.sheettabs').count(), 0, '開いていた案件が閉じていること');
  eq((await notices(c)).filter((t) => t.includes('無くなりました')), [], '誤った表示が出ていないこと');
  eq(await projectRows(c), [], '共有データの一覧（空）が出ていること');
  await space(c, 'local');
  eq(await projectRows(c), localRows, '「この端末だけのデータ」は、そのまま残っていること');
}, V3);

add('M17', '移行をやり直した・完了させたあとは、古い試行からは 1 件も書けない（完了後のデータを移行前の内容で上書きしない。完了の印も外せない）', async ({ device: mk }) => {
  const A = await mk('A');
  const a = await A.open();
  await signIn(a, 'a@example.com', { expectPhase: 'needs-init' });
  // 移行の書き込みの入口を、直接呼ぶ（画面からは順番どおりにしか呼ばれない。ここでは「止まっていた古い端末が、後から動き出した」場合を作る）
  const call = (fn, ...args) => a.evaluate(async ([f, xs]) => {
    try { return { ok: true, value: (await window.__kkl.migration[f](...xs)) ?? null }; } catch (e) { return { ok: false, code: e.code ?? String(e.message ?? e) }; }
  }, [fn, args]);
  const actor = { uid: 'test', displayName: 'テスト' };
  const staff = (name) => [{ coll: 'wsStaff', id: 's1', body: { id: 's1', name, hourlyRate: 1000, transportPerDay: 0, memo: '', order: 0 } }];
  const s1 = async () => (await admin.get(`${T}/wsStaff/s1`))?.name ?? null;
  const meta = async () => { const m = await admin.get(`${T}/wsMeta/state`); return [m?.status, m?.attempt]; };

  eq(await call('begin', 'b-1', actor), { ok: true, value: { backupId: 'b-1', attempt: 1 } }, '1 回目の開始');
  eq((await call('writeAll', 1, staff('1 回目の内容'))).ok, true, '1 回目の試行は書ける');
  eq(await s1(), '1 回目の内容', 'サーバーの内容');
  eq(await call('begin', 'b-2', actor), { ok: true, value: { backupId: 'b-1', attempt: 2 } }, 'やり直し（2 回目の開始。バックアップ名は 1 回目のものを使う）');
  // 止まっていた 1 回目の試行が、後から動き出した
  eq(await call('writeAll', 1, staff('古い試行が後から書こうとした内容')), { ok: false, code: 'superseded' }, '古い試行の書き込み');
  eq(await s1(), '1 回目の内容', 'サーバーの内容（古い試行で上書きされていないこと）');
  eq(await call('end', 1, { status: 'done' }), { ok: false, code: 'superseded' }, '古い試行が「完了」の印を付けようとした場合');
  eq(await call('end', 1, { status: 'failed', error: '古い試行の失敗' }), { ok: false, code: 'superseded' }, '古い試行が「失敗」を記録しようとした場合');
  eq(await meta(), ['running', 2], '形式の情報（2 回目の試行のまま）');
  // つながっていない間の書き込みは、その場で失敗し、あとから送られない
  await A.block(true);
  const blocked = await call('writeAll', 2, staff('つながっていない間に書こうとした内容'));
  ok(!blocked.ok && blocked.code !== 'superseded', `つながっていない間の書き込みは失敗すること: ${JSON.stringify(blocked)}`);
  await A.block(false);
  await sleep(5000);
  eq(await s1(), '1 回目の内容', 'つながったあとも、失敗した書き込みが後から届いていないこと');
  // 2 回目の試行が完了する
  eq((await call('writeAll', 2, staff('2 回目の内容'))).ok, true, '有効な試行は書ける');
  eq((await call('end', 2, { status: 'done' })).ok, true, '有効な試行は「完了」の印を付けられる');
  eq(await meta(), ['done', 2], '形式の情報（完了）');
  // 完了のあと
  eq(await call('writeAll', 2, staff('完了後に書こうとした内容')), { ok: false, code: 'superseded' }, '完了後の書き込み（同じ試行でも書けない）');
  eq(await call('end', 2, { status: 'failed', error: '完了後の失敗の記録' }), { ok: false, code: 'superseded' }, '完了の印を「失敗」に書き換えようとした場合');
  eq(await call('begin', 'b-3', actor), { ok: true, value: 'done' }, '完了後に移行を始めようとした場合（何もしない）');
  eq(await s1(), '2 回目の内容', 'サーバーの内容（完了時のまま）');
  eq(await meta(), ['done', 2], '形式の情報（完了のまま）');
  // 画面は、完了した共有データを使い始める
  await waitShared(a, 20000);
  eq(await until(() => staffNames(a), (n) => n[0] === '2 回目の内容'), ['2 回目の内容'], 'A の画面');
}, V3);

add('D24', '入力の直後に画面が突然終了しても、その変更は消えない。サーバーにつながらないまま開き直して同じ案件を編集しても、両方の変更が届く', async ({ device: mk }) => {
  const A = await mk('A');
  let a = await A.open();
  await signIn(a, 'a@example.com');
  await createProject(a, '突然終了する案件');
  await until(() => server('v3'), (s) => s.projects[0]?.name === '突然終了する案件');
  await until(() => syncLabel(a), (t) => t.includes('保存済み'));
  await openProject(a, '突然終了する案件');
  await kv(a, 'メモ').fill('終了の直前に書いた一文');
  await kill(a);                               // 送る前（0.7 秒たつ前）に、画面が消えた
  await sleep(1500);
  eq((await server('v3')).projects[0].memo, '', 'サーバーのメモ（まだ届いていないこと）');
  await A.block(true);                         // サーバーにつながらない状態で開き直す
  a = await reopen(A, 40000);
  await openProject(a, '突然終了する案件');
  eq(await kv(a, 'メモ').inputValue(), '終了の直前に書いた一文', '開き直した画面のメモ（前回の変更が出ていること）');
  ok((await until(() => syncLabel(a), (t) => t.includes('未送信'), 20000)).includes('未送信 1 件'), `未送信の表示: ${await syncLabel(a)}`);
  await kv(a, '案件名').fill('突然終了する案件（改名）');
  await sleep(1500);
  eq(await outbox(a), 1, '控えは 1 件（前回の変更と今回の変更を、まとめて持っていること）');
  eq((await server('v3')).projects[0].name, '突然終了する案件', 'サーバーの案件名（つながっていないので、まだ届いていないこと）');
  await A.block(false);
  const p = await until(async () => (await server('v3')).projects[0], (x) => x.memo === '終了の直前に書いた一文' && x.name === '突然終了する案件（改名）', 90000);
  eq([p.memo, p.name], ['終了の直前に書いた一文', '突然終了する案件（改名）'], 'サーバーの内容（両方の変更が届いていること）');
  await until(() => outbox(a), (n) => n === 0, 20000);
  eq(await notices(a), [], '余計な表示が出ていないこと');
  eq(A.errors, [], 'ブラウザのエラーが無いこと');
}, V3);

add('D25', '同じ端末の別の画面でログアウトしても、もう一方の画面が固まらない（未ログインの表示になり、ログインし直すと読み書きできる）', async ({ device: mk }) => {
  const A = await mk('A');
  const t1 = await A.open();
  await signIn(t1, 'a@example.com');
  await createProject(t1, '2 つの画面の案件');
  await until(() => server('v3'), (s) => s.projects[0]?.name === '2 つの画面の案件');
  await until(() => syncLabel(t1), (t) => t.includes('保存済み'));
  const t2 = await reopen(A);
  eq(await until(() => projectRows(t2), (r) => r[0] === '2 つの画面の案件'), ['2 つの画面の案件'], '2 つ目の画面の一覧');
  await signOutUi(t1);                         // 1 つ目の画面でログアウト
  await t1.waitForSelector('.auth-user', { state: 'detached', timeout: 20000 });
  // 2 つ目の画面も未ログインになる（端末内の共有データの控えは消える）
  await t2.waitForSelector('.auth-user', { state: 'detached', timeout: 20000 });
  eq(await until(() => shownSpace(t2).catch(() => ''), (v) => v === 'local', 20000), 'local', '2 つ目の画面は「この端末だけのデータ」を表示');
  await sleep(2500);                           // 読み込み直しが落ち着くのを待つ
  for (const t of [t1, t2]) await t.waitForFunction(() => !!window.__kkl && document.readyState === 'complete', null, { timeout: 20000 });
  eq((await cachedKeys(t2)).split('\n').filter((k) => SHARED_KEYS.test(k)), [], '端末内に共有データの控えが残っていないこと');
  // ログインし直すと、どちらの画面でも読み書きできる（接続が固まっていない）
  await signIn(t2, 'a@example.com');
  eq(await until(() => projectRows(t2), (r) => r[0] === '2 つの画面の案件', 20000), ['2 つの画面の案件'], 'ログインし直した 2 つ目の画面');
  // 1 つ目の画面: ログイン状態が自動で伝わる環境と、伝わらない環境がある。伝わっていなければ、この画面でもログインする
  await sleep(2000);
  if ((await t1.locator('.auth-user').count()) === 0) await signIn(t1, 'a@example.com');
  await waitShared(t1, 30000);
  eq(await until(() => projectRows(t1), (r) => r[0] === '2 つの画面の案件', 20000), ['2 つの画面の案件'], '1 つ目の画面');
  await addStaff(t2, '山田', 1200);
  eq((await until(() => server('v3'), (s) => s.staff[0]?.hourlyRate === 1200, 20000)).staff[0].name, '山田', '2 つ目の画面からの書き込み');
  eq(await until(() => staffNames(t1), (n) => n[0] === '山田', 20000), ['山田'], '1 つ目の画面に届くこと');
  eq(A.errors, [], 'ブラウザのエラーが無いこと');
}, V3);

add('D26', '同じ端末の 2 つの画面で同じ案件を編集し、片方が送る前に突然終了しても、その変更は黙って消えない（残った画面が引き取る）', async ({ device: mk }) => {
  const A = await mk('A');
  const t1 = await A.open();
  await signIn(t1, 'a@example.com');
  await createProject(t1, '2 画面で編集する案件');
  await until(() => server('v3'), (s) => s.projects[0]?.name === '2 画面で編集する案件');
  await until(() => syncLabel(t1), (t) => t.includes('保存済み'));
  const t2 = await reopen(A);
  await openProject(t1, '2 画面で編集する案件');
  await openProject(t2, '2 画面で編集する案件');
  await kv(t1, 'メモ').fill('画面 1 のメモ');   // 画面 1 が先に編集（0.7 秒後に送られる）
  await sleep(300);
  await kv(t2, '案件名').fill('画面 2 で付けた名前');   // 画面 2 が別の項目を編集し…
  await kill(t2);                              // …送る前に突然終了
  await until(async () => (await server('v3')).projects[0], (p) => p.memo === '画面 1 のメモ', 15000);
  // 画面 2 の変更は、残った画面 1 が引き取る: 共有に届くか、届けられない場合は表示して控えを残す（黙って消えない）
  const result = await until(async () => {
    const p = (await server('v3')).projects[0];
    if (p.name === '画面 2 で付けた名前') return 'applied';
    return (await notices(t1)).some((t) => t.includes('自動では反映していません') && t.includes('控え')) ? 'told' : '';
  }, (r) => r !== '', 45000);
  ok(result === 'applied' || result === 'told', `結果: ${result}`);
  if (result === 'told') {
    await space(t1, 'local');
    eq(await until(() => projectRows(t1), (r) => r.length === 1), ['画面 2 で付けた名前（控え）'], '控えの案件（画面 2 の変更が入っていること）');
  }
  eq((await server('v3')).projects[0].memo, '画面 1 のメモ', 'サーバーのメモ（画面 1 の変更が残っていること）');
  await until(() => outbox(t1), (n) => n === 0, 20000);
  eq(A.errors, [], 'ブラウザのエラーが無いこと');
}, V3);

await runFile('Version 3 で追加した確認項目', stopLegacyApp);
