// 同期テスト（複数端末）の共通部品。ローカルの Firebase エミュレータ（架空のプロジェクト demo-kkl）だけを相手にする。
// 実際の Firebase プロジェクトには一切つながない。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
  async set(docPath, obj) {
    const r = await fetch(`${DOCS}/${docPath}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ fields: toValue(obj).mapValue.fields }) });
    if (!r.ok) throw new Error(`書き込めません（${docPath}）: ${await r.text()}`);
  },
  async delete(docPath) { await fetch(`${DOCS}/${docPath}`, { method: 'DELETE', headers: ADMIN }); },
};
const T = `teams/${TEAM}`;

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
export async function startApp({ cwd = ROOT, port, env = {} } = {}) {
  const p = port ?? 5300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), '--port', String(p), '--strictPort', '--host', '127.0.0.1'], {
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
    if (opts.expectPhase) await page.waitForSelector(`[data-testid="shared-phase"][data-phase="${opts.expectPhase}"]`);
    else await page.waitForSelector('[data-testid="space"][data-space="shared"]');
  } else {
    await sleep(1500);
  }
}
export async function signOut(page) {
  await page.evaluate(() => window.__kkl.signOut());
  await page.waitForSelector('.auth-user', { state: 'detached' });
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
export async function openProject(page, name) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  await page.locator('.grid tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first().getByRole('button', { name: '開く' }).click();
  await page.waitForSelector('.sheettabs');
}
export async function deleteProject(page, name) {
  await tab(page, '案件');
  if (await page.locator('.pv__head').count()) await page.getByRole('button', { name: '← 案件一覧' }).click();
  await page.locator('.grid tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first().getByRole('button', { name: '×' }).click();
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
