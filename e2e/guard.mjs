#!/usr/bin/env node
// 検証用のビルドが、本番のデータにつながらないことの確認（実際のビルドと、実ブラウザ・Chromium）。
//
// 守ること（src/store/team.ts）: 通常のチーム（本番のデータ）につながるのは、本番のビルドだけ。
// 本番ではないビルドで、検証用のチーム名（VITE_TEAM_ID）が無い・通常のチーム名・使えない形のときは、
//   - ビルド（vite build）は失敗し、配信するものを作らない
//   - アプリ（開発サーバーで動かした場合）は、Firebase を起動しない（ログインのボタンが出ない・外への通信が無い）
//
//   B … 実際にビルドして確かめる（止まるもの・止まらないもの・ビルドの記録の行）
//   S … 配信するビルド（止まらなかったもの）を、ブラウザで開いて確かめる
//   D … 止まる条件のアプリを、開発サーバーで動かして、ブラウザで確かめる（D5 は、止まらない条件との対照）
//
// 使い方:
//   node e2e/guard.mjs            … すべて
//   ONLY=B node e2e/guard.mjs     … 記号が B で始まる項目だけ
//
// 実際の Firebase には、つながない: 設定は架空の値（実在しないプロジェクト）で、ブラウザから外への通信は、すべて止めて記録する。
// この自動テストの範囲の外: Vercel の上での実際のビルド（VERCEL_ENV が実際に渡ること・失敗したときに、その URL が前のビルドのまま残ること）。
//   これらは、Vercel のビルドの記録と、実際に失敗させた結果で確かめる（docs/作業ログ.md の「Version 5.2」）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadPlaywright } from './playwright.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期待 ${e} ／ 実際 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }
async function until(fn, pred = (v) => !!v, timeout = 8000) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await fn();
    if (pred(v) || Date.now() - t0 > timeout) return v;
    await sleep(80);
  }
}

// ── ビルドの条件 ─────────────────────────────────────────────
const DEFAULT_TEAM = 'intention-dev';
const VERIFY_TEAM = 'kkl-preview-check';
/** 実際の Firebase の設定に見える値（架空。実在しないプロジェクト） */
const REAL = { VITE_FIREBASE_API_KEY: 'key-for-guard-test', VITE_FIREBASE_PROJECT_ID: 'kkl-guard-test-project' };
const DEMO = { VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_PROJECT_ID: 'demo-kkl' };
const VITE = path.join(ROOT, 'node_modules/vite/bin/vite.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kkl-guard-'));

/** このアプリが読む環境変数（手元の .env* に同じ名前があっても、ここで渡した値が優先される） */
const APP_KEYS = ['VITE_TEAM_ID', 'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_EMULATOR'];
/**
 * 子プロセスに渡す環境変数。呼び出した側のもの・手元の .env* のものに左右されないよう、判定に関わるものは、すべて決めて渡す
 * （指定の無いものは、空文字＝「設定なし」として渡す。空文字は、.env* の値より優先され、アプリは「無い」ものとして扱う）。
 */
