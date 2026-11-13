// 同期テスト（複数端末）の共通部品。ローカルの Firebase エミュレータ（架空のプロジェクト demo-kkl）だけを相手にする。
// 実際の Firebase プロジェクトには一切つながない。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadPlaywright } from '../playwright.mjs';

export { ROOT };
export const PROJECT = 'demo-kkl';
export const TEAM = 'intention-dev';
export const FS_HOST = 'http://127.0.0.1:8085';
export const AUTH_HOST = 'http://127.0.0.1:9099';
const DOCS = `${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
// エミュレータでは "Bearer owner" がルールを通らない管理者権限になる（テストの準備と結果の確認に使う）
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期待 ${e} ／ 実際 ${a}`);
}
export function ok(cond, label) { if (!cond) throw new Error(label); }
/** キーの順序によらない比較用の文字列 */
export function canon(v) {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}
/** 内容が同じこと（キーの順序は問わない）。違う場合は、最初に違いが出たあたりを示す */
export function same(actual, expected, label) {
  const a = canon(actual), e = canon(expected);
  if (a === e) return;
  let i = 0;
  while (i < a.length && a[i] === e[i]) i += 1;
  throw new Error(`${label}: 内容が違います（${i} 文字目付近）期待 …${e.slice(Math.max(0, i - 60), i + 80)}… ／ 実際 …${a.slice(Math.max(0, i - 60), i + 80)}…`);
}
/** 条件が満たされるまで待つ（既定 6 秒）。最後の値を返す */
export async function until(fn, pred = (v) => !!v, timeout = 6000) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await fn();
    if (pred(v) || Date.now() - t0 > timeout) return v;
    await sleep(120);
  }
}

// ── Firestore エミュレータ（REST・管理者権限） ──────────────────
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toValue(x)])) } };
}
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  return undefined;
}
const fromDoc = (d) => ({ id: d.name.split('/').pop(), ...fromValue({ mapValue: { fields: d.fields ?? {} } }) });

export const admin = {
  async reset() {
    await fetch(`${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    await fetch(`${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE', headers: ADMIN });
  },
  /** ルールを差し替える（ファイルはリポジトリのルートからの相対パス） */
  async loadRules(file) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const r = await fetch(`${FS_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ rules: { files: [{ content }] } }) });
    if (!r.ok) throw new Error(`ルールを読み込めません（${file}）: ${await r.text()}`);
  },
  async get(docPath) {
    const r = await fetch(`${DOCS}/${docPath}`, { headers: ADMIN });
    return r.ok ? fromDoc(await r.json()) : null;
  },
  async list(collPath) {
    const out = [];
    let token = '';
    do {
      const r = await (await fetch(`${DOCS}/${collPath}?pageSize=300${token ? `&pageToken=${token}` : ''}`, { headers: ADMIN })).json();
      for (const d of r.documents ?? []) out.push(fromDoc(d));
      token = r.nextPageToken ?? '';
    } while (token);
    return out;
  },
  /** コレクションの全ドキュメントを、名前と中身に分けて返す（中身に id という項目があっても混ざらない）。名前順 */
  async docs(collPath) {
    const out = [];
    let token = '';
    do {
      const r = await (await fetch(`${DOCS}/${collPath}?pageSize=300${token ? `&pageToken=${token}` : ''}`, { headers: ADMIN })).json();
      for (const d of r.documents ?? []) out.push({ id: d.name.split('/').pop(), body: fromValue({ mapValue: { fields: d.fields ?? {} } }) });
      token = r.nextPageToken ?? '';
    } while (token);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },
  async set(docPath, obj) {
    const r = await fetch(`${DOCS}/${docPath}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ fields: toValue(obj).mapValue.fields }) });
    if (!r.ok) throw new Error(`書き込めません（${docPath}）: ${await r.text()}`);
  },
  async delete(docPath) { await fetch(`${DOCS}/${docPath}`, { method: 'DELETE', headers: ADMIN }); },
};
const T = `teams/${TEAM}`;
export const LEGACY_COLLS = ['workshopData', 'workshopProjects'];
export const V3_COLLS = ['wsStaff', 'wsVenues', 'wsContents', 'wsPartTypes', 'wsComposites', 'wsProjects', 'wsMeta', 'wsBackups'];
/** 指定した置き場所の全ドキュメントを、そのままの形で読む（「1 件も変わっていない」ことの比較に使う） */
export async function rawAll(colls) {
  const out = {};
  for (const c of colls) out[c] = await admin.docs(`${T}/${c}`);
  return out;
}
/** メンバー名簿を置く（管理者権限。ルールは通らない） */
export async function roster(members) {
  for (const [email, role] of Object.entries(members)) await admin.set(`${T}/members/${email}`, { role, addedAt: 1, addedBy: 'test' });
}

