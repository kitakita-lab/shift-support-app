// セキュリティルールの確認。ローカルのエミュレータ上で、実際にログインして読み書きを試す。
//   RULES=firestore.v3.rules（既定。メンバー制のルール案）／ RULES=firestore.rules（現在のルール）
// run.mjs から実行する（エミュレータが起動している前提）。
import fs from 'node:fs';
import path from 'node:path';
import { deleteApp, initializeApp } from 'firebase/app';
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInAnonymously, signInWithCredential, signOut } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, deleteDoc, doc, getDocFromServer, getDocsFromServer, getFirestore, setDoc, updateDoc,
} from 'firebase/firestore';
import { PROJECT, ROOT, TEAM, admin } from './lib.mjs';

const RULES = process.env.RULES ?? 'firestore.v3.rules';
const COLLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/store/collections.json'), 'utf8'));
const T = `teams/${TEAM}`;

let n = 0;
/** 端末 1 台ぶんの接続。email を指定するとその Google アカウントでログインした状態になる */
async function client(email, { verified = true } = {}) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: PROJECT }, `rules-${n++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  const c = { app, auth, db };
  c.signIn = (e, v = true) => signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: `uid-${e.toLowerCase()}`, email: e, email_verified: v })));
  c.signOut = () => signOut(auth);
  if (email === 'anonymous') await signInAnonymously(auth);
  else if (email) await c.signIn(email, verified);
  return c;
}

const results = [];
let group = '';
const g = (title) => { group = title; };
async function expect(label, want, fn) {
  let got = 'できる';
  try { await fn(); } catch (e) { got = e.code === 'permission-denied' ? '拒否' : `エラー:${e.code ?? e.message}`; }
  results.push({ group, label, want, got, ok: got === want });
}
const read = (c, p) => () => getDocFromServer(doc(c.db, p));
const list = (c, p) => () => getDocsFromServer(collection(c.db, p));
const write = (c, p, data = { x: 1 }) => () => setDoc(doc(c.db, p), data);
const update = (c, p, data = { x: 2 }) => () => updateDoc(doc(c.db, p), data);
const remove = (c, p) => () => deleteDoc(doc(c.db, p));

// ── 準備（管理者権限でデータを置く。ルールは通らない） ──────────────
await admin.reset();
await admin.loadRules(RULES);
const seedRoster = async () => {
  await admin.set(`${T}/members/owner@example.com`, { role: 'owner' });
  await admin.set(`${T}/members/member@example.com`, { role: 'member' });
  await admin.set(`${T}/members/unverified@example.com`, { role: 'member' });
  await admin.set(`${T}/members/leaving@example.com`, { role: 'member' });
  await admin.set('teams/other-team/members/other-owner@example.com', { role: 'owner' });
};
await seedRoster();
const everyColl = [...COLLS.app, COLLS.meta, COLLS.backups, ...COLLS.legacy, ...COLLS.oldApp];
for (const c of everyColl) await admin.set(`${T}/${c}/seed`, { name: `${c} のデータ` });
await admin.set('teams/other-team/wsProjects/seed', { name: '別チームのデータ' });
await admin.set(`${T}/wsProjects/seed/history/h1`, { name: '深い階層' });

// ── 0. ルールの一覧と、アプリが使う場所の一覧が一致しているか ──────────
g('0. 実際のデータパスとルールの一致');
{
  const src = fs.readFileSync(path.join(ROOT, RULES), 'utf8');
  const listIn = (fn) => (new RegExp(`function ${fn}\\(coll\\)[^}]*?\\[([^\\]]*)\\]`, 's').exec(src)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const check = (label, a, b) => results.push({ group, label, want: '一致', got: same(a, b) ? '一致' : `不一致（ルール: ${a.join(',') || 'なし'} ／ アプリ: ${b.join(',')}）`, ok: same(a, b) });
  check('新アプリのデータの置き場所（ルール ＝ アプリ）', listIn('isAppData'), COLLS.app);
  check('V1・V2 の形式の置き場所', listIn('isLegacyData'), COLLS.legacy);
  check('旧アプリ（シフト作成）の置き場所', listIn('isOldAppData'), COLLS.oldApp);
  check('形式の情報・バックアップの置き場所', listIn('isAdminData'), [COLLS.meta, COLLS.backups]);
  // アプリのコードが、一覧に無い場所を直接書いていないこと（置き場所は paths.ts だけが組み立てる）
  const storeDir = path.join(ROOT, 'src/store');
  const offenders = fs.existsSync(path.join(storeDir, 'paths.ts'))
    ? fs.readdirSync(storeDir).filter((f) => /\.tsx?$/.test(f) && f !== 'paths.ts' && !f.endsWith('.test.ts'))
        .filter((f) => /['"]teams['"]/.test(fs.readFileSync(path.join(storeDir, f), 'utf8')))
    : ['paths.ts がありません'];
  results.push({ group, label: 'アプリのコードが置き場所を直接組み立てていない（paths.ts 経由のみ）', want: '一致', got: offenders.length ? `不一致（${offenders.join(', ')}）` : '一致', ok: offenders.length === 0 });
}

// ── 1. 未登録のアカウント ───────────────────────────────────────
g('1. 名簿に無いアカウント（メールは確認済み）');
const stranger = await client('stranger@gmail.com');
for (const c of everyColl) {
  await expect(`${c}: 1 件読む`, '拒否', read(stranger, `${T}/${c}/seed`));
  await expect(`${c}: 一覧を読む`, '拒否', list(stranger, `${T}/${c}`));
  await expect(`${c}: 書く`, '拒否', write(stranger, `${T}/${c}/by-stranger`));
}
await expect('名簿: 一覧を読む', '拒否', list(stranger, `${T}/members`));
await expect('名簿: 他人の登録状況を読む', '拒否', read(stranger, `${T}/members/owner@example.com`));
await expect('名簿: 自分の登録状況を確認する', 'できる', read(stranger, `${T}/members/stranger@gmail.com`));
await expect('名簿: 自分を登録する（なりすまし登録）', '拒否', write(stranger, `${T}/members/stranger@gmail.com`, { role: 'owner' }));
await expect('別のチームのデータを読む', '拒否', read(stranger, 'teams/other-team/wsProjects/seed'));
await expect('チームの外の場所に書く', '拒否', write(stranger, 'anything/x'));

// ── 2. メンバー ───────────────────────────────────────────────
g('2. メンバー（role: member）');
const member = await client('member@example.com');
for (const c of [...COLLS.app, ...COLLS.oldApp]) {
  await expect(`${c}: 1 件読む・一覧を読む`, 'できる', async () => { await read(member, `${T}/${c}/seed`)(); await list(member, `${T}/${c}`)(); });
  await expect(`${c}: 作る・更新する・消す`, 'できる', async () => { await write(member, `${T}/${c}/by-member`)(); await update(member, `${T}/${c}/by-member`)(); await remove(member, `${T}/${c}/by-member`)(); });
}
for (const c of COLLS.legacy) {
  await expect(`${c}（V1・V2 の形式）: 読む`, 'できる', async () => { await read(member, `${T}/${c}/seed`)(); await list(member, `${T}/${c}`)(); });
  await expect(`${c}（V1・V2 の形式）: 作る`, '拒否', write(member, `${T}/${c}/by-member`));
  await expect(`${c}（V1・V2 の形式）: 更新する`, '拒否', update(member, `${T}/${c}/seed`));
  await expect(`${c}（V1・V2 の形式）: 消す`, '拒否', remove(member, `${T}/${c}/seed`));
}
for (const c of [COLLS.meta, COLLS.backups]) {
  await expect(`${c}: 読む`, 'できる', read(member, `${T}/${c}/seed`));
  await expect(`${c}: 作る`, '拒否', write(member, `${T}/${c}/by-member`));
  await expect(`${c}: 更新する`, '拒否', update(member, `${T}/${c}/seed`));
  await expect(`${c}: 消す`, '拒否', remove(member, `${T}/${c}/seed`));
}
await expect('名簿: 一覧を読む', '拒否', list(member, `${T}/members`));
await expect('名簿: 他人の登録状況を読む', '拒否', read(member, `${T}/members/owner@example.com`));
await expect('名簿: 自分の登録状況を確認する', 'できる', read(member, `${T}/members/member@example.com`));
await expect('名簿: 人を追加する', '拒否', write(member, `${T}/members/friend@example.com`, { role: 'member' }));
await expect('名簿: 自分を管理者に書き換える', '拒否', write(member, `${T}/members/member@example.com`, { role: 'owner' }));
await expect('名簿: 他人を外す', '拒否', remove(member, `${T}/members/leaving@example.com`));
await expect('別のチームのデータを読む', '拒否', read(member, 'teams/other-team/wsProjects/seed'));
await expect('別のチームのデータを書く', '拒否', write(member, 'teams/other-team/wsProjects/by-member'));

g('3. ネストした（2 階層より深い）場所');
await expect('メンバー: 案件の下の階層を読む', '拒否', read(member, `${T}/wsProjects/seed/history/h1`));
await expect('メンバー: 案件の下の階層に書く', '拒否', write(member, `${T}/wsProjects/seed/history/h2`));
await expect('メンバー: 名簿の下の階層に書く', '拒否', write(member, `${T}/members/member@example.com/extra/x`));
await expect('メンバー: 形式情報の下の階層に書く', '拒否', write(member, `${T}/wsMeta/state/extra/x`));
await expect('メンバー: チームのドキュメントそのものに書く', '拒否', write(member, `${T}`));
const owner = await client('owner@example.com');
await expect('管理者: 案件の下の階層を読む', '拒否', read(owner, `${T}/wsProjects/seed/history/h1`));
await expect('管理者: 案件の下の階層に書く', '拒否', write(owner, `${T}/wsProjects/seed/history/h2`));
await expect('管理者: 名簿の下の階層に書く', '拒否', write(owner, `${T}/members/owner@example.com/extra/x`));

// ── 4. 管理者権限の境界 ─────────────────────────────────────────
g('4. 管理者（role: owner）の権限の範囲');
await expect('名簿: 一覧を読む・他人の登録状況を読む', 'できる', async () => { await list(owner, `${T}/members`)(); await read(owner, `${T}/members/member@example.com`)(); });
await expect('名簿: メンバーを追加する', 'できる', write(owner, `${T}/members/newbie@example.com`, { role: 'member' }));
await expect('名簿: 役割を変える', 'できる', write(owner, `${T}/members/newbie@example.com`, { role: 'owner' }));
await expect('名簿: メンバーを外す', 'できる', remove(owner, `${T}/members/newbie@example.com`));
await expect('名簿: 決められた値以外の役割を書く（admin）', '拒否', write(owner, `${T}/members/x@example.com`, { role: 'admin' }));
await expect('名簿: 役割なしで登録する', '拒否', write(owner, `${T}/members/x@example.com`, { note: 'no role' }));
await expect('名簿: 決められた項目以外を書く', '拒否', write(owner, `${T}/members/x@example.com`, { role: 'member', isSuperUser: true }));
await expect('名簿: 大文字まじりのメールで登録する', '拒否', write(owner, `${T}/members/Mixed.Case@Example.com`, { role: 'member' }));
await expect('形式の情報・バックアップ: 作る・更新する', 'できる', async () => { for (const c of [COLLS.meta, COLLS.backups]) { await write(owner, `${T}/${c}/by-owner`)(); await update(owner, `${T}/${c}/by-owner`)(); } });
await expect('形式の情報: 消す', '拒否', remove(owner, `${T}/${COLLS.meta}/seed`));
await expect('バックアップ: 消す', '拒否', remove(owner, `${T}/${COLLS.backups}/seed`));
for (const c of COLLS.legacy) await expect(`${c}（V1・V2 の形式）: 書き換える`, '拒否', write(owner, `${T}/${c}/seed`, { name: '書き換え' }));
await expect('新アプリのデータ: 読み書き', 'できる', async () => { await write(owner, `${T}/wsProjects/by-owner`)(); await read(owner, `${T}/wsProjects/by-owner`)(); await remove(owner, `${T}/wsProjects/by-owner`)(); });
await expect('別のチーム: データを読む', '拒否', read(owner, 'teams/other-team/wsProjects/seed'));
await expect('別のチーム: 名簿に自分を足す', '拒否', write(owner, 'teams/other-team/members/owner@example.com', { role: 'owner' }));
await expect('別のチーム: 名簿を読む', '拒否', list(owner, 'teams/other-team/members'));
const otherOwner = await client('other-owner@example.com');
await expect('別チームの管理者: こちらのチームのデータを読む', '拒否', read(otherOwner, `${T}/wsProjects/seed`));
await expect('別チームの管理者: こちらの名簿に自分を足す', '拒否', write(otherOwner, `${T}/members/other-owner@example.com`, { role: 'owner' }));

// ── 5. メールアドレスの大文字小文字 ──────────────────────────────
g('5. メールアドレスの大文字小文字');
const mixed = await client('Member@Example.COM');          // 名簿は member@example.com（小文字）
await expect('大文字まじりのメールでログインしたメンバー: データを読む', 'できる', read(mixed, `${T}/wsProjects/seed`));
await expect('大文字まじりのメールでログインしたメンバー: データを書く', 'できる', async () => { await write(mixed, `${T}/wsProjects/by-mixed`)(); await remove(mixed, `${T}/wsProjects/by-mixed`)(); });
await expect('同: 自分の登録状況を確認する（小文字の場所）', 'できる', read(mixed, `${T}/members/member@example.com`));
const mixedStranger = await client('Stranger@Gmail.com');
await expect('大文字まじりのメールの未登録アカウント: データを読む', '拒否', read(mixedStranger, `${T}/wsProjects/seed`));

// ── 6. メールが未確認・メールが無いアカウント ─────────────────────
g('6. メールが未確認・メールが無いアカウント');
const unverified = await client('unverified@example.com', { verified: false });   // 名簿にはある
await expect('名簿にあるがメール未確認: データを読む', '拒否', read(unverified, `${T}/wsProjects/seed`));
await expect('名簿にあるがメール未確認: データを書く', '拒否', write(unverified, `${T}/wsProjects/by-unverified`));
await expect('名簿にあるがメール未確認: 自分の登録状況を確認する', '拒否', read(unverified, `${T}/members/unverified@example.com`));
const anon = await client('anonymous');
await expect('匿名ログイン（メール無し）: データを読む', '拒否', read(anon, `${T}/wsProjects/seed`));
await expect('匿名ログイン（メール無し）: データを書く', '拒否', write(anon, `${T}/wsProjects/by-anon`));
const nobody = await client(null);
await expect('ログインしていない: データを読む', '拒否', read(nobody, `${T}/wsProjects/seed`));
await expect('ログインしていない: 旧アプリのデータを読む', '拒否', read(nobody, `${T}/appData/seed`));

// ── 7. アカウントの変更・名簿から外れたとき ───────────────────────
g('7. アカウントの変更・名簿から外れたとき');
const dev = await client('member@example.com');           // 同じ端末（同じ接続）でアカウントを切り替える
await expect('メンバーでログイン中: データを読む', 'できる', read(dev, `${T}/wsProjects/seed`));
await dev.signOut();
await expect('ログアウト後: データを読む', '拒否', read(dev, `${T}/wsProjects/seed`));
await dev.signIn('stranger@gmail.com');
await expect('同じ端末で未登録のアカウントに切り替え: データを読む', '拒否', read(dev, `${T}/wsProjects/seed`));
await expect('同じ端末で未登録のアカウントに切り替え: データを書く', '拒否', write(dev, `${T}/wsProjects/by-switched`));
await dev.signOut();
await dev.signIn('owner@example.com');
await expect('同じ端末で管理者に切り替え: 名簿を読む', 'できる', list(dev, `${T}/members`));
const leaving = await client('leaving@example.com');
await expect('外される前のメンバー: データを読む', 'できる', read(leaving, `${T}/wsProjects/seed`));
await remove(owner, `${T}/members/leaving@example.com`)();
await expect('名簿から外された直後: データを読む', '拒否', read(leaving, `${T}/wsProjects/seed`));
await expect('名簿から外された直後: データを書く', '拒否', write(leaving, `${T}/wsProjects/by-leaving`));
await write(owner, `${T}/members/member@example.com`, { role: 'owner' })();          // メンバーを管理者に昇格
await expect('昇格した直後: 名簿を読める', 'できる', list(member, `${T}/members`));
await write(owner, `${T}/members/member@example.com`, { role: 'member' })();         // 管理者からメンバーに戻す
await expect('降格した直後: 名簿を読めない', '拒否', list(member, `${T}/members`));

// ── 結果 ──────────────────────────────────────────────────────
let last = '';
for (const r of results) {
  if (r.group !== last) { console.log(`\n■ ${r.group}`); last = r.group; }
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.label} → ${r.got}${r.ok ? '' : `（期待: ${r.want}）`}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\nルール: ${RULES} ／ ${results.length} 項目中 ${results.length - bad.length} 合格／${bad.length} 不合格`);
for (const c of [stranger, member, owner, otherOwner, mixed, mixedStranger, unverified, anon, nobody, dev, leaving]) await deleteApp(c.app).catch(() => {});
process.exit(bad.length ? 1 : 0);