function envFor(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_') || k === 'VERCEL' || k.startsWith('VERCEL_')) delete env[k];
  for (const k of APP_KEYS) env[k] = '';
  return { ...env, ...extra };
}
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITE, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const builds = new Map();
/** 実際にビルドする（同じ条件は 1 回だけ）。dir は出力先（失敗したら、作られない） */
function build(name, extra) {
  if (!builds.has(name)) {
    const dir = path.join(TMP, name);
    builds.set(name, run(['build', '--outDir', dir, '--emptyOutDir'], envFor(extra)).then((r) => ({
      ...r, dir, lines: r.out.split('\n').filter((l) => l.startsWith('[kkl]')), made: fs.existsSync(path.join(dir, 'index.html')),
    })));
  }
  return builds.get(name);
}
/** サーバーを起動する。ポートは、ほかの確認（verify・v4・sync）と重ならない範囲。out() は、サーバーの出力（[kkl] の行など） */
async function serve(args, extra) {
  const port = 6200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [VITE, ...args, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, env: envFor(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 150; i++) {
    // 起動に失敗して終了していたら（ポートが使用中など）、ほかのサーバーの応答を、このサーバーのものと取り違えない
    if (child.exitCode !== null) throw new Error(`サーバーが終了しました（終了コード ${child.exitCode}）: ${out.slice(-300)}`);
    try { if ((await fetch(url)).ok && child.exitCode === null) return { url, stop: () => child.kill(), out: () => out }; } catch { /* 起動中 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error('サーバーを起動できませんでした');
}
/** 配信するビルド（vite build の出力）を、そのまま配る */
const servePreview = (dir) => serve(['preview', '--outDir', dir], {});
/** 開発サーバーで動かす（ビルドは止まる条件でも、こちらは起動する。アプリの側が止まることを確かめるため） */
const serveDev = (extra) => serve([], extra);

// ── ブラウザ ────────────────────────────────────────────────
const { chromium, devices } = loadPlaywright();
let browser;
/**
 * ページを開く。外（127.0.0.1 以外）への通信は、すべて止めて、行き先を記録する。
 * 既定は、スマホ（iPhone 14 相当。Safari を名乗る）: 実機確認の対象で、かつ、Firebase のログインの部品が、開いた時点で外への通信を試みる条件
 * （PC のブラウザでは、ログインのボタンを押すまで通信しないため、「通信が無い」ことの確認にならない）。
 */
async function open(url, { phone = true, init } = {}) {
  const base = { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' };
  const context = await browser.newContext(phone ? { ...devices['iPhone 14'], ...base } : { viewport: { width: 1280, height: 900 }, ...base });
  try {
    const outside = [];
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') return route.continue();
      outside.push(`${u.hostname}${u.pathname}`);
      return route.abort();
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.setDefaultTimeout(8000);
    await page.goto(url);
    await page.waitForSelector('[data-testid="space"]');
    return { page, outside, errors, close: () => context.close() };
  } catch (e) {
    await context.close();
    throw e;
  }
}
/** サーバーを起動して、ページを開き、確かめる。途中で失敗しても、ページとサーバーを片付ける */
async function withApp(start, fn, opts) {
  const app = await start();
  let v;
  try {
    v = await open(app.url, opts);
    await fn(v, app);
  } finally {
    if (v) await v.close();
    app.stop();
  }
}
// 端末に残っている「共有データの控えの持ち主」の印（store/sharedSession.ts の CACHE_KEY）。前に、別のビルドでログインしていた端末を模す
const CACHE_KEY = 'kkl_shared_cache_v2';
const SEEDED_MARK = JSON.stringify({ uid: 'uid-someone', token: 'tok-1', used: true });
/** 最初に開いたときに 1 回だけ、印を置く（読み込み直しでは、置き直さない＝アプリが消したら、消えたままになる） */
const seedMark = `if (!sessionStorage.getItem('kkl-guard-seeded')) { localStorage.setItem(${JSON.stringify(CACHE_KEY)}, ${JSON.stringify(SEEDED_MARK)}); sessionStorage.setItem('kkl-guard-seeded', '1'); }`;
const readMark = (page) => page.evaluate((k) => localStorage.getItem(k), CACHE_KEY);
/** 画面から読み取る、いまの状態 */
async function state(page) {
  return page.evaluate(async () => {
    const q = (s) => document.querySelector(s);
    const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).filter(Boolean).sort() : null;
    return {
      team: q('[data-testid="space"]')?.getAttribute('data-team') ?? null,
      badge: q('[data-testid="env-team"]')?.textContent ?? null,
      blocked: q('[data-testid="env-blocked"]')?.getAttribute('data-reason') ?? null,
      blockedText: q('[data-testid="env-blocked"]')?.textContent ?? null,
      signIn: !!q('.auth-signin-btn'),
      head: q('.app__head .sync')?.textContent ?? null,
      // Firebase が端末の中に作る保存領域（ログインの状態・共有データの控え）
      firebaseDbs: dbs ? dbs.filter((n) => /^firebase|^firestore/i.test(n)) : null,
      emulatorHook: '__kkl' in window,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}
/** ログインの状態の確認（「...」の表示）が終わってからの状態。Firebase を起動したアプリは、確認が終わると、ログインのボタンを出す */
async function settled(page) {
  await until(() => page.locator('.auth-loading').count(), (n) => n === 0);
  return state(page);
}
async function loadSample(page) {
  await page.locator('.app__tabs button', { hasText: 'データ' }).first().evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
  await page.locator('.app__tabs button', { hasText: 'データ' }).first().click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).click();
  await page.waitForSelector('text=案件一覧');
}
const projectCount = (page) => page.evaluate(() => {
  const raw = localStorage.getItem('kkl_workshop_v1');
  return raw ? (JSON.parse(raw).projects ?? []).length : 0;
});

// ── 確認項目 ────────────────────────────────────────────────
const scenarios = [];
const add = (id, title, fn) => scenarios.push({ id, title, fn });

// 止めたあとの案内は、ビルドの種類で変わる（本番のビルドに、検証用のチーム名を入れさせない）
const SET = 'VITE_TEAM_ID に、検証用のチーム名（例: kkl-preview）を設定してください';
const FIX = 'VITE_TEAM_ID を、検証用のチーム名（例: kkl-preview）に直してください';
const NOT_IN_PRODUCTION = '本番のビルド（Vercel の Production）でこの表示が出た場合は、VITE_TEAM_ID に、検証用のチーム名を入れないでください';
const REMOVE = 'Production 環境の VITE_TEAM_ID を、消してください';
const STOP_BUILDS = [
  // [名前, 条件, 止める理由, 記録に出る値, 案内に含まれるはずの文, 含まれないはずの文]
  ['preview-unset', { ...REAL, VERCEL_ENV: 'preview' }, 'unset', 'is not set', [SET], [NOT_IN_PRODUCTION, REMOVE]],
  ['preview-default', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: DEFAULT_TEAM }, 'production-team', `= "${DEFAULT_TEAM}"`, [SET], [NOT_IN_PRODUCTION, REMOVE]],
  ['preview-invalid', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: 'kkl preview' }, 'invalid', '= "kkl preview"', [FIX], [NOT_IN_PRODUCTION, REMOVE]],
  ['preview-default-space', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: `${DEFAULT_TEAM} ` }, 'invalid', `= "${DEFAULT_TEAM} "`, [FIX], [NOT_IN_PRODUCTION, REMOVE]],
  ['development-unset', { ...REAL, VERCEL_ENV: 'development' }, 'unset', 'is not set', [SET], [NOT_IN_PRODUCTION, REMOVE]],
  // VERCEL_ENV が渡っていないビルド: Vercel の本番のビルドでも、ここに来うる。検証用のチーム名を入れないよう、案内する
  ['local-unset', { ...REAL }, 'unset', 'is not set', [SET, NOT_IN_PRODUCTION], [REMOVE]],
  ['local-default', { ...REAL, VITE_TEAM_ID: DEFAULT_TEAM }, 'production-team', `= "${DEFAULT_TEAM}"`, [SET, NOT_IN_PRODUCTION], [REMOVE]],
  ['local-invalid', { ...REAL, VITE_TEAM_ID: 'kkl preview' }, 'invalid', '= "kkl preview"', [FIX, NOT_IN_PRODUCTION, REMOVE], []],
  // 本番のビルドで、値が使えない形: 直し方は「消す」（検証用のチーム名を入れると、本番が検証用の場所を指す）
  ['production-invalid', { ...REAL, VERCEL_ENV: 'production', VITE_TEAM_ID: 'KKL/preview' }, 'invalid', '= "KKL/preview"', [REMOVE], [SET, FIX, NOT_IN_PRODUCTION]],
];
const PASS_BUILDS = [
  ['preview-verify', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: VERIFY_TEAM }, ['[kkl] build: preview (VERCEL_ENV=preview), firebase: real', `[kkl] VITE_TEAM_ID=${VERIFY_TEAM}`]],
  ['production-unset', { ...REAL, VERCEL_ENV: 'production' }, ['[kkl] build: production (VERCEL_ENV=production), firebase: real', '[kkl] VITE_TEAM_ID is not set (default team)']],
  ['production-default', { ...REAL, VERCEL_ENV: 'production', VITE_TEAM_ID: DEFAULT_TEAM }, ['[kkl] build: production (VERCEL_ENV=production), firebase: real', `[kkl] VITE_TEAM_ID=${DEFAULT_TEAM} (default team)`]],
  ['none-local', {}, ['[kkl] build: local (VERCEL_ENV is not set), firebase: none', '[kkl] VITE_TEAM_ID is not set (default team)']],
  ['demo-preview', { ...DEMO, VERCEL_ENV: 'preview' }, ['[kkl] build: preview (VERCEL_ENV=preview), firebase: demo', '[kkl] VITE_TEAM_ID is not set (default team)']],
];

add('B1', 'ビルド: 本番ではないビルド × 実際の Firebase で、チーム名が無い・通常のチーム名・使えない形 → 失敗し、配信するものを作らない', async () => {
  const done = await Promise.all(STOP_BUILDS.map(([name, env]) => build(name, env)));
  STOP_BUILDS.forEach(([name, , reason, shown, has, hasNot], i) => {
    const b = done[i];
    ok(b.code !== 0, `${name}: ビルドが失敗すること（終了コード ${b.code}）`);
    eq(b.made, false, `${name}: 配信するもの（index.html）が作られないこと`);
    eq(b.lines[1], `[kkl] VITE_TEAM_ID ${shown} -> STOPPED (${reason})`, `${name}: ビルドの記録`);
    ok(b.out.includes(`Build stopped for safety (${reason})`), `${name}: 止めた理由が、ビルドの出力にあること`);
    ok(!b.lines.some((l) => /^\[kkl\] VITE_TEAM_ID=/.test(l) || l.includes('default team')), `${name}: 「検証用のビルド」「通常のチーム」の行が出ないこと: ${b.lines.join(' | ')}`);
    for (const t of has) ok(b.out.includes(t), `${name}: 案内に「${t}」があること`);
    for (const t of hasNot) ok(!b.out.includes(t), `${name}: 案内に「${t}」が無いこと`);
  });
});

add('B2', 'ビルド: 止めないもの（検証用のチーム名あり・本番のビルド・Firebase の設定なし・自動テストの構成）は、これまでどおり作れて、記録の行も同じ', async () => {
  const done = await Promise.all(PASS_BUILDS.map(([name, env]) => build(name, env)));
  PASS_BUILDS.forEach(([name, , lines], i) => {
    const b = done[i];
    eq(b.code, 0, `${name}: ビルドが成功すること\n${b.out.slice(-600)}`);
    eq(b.made, true, `${name}: 配信するものが作られること`);
    eq(b.lines, lines, `${name}: ビルドの記録`);
  });
});

add('S1', '配信するビルド（検証用）: 検証用の表示が出て、検証用のチーム名を使う。ログインのボタンは出る（＝ Firebase は起動している）', async () => {
  const b = await build('preview-verify', PASS_BUILDS[0][1]);
  eq(b.code, 0, 'ビルド');
  await withApp(() => servePreview(b.dir), async (v) => {
    const s = await settled(v.page);
    eq([s.team, s.badge, s.blocked, s.signIn], [VERIFY_TEAM, `検証用ビルド（共有データの場所: ${VERIFY_TEAM}）`, null, true], 'チーム名・表示・停止の表示・ログインのボタン');
    eq(s.head, 'この端末に保存（未ログイン）', '上部の表示');
    // 対照: Firebase を起動したアプリは、ログインの準備で、外（Google）への通信を試みる（＝ D の「通信が無い」の確かめ方が、働いていること）
    ok(await until(() => v.outside.length, (n) => n > 0) > 0, 'Firebase を起動したアプリは、外への通信を試みること（確かめ方の確認）');
    eq(v.errors, [], 'ブラウザのエラー');
  });
});

add('S2', '配信するビルド（本番）: これまでどおり（検証用の表示・停止の表示が出ない。通常のチーム。ログインのボタンが出る）', async () => {
  const b = await build('production-unset', PASS_BUILDS[1][1]);
  eq(b.code, 0, 'ビルド');
  await withApp(() => servePreview(b.dir), async (v) => {
    const s = await settled(v.page);
    eq([s.team, s.badge, s.blocked, s.signIn], [DEFAULT_TEAM, null, null, true], 'チーム名・表示・停止の表示・ログインのボタン');
    eq(s.head, 'この端末に保存（未ログイン）', '上部の表示');
    ok(await until(() => v.outside.length, (n) => n > 0) > 0, 'Firebase が起動していること（外への通信を試みる）');
    eq(v.errors, [], 'ブラウザのエラー');
  });
});

add('S3', '配信するビルド（Firebase の設定なし）: これまでどおり（ログインのボタンが出ない。停止の表示は出ない）', async () => {
  const b = await build('none-local', PASS_BUILDS[3][1]);
  eq(b.code, 0, 'ビルド');
  await withApp(() => servePreview(b.dir), async (v) => {
    const s = await settled(v.page);
    eq([s.team, s.badge, s.blocked, s.signIn, s.head], [DEFAULT_TEAM, null, null, false, 'この端末に保存（Firebase 未設定）'], 'チーム名・表示・停止の表示・ログインのボタン・上部の表示');
    await sleep(1500);
    eq(v.outside, [], '外への通信');
  });
});

const STOP_APPS = [
  ['D1', 'プレビュー × チーム名なし', { ...REAL, VERCEL_ENV: 'preview' }, 'unset'],
  ['D2', 'プレビュー × 通常のチーム名を指定', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: DEFAULT_TEAM }, 'production-team'],
  ['D3', 'プレビュー × 使えない形のチーム名', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: 'kkl preview' }, 'invalid'],
  ['D4', 'Vercel の外（手元）× チーム名なし', { ...REAL }, 'unset'],
  // 開発サーバーは、本番のビルドではない: VERCEL_ENV=production が付いていても、本番として扱わない（手元の localhost から、本番のデータにつながない）
  ['D6', '開発サーバーに VERCEL_ENV=production が付いている × チーム名なし', { ...REAL, VERCEL_ENV: 'production' }, 'unset'],
];
for (const [id, name, env, reason] of STOP_APPS) {
  add(id, `アプリ（${name}）: 止まる。ログインのボタンが出ない・Firebase を起動しない・外への通信が 0 件・通常のチーム名を使わない。この端末だけのデータは使える`, async () => {
    // 前に、別のビルドでログインしていた端末を模す（共有データの控えの、持ち主の印が残っている）
    await withApp(() => serveDev(env), async (v, app) => {
      const s = await settled(v.page);
      eq([s.team, s.badge, s.blocked, s.signIn], ['__blocked__', null, reason, false], 'チーム名・検証用の表示・停止の理由・ログインのボタン');
      eq(s.head, 'この端末に保存（共有データは停止中）', '上部の表示');
      ok(s.blockedText.includes('本番のデータには、つないでいません'), `停止の表示の文: ${s.blockedText}`);
      eq(s.emulatorHook, false, '自動テスト用の入口が無いこと');
      ok(s.overflow <= 0, `画面が横にはみ出さないこと（${s.overflow}px）`);
      // 開発サーバーの出力: ビルドではないので「ビルドを止めた」とは言わず、アプリが Firebase を起動しないことを知らせる
      ok(app.out().includes(`Firebase is switched off in this dev server (${reason})`), `開発サーバーの出力: ${app.out().slice(0, 400)}`);
      ok(!app.out().includes('Build stopped'), '開発サーバーの出力に「Build stopped」が無いこと');
      // この端末だけのデータは、使える（サンプルを読み込み、開き直しても残る）
      await loadSample(v.page);
      eq(await projectCount(v.page), 2, 'サンプルの案件');
      await v.page.reload();
      await v.page.waitForSelector('[data-testid="space"]');
      eq(await projectCount(v.page), 2, '開き直したあとの案件');
      await sleep(2500);
      const after = await settled(v.page);
      eq([after.signIn, after.blocked, after.team], [false, reason, '__blocked__'], '時間をおいても、ログインのボタンが出ないこと・止まったままであること');
      eq(after.firebaseDbs, [], 'Firebase が端末の中に作る保存領域（無いこと＝起動していない）');
      eq(v.outside, [], '外への通信（Google・Firebase を含めて、0 件）');
      // 控えを消せない（Firebase を起動していない）ので、持ち主の印も消さない（消すと、次に起動したビルドが、前のアカウントの控えを、消さずに使う）
      eq(await readMark(v.page), SEEDED_MARK, '共有データの控えの、持ち主の印（残っていること）');
      eq(v.errors, [], 'ブラウザのエラー');
    }, { init: seedMark });
  });
}