/**
 * サーバー上の共有データを、形式によらず同じ形で読む。
 *  - legacy: V1・V2 の置き方（workshopData のかたまり・workshopProjects）
 *  - v3: 新しい置き方（wsStaff など 1 件＝1 ドキュメント・wsProjects）
 */
export async function server(format) {
  if (format === 'v3') {
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));
    const masters = async (coll) => (await admin.list(`${T}/${coll}`)).sort(byOrder);
    return {
      projects: (await admin.list(`${T}/wsProjects`)).sort(byOrder),
      staff: await masters('wsStaff'), venues: await masters('wsVenues'), contents: await masters('wsContents'),
      partTypes: await masters('wsPartTypes'), composites: await masters('wsComposites'),
    };
  }
  const items = async (key) => (await admin.get(`${T}/workshopData/${key}`))?.items ?? [];
  return {
    projects: await admin.list(`${T}/workshopProjects`),
    staff: await items('staff'), venues: await items('venues'), contents: await items('contents'),
    partTypes: await items('partTypes'), composites: await items('composites'),
  };
}
export const names = (xs) => xs.map((x) => x.name).sort();

// ── アプリの起動 ────────────────────────────────────────────
/** 開発サーバーを起動する（接続先はエミュレータ） */
export async function startApp({ cwd = ROOT, port, env = {}, args = [] } = {}) {
  const p = port ?? 5300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), '--port', String(p), '--strictPort', '--host', '127.0.0.1', ...args], {
    cwd, stdio: 'ignore',
    env: { ...process.env, VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_EMULATOR: '1', ...env },
  });
  const url = `http://127.0.0.1:${p}/`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) return { url, stop: () => child.kill() }; } catch { /* 起動中 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error(`開発サーバーを起動できませんでした（${cwd}）`);
}

// ── 古いアプリ（Version 2）─────────────────────────────────────
// 実際の Version 2 のコード（PR #85 の時点）を一時フォルダに取り出し、接続先だけをエミュレータに向けて起動する。
const V2_COMMIT = '9daa441199ff493bc3cd048b074c24c02bb9e777';
let _legacy;
export async function legacyApp() {
  if (_legacy) return _legacy;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkl-v2-client-'));
  const tar = spawnSync('git', ['archive', '--format=tar', V2_COMMIT], { cwd: ROOT, maxBuffer: 1 << 28 });
  if (tar.status !== 0) throw new Error(`Version 2 のコード（${V2_COMMIT.slice(0, 7)}）を取り出せません。git fetch origin claude/focused-brahmagupta-np0iry を実行してください`);
  if (spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout }).status !== 0) throw new Error('Version 2 のコードを展開できません');
  fs.copyFileSync(path.join(ROOT, 'e2e/sync/legacy-client/firebase.ts'), path.join(dir, 'src/firebase.ts'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // 依存の下ごしらえ（キャッシュ）を、本体の開発サーバーと取り合わないように分ける
  fs.writeFileSync(path.join(dir, 'vite.legacy.config.ts'), "import { mergeConfig } from 'vite';\nimport base from './vite.config';\nexport default mergeConfig(base, { cacheDir: './.vite-legacy' });\n");
  const app = await startApp({ cwd: dir, args: ['--config', 'vite.legacy.config.ts'] });
  _legacy = { ...app, dir, stop: () => { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); _legacy = undefined; } };
  return _legacy;
}
export function stopLegacyApp() { _legacy?.stop(); }

let _legacyDocs;
/**
 * 以前の形式（V1・V2）の共有データを用意する。
 * 初回は、実際の Version 2 のアプリを操作して作る（サンプル読込＋スタッフ 1 人＋案件 1 件）。2 回目以降は、その写しをそのまま置く。
 * rules: この確認項目で使うルール（初回は、V2 が書けるように現在のルールへ一時的に切り替える）
 */
export async function seedLegacy(mk, rules = 'firestore.rules') {
  if (!_legacyDocs) {
    await admin.loadRules('firestore.rules');
    const app = await legacyApp();
    const L = await mk('V2', app.url);
    const l = await L.open();
    await signIn(l, 'owner@example.com');
    await loadSample(l);
    await addStaff(l, '追加スタッフ', 1234);
    await createProject(l, '追加の案件');
    const done = await until(() => server('legacy'), (s) => s.projects.length === 3 && s.staff.length === 4 && s.staff.some((x) => x.hourlyRate === 1234) && s.projects.some((p) => p.name === '追加の案件'), 12000);
    ok(done.projects.length === 3 && done.staff.length === 4, `Version 2 のアプリで以前の形式のデータを作れませんでした: ${JSON.stringify([names(done.projects), names(done.staff)])}`);
    await sleep(1500);
    await L.close();
    _legacyDocs = await rawAll(LEGACY_COLLS);
    await admin.loadRules(rules);
    return _legacyDocs;
  }
  for (const c of LEGACY_COLLS) for (const d of _legacyDocs[c]) await admin.set(`${T}/${c}/${d.id}`, d.body);
  return _legacyDocs;
}

// ── 端末（ブラウザの独立したコンテキスト 1 つ＝端末 1 台） ────────
let _browser;
export async function browser() {
  if (!_browser) {
    const { chromium } = loadPlaywright();
    _browser = await chromium.launch({ env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8', LC_ALL: process.env.LC_ALL || 'C.UTF-8' } });
  }
  return _browser;
}
export async function closeBrowser() { await _browser?.close(); _browser = undefined; }

export async function device(url, name = 'device') {
  const ctx = await (await browser()).newContext({ viewport: { width: 1440, height: 950 }, timezoneId: 'Asia/Tokyo', locale: 'ja-JP', acceptDownloads: true });
  const d = { name, ctx, url, dialogs: [], errors: [], accept: true };
  d.open = async () => {
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    page.on('dialog', async (dlg) => { d.dialogs.push(dlg.message().replace(/\s+/g, ' ')); if (d.accept) await dlg.accept(); else await dlg.dismiss(); });
    page.on('pageerror', (e) => d.errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => !!window.__kkl);
    return page;
  };
  d.offline = (v) => ctx.setOffline(v);
  // Firestore との通信だけを止める（アプリ自体は開けるが、サーバーにつながらない状態）。新しく張る通信に効く
  const FS = `${FS_HOST}/**`;
  d.block = async (v) => { if (v) await ctx.route(FS, (r) => r.abort()); else await ctx.unroute(FS); };
  d.close = () => ctx.close();
  return d;
}

// ── 画面操作（V2 と V3 のどちらの画面でも動くように書く） ──────────
export const appFormat = (page) => page.evaluate(() => window.__kkl?.format ?? 'legacy');
export const tab = (page, label) => page.locator('.app__tabs button', { hasText: label }).first().click();
export const sheet = (page, label) => page.locator('.sheettabs button', { hasText: label }).click();
export const syncLabel = (page) => page.locator('.sync').first().innerText();

/** ログインして、共有データが使える状態になるまで待つ */
export async function signIn(page, email, opts = {}) {
  await page.evaluate(([e, o]) => window.__kkl.signInAs(e, o), [email, opts]);
  await page.waitForSelector('.auth-user');
  if ((await appFormat(page)) === 'v3') {
    if (opts.expectPhase) { await page.waitForSelector(`[data-testid="shared-phase"][data-phase="${opts.expectPhase}"]`); return; }
    // まだ誰も使い始めていないチームでは「共有データを使い始める」が出る（押すまで、共有側には何も書き込まれない）
    const first = await page.waitForSelector('[data-testid="space"][data-space="shared"], [data-testid="init-shared"]');
    if ((await first.getAttribute('data-testid')) === 'init-shared') await first.click();
    await page.waitForSelector('[data-testid="space"][data-space="shared"]');
  } else {
    await sleep(1500);
  }
}
export async function signOut(page) {
  await page.evaluate(() => window.__kkl.signOut());
  await page.waitForSelector('.auth-user', { state: 'detached' });
}
/** 画面の「ログアウト」ボタンを押す（未送信の変更があると確認が出る） */
export const signOutUi = (page) => page.getByRole('button', { name: 'ログアウト' }).click();
export const waitShared = (page, timeout = 20000) => page.waitForSelector('[data-testid="space"][data-space="shared"]', { timeout });
export const waitPhase = (page, phase, timeout = 20000) => page.waitForSelector(`[data-testid="space"][data-phase="${phase}"]`, { timeout });
export const shownSpace = (page) => page.locator('[data-testid="space"]').getAttribute('data-space');
/** 端末内（ブラウザの IndexedDB）に Firestore が持っている控えの、ドキュメントの場所の一覧（文字列） */
export function cachedKeys(page) {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).filter((d) => (d.name ?? '').startsWith('firestore/'));
    const keys = [];
    for (const info of dbs) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const name of Array.from(db.objectStoreNames)) {
        if (!/^remoteDocuments|^documentOverlays|^mutations$|^documentMutations$/.test(name)) continue;
        const ks = await new Promise((res) => { const q = db.transaction(name).objectStore(name).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
        keys.push(...ks.map((k) => `${name}:${JSON.stringify(k)}`));
      }
      db.close();
    }
    return keys.join('\n');
  });
}
/** 表示する置き場所を切り替える（V3 のみ。V2 は置き場所が 1 つなので何もしない） */
export async function space(page, which) {
  if ((await appFormat(page)) !== 'v3') return;
  if ((await page.locator('[data-testid="space"]').getAttribute('data-space')) === which) return;
  await page.locator(`[data-testid="space-${which}"]`).click();
  await page.waitForSelector(`[data-testid="space"][data-space="${which}"]`);
}
export async function loadSample(page) {
  await tab(page, 'データ');
  await page.getByRole('button', { name: /サンプルデータを読み込む/ }).click();
  await page.waitForSelector('text=案件一覧');
}
export async function projectRows(page) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  return (await page.locator('.grid tbody tr').evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent?.trim() ?? ''))).filter((t) => t && !t.startsWith('案件がありません'));
}
export async function createProject(page, name) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  await page.getByRole('button', { name: '＋ 新しい案件' }).click();
  await page.locator('table.kv tr', { hasText: '案件名' }).locator('input').fill(name);
  await page.getByRole('button', { name: '← 案件一覧' }).click();
}
// 行のボタンは、名前の完全一致で探す（Version 4 から、案件名そのものも「押すと開く」ボタンになった。案件名に「開く」などの文字が入っていても取り違えないため）
export async function openProject(page, name) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  await page.locator('.grid tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first().getByRole('button', { name: '開く', exact: true }).click();
  await page.waitForSelector('.sheettabs');
}
export async function deleteProject(page, name) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  await page.locator('.grid tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first().getByRole('button', { name: '×', exact: true }).click();
}
export const kv = (page, label) => page.locator('table.kv tr', { hasText: label }).locator('input');
export async function addStaff(page, name, rate) {
  await tab(page, 'スタッフ');
  await page.getByRole('button', { name: '＋ スタッフを追加' }).click();
  await page.locator('[data-c="name"]').last().fill(name);
  await page.locator('[data-c="hourlyRate"]').last().fill(String(rate));
}
export async function staffNames(page) {
  await tab(page, 'スタッフ');
  return page.locator('[data-c="name"]').evaluateAll((els) => els.map((e) => e.value));
}
export async function setStaffRate(page, name, rate) {
  await tab(page, 'スタッフ');
  const i = (await page.locator('[data-c="name"]').evaluateAll((els) => els.map((e) => e.value))).indexOf(name);
  if (i < 0) throw new Error(`スタッフ「${name}」が画面にありません`);
  await page.locator('[data-c="hourlyRate"]').nth(i).fill(String(rate));
}
export const notices = (page) => page.locator('[data-testid="notices"] li').allInnerTexts();