add('D5', 'アプリ（対照。プレビュー × 検証用のチーム名）: 同じ確かめ方で、止まらない（Firebase が起動し、外への通信を試み、保存領域ができ、前のアカウントの控えを消す）', async () => {
  await withApp(() => serveDev({ ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: VERIFY_TEAM }), async (v) => {
    const s = await settled(v.page);
    eq([s.team, s.badge, s.blocked, s.signIn], [VERIFY_TEAM, `検証用ビルド（共有データの場所: ${VERIFY_TEAM}）`, null, true], 'チーム名・表示・停止の表示・ログインのボタン');
    ok(await until(() => v.outside.length, (n) => n > 0) > 0, '外への通信を試みること');
    const dbs = await until(async () => (await state(v.page)).firebaseDbs, (d) => d.length > 0);
    ok(dbs.length > 0, 'Firebase の保存領域ができること');
    // Firebase を起動しているアプリは、ログインしていなければ、前のアカウントの控えを消して、印も消す（＝ D1〜D4・D6 の「印が残る」は、止まっているから）
    eq(await until(() => readMark(v.page), (m) => m === null, 15000), null, '共有データの控えの、持ち主の印（消えること）');
  }, { init: seedMark });
});

// ── 実行 ────────────────────────────────────────────────────
browser = await chromium.launch({ env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8', LC_ALL: process.env.LC_ALL || 'C.UTF-8' } });
const results = [];
try {
  for (const s of scenarios.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').some((p) => x.id.startsWith(p)))) {
    let detail = '';
    try { await s.fn(); } catch (e) { detail = String(e.message ?? e).split('\n').slice(0, 3).join(' '); }
    results.push({ ...s, ok: !detail, detail });
    console.log(`${detail ? '✗' : '✓'} ${s.id} ${s.title}${detail ? `\n      → ${detail}` : ''}`);
  }
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} 項目中 ${results.length - failed.length} 合格／${failed.length} 不合格${failed.length ? `（${failed.map((r) => r.id).join(', ')}）` : ''}`);
process.exit(failed.length ? 1 : 0);