// ── 確認項目の登録と実行 ────────────────────────────────────
const scenarios = [];
export const add = (id, title, fn, opts = {}) => scenarios.push({ id, title, fn, opts });

export async function runAll(ctx) {
  const only = process.env.ONLY;
  const results = [];
  for (const s of scenarios.filter((x) => !only || only.split(',').some((p) => x.id.startsWith(p)))) {
    const devices = [];
    const mk = async (name, url = ctx.url) => { const d = await device(url, name); devices.push(d); return d; };
    let detail = '';
    let skipped = '';
    try {
      await admin.reset();
      await admin.loadRules(s.opts.rules ?? 'firestore.rules');
      const need = s.opts.needs;
      if (need === 'v3' && ctx.format !== 'v3') skipped = 'この版には無い機能（Version 3 で追加）';
      else await s.fn({ ...ctx, device: mk });
      const errs = devices.flatMap((d) => d.errors);
      if (!skipped && errs.length) throw new Error(`ブラウザのエラー: ${errs[0]}`);
    } catch (e) {
      detail = String(e.message ?? e).split('\n')[0];
    }
    for (const d of devices) await d.close().catch(() => {});
    results.push({ ...s, ok: !detail && !skipped, skipped, detail });
    console.log(`${skipped ? '－' : detail ? '✗' : '✓'} ${s.id} ${s.title}${detail ? `\n      → ${detail}` : ''}${skipped ? `\n      （${skipped}）` : ''}`);
  }
  return results;
}

/** 登録した確認項目を実行して、結果のまとめを出す（各ファイルの最後で呼ぶ） */
export async function runFile(title, cleanup = () => {}) {
  const app = process.env.APP_URL ? { url: process.env.APP_URL, stop: () => {} }
    : process.env.KKL_TARGET === 'v2' ? await legacyApp()
    : await startApp();
  let results = [];
  try {
    const probe = await device(app.url, 'probe');
    const format = await appFormat(await probe.open());
    await probe.close();
    console.log(`\n${title}\n対象: ${app.url}（共有データの形式: ${format === 'v3' ? 'Version 3' : 'V1・V2'}）\n`);
    results = await runAll({ url: app.url, format });
  } finally {
    await closeBrowser();
    app.stop();
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${results.length} 項目中 ${results.length - failed.length - skipped.length} 合格／${failed.length} 不合格${skipped.length ? `／${skipped.length} 対象外` : ''}${failed.length ? `（${failed.map((r) => r.id).join(', ')}）` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
