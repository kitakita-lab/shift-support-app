#!/usr/bin/env node
// Version 4 で追加した確認（実ブラウザ・Chromium）。
//   P … スマホ幅（iPhone 14 相当・タッチ）の表示: はみ出し・入力欄の文字サイズ・下部タブ・カード表示・試算
//   N … 数値入力（タッチで 1 桁だけ直す・全選択して置き換える・全角・勝手に補正しない）
//   J … JCOS 案件の収支（請求と実費の分離・日別・予定と実績・レイアウトとの分離・汎用との行き来）
//   U … 図の近くの「元に戻す」
//   F … PDF・JSON の保存（保存用の URL が、すぐに破棄されない）
//
// 使い方:
//   node e2e/v4.mjs                                   … 開発サーバーを自分で起動して確認
//   BASE_URL=http://127.0.0.1:5173/ node e2e/v4.mjs   … 起動済みのサーバーを確認（以前の版に対して実行すれば、修正前の結果が分かる）
//   ONLY=N node e2e/v4.mjs                            … 記号が N で始まる項目だけ
//
// 確認していないもの（実機でしか分からないもの）: iPhone の Safari そのものの動作
//   （入力欄にフォーカスしたときの自動拡大・下部ツールバーとの重なり・ダウンロードの確認画面・日本語入力の実キー操作）。
//   ここで確かめているのは、Chromium のスマホ表示（タッチの模擬）での動作と、Safari で問題が起きる条件を作っていないこと。
// 日報の同期（ログインが必要）は e2e/sync/report.mjs。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, loadPlaywright } from './playwright.mjs';

// ── 小道具 ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yenNum = (s) => Number(String(s).replace(/−/g, '-').replace(/[^\d.-]/g, ''));
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期待 ${e} ／ 実際 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }
async function until(fn, pred = (v) => !!v, timeout = 4000) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await fn();
    if (pred(v) || Date.now() - t0 > timeout) return v;
    await sleep(60);
  }
}

// ── 画面操作（スマホ幅・PC 幅のどちらでも動くように書く。以前の版の画面でも、開くところまでは動く） ──
const tab = (page, label) => page.locator('.app__tabs button', { hasText: label }).first().click();
const sheet = (page, label) => page.locator('.sheettabs button', { hasText: label }).click();
async function loadSample(page) {
  // 以前の版では、スマホ幅だと「データ」のタブが画面の外にある。画面の中に入れてから押す
  await page.locator('.app__tabs button', { hasText: 'データ' }).first().evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
  await tab(page, 'データ');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).click();
  await page.waitForSelector('text=案件一覧');
}
/** 案件を開く（スマホ幅はカード、PC 幅は表）。what は、案件の行・カードに含まれる文字 */
async function openProject(page, what = '11/13') {
  if (await page.locator('[data-testid="project-cards"]').count()) {
    await page.locator('[data-testid="project-card"]', { hasText: what }).first().locator('.pcard__open').click();
  } else {
    // 以前の版のスマホ幅では「開く」が画面の外（横スクロールの先）にあるため、直接押す
    await page.locator('.grid tbody tr', { hasText: what }).first().locator('button', { hasText: '開く' }).evaluate((b) => b.click());
  }
  await page.waitForSelector('.sheettabs');
}
async function setup(page) { await loadSample(page); await openProject(page); }
const back = (page) => page.getByRole('button', { name: '← 案件一覧' }).click();
const toJcos = (page) => page.locator('[data-testid="calc-mode"] button', { hasText: 'JCOS案件' }).click();
const toGeneric = (page) => page.locator('[data-testid="calc-mode"] button', { hasText: '汎用' }).click();
const headProfit = (page) => page.locator('.pv__profit').innerText().then((t) => t.replace(/\s+/g, ' ').trim());
/** JCOS の試算の数値（請求 計・実費 計・粗利・実績個数・予定だけの粗利・材料費の超過／残り） */
async function jcos(page) {
  await sheet(page, '試算');
  await page.waitForSelector('[data-testid="jcos-view"]');
  const t = (id) => page.locator(`[data-testid="${id}"]`).innerText();
  return {
    billing: yenNum(await t('jcos-billing')), cost: yenNum(await t('jcos-cost')), gross: yenNum(await t('jcos-gross')),
    actual: Number(await t('jcos-actual')), plannedGross: yenNum(await t('jcos-planned-gross')),
    over: yenNum(await t('jcos-over')), overText: (await page.locator('[data-testid="jcos-material"]').innerText()).replace(/\s+/g, ' '),
    basis: await page.locator('[data-testid="jcos-view"]').getAttribute('data-basis'),
  };
}
const dayRow = (page, date) => page.locator(`[data-testid="jcos-day-${date}"]`);
const kv = (page, label) => page.locator('table.kv tr', { hasText: label }).locator('input');
async function type(page, text) { for (const ch of text) await page.keyboard.type(ch); }

// ── 表示の確認 ───────────────────────────────────────────────
/**
 * ページが横にはみ出している量（px）。0 なら、横スクロールなしで全体が画面の幅に収まっている。
 * スマホの表示では、はみ出した中身に合わせてブラウザが「ページの幅」のほうを広げる（そのぶん全体が縮む・固定した部品がずれる）ことがあるので、
 * ページの幅そのもの（innerWidth）ではなく、端末の画面の幅と比べる。
 */
const overflowX = (page) => page.evaluate((w) => Math.max(0, Math.max(document.documentElement.scrollWidth, window.innerWidth) - w), page.viewportSize().width);
/** 文字が 16px 未満の入力欄（iPhone の Safari は、16px 未満の欄にフォーカスすると画面を自動で拡大する） */
const smallInputs = (page) => page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]):not([hidden]), select, textarea')]
  .filter((el) => el.getClientRects().length > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
  .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('data-c') ? `[${el.getAttribute('data-c')}]` : ''}(${getComputedStyle(el).fontSize})`));
/** 要素が、いま見えている画面の中に収まっているか */
async function onScreen(page, locator) {
  const b = await locator.boundingBox();
  const v = page.viewportSize();
  return !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
}
/** 要素を画面の中央あたりに持ってくる（画面上部に固定した見出しの下に隠れた状態で押さないため） */
const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
/** タッチで、要素の右端の近く（数字の末尾あたり）を押す */
async function tapEnd(page, locator) {
  await center(locator);
  const b = await locator.boundingBox();
  await page.touchscreen.tap(b.x + b.width - 8, b.y + b.height / 2);
}
async function tapOn(page, locator) {
  await center(locator);
  const b = await locator.boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

// ── 確認項目 ────────────────────────────────────────────────
const scenarios = [];
const add = (id, title, fn, opts = {}) => scenarios.push({ id, title, fn, opts });
const phone = { phone: true };

// サンプルの案件（ラソラ札幌 11/13〜17・5 日・予定 300 個・その他費用 22,000 円）を JCOS 案件にしたときの値。
// 実装（domain/jcos.ts）を使わずに、条件から計算する
const BILL_DAY = 30000 + 10000, PART = 15000, UNIT = 220, DAYS = 5, PLANNED = 300, OTHER = 22000;
const J0 = { billing: BILL_DAY * DAYS, cost: PART * DAYS + PLANNED * UNIT + OTHER };
J0.gross = J0.billing - J0.cost;                                   // 200,000 − 163,000 ＝ 37,000
const D = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];

// P. スマホ幅の表示 ─────────────────────────────────────────
add('P1', '案件一覧はカードで並び、カード全体を押すと開く（横スクロールなしで開ける）', async ({ page }) => {
  await loadSample(page);
  const cards = page.locator('[data-testid="project-card"]');
  eq(await cards.count(), 2, 'カードの数');
  const card = cards.filter({ hasText: '11/13' });
  ok(await onScreen(page, card.locator('.pcard__open')), '案件のカードが、画面の幅に収まっていません');
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  ok(text.includes('ikyu') && text.includes('ラソラ札幌') && text.includes('11/13(金)〜11/17(火)（5日）') && text.includes('利益 ¥66,850'), `カードの内容: ${text}`);
  // カードの端（名前でも金額でもない場所）を押しても開く
  const b = await card.locator('.pcard__open').boundingBox();
  await page.touchscreen.tap(b.x + b.width - 12, b.y + b.height - 8);
  await page.waitForSelector('.sheettabs');
  eq(await page.locator('.pv__head h2').innerText().then((t) => t.split('\n')[0]), 'ikyu', '開いた案件');
  // カードの「複製」「削除」は、開く操作とは別のボタン
  await back(page);
  await card.getByRole('button', { name: '複製', exact: true }).click();
  eq(await page.locator('[data-testid="project-card"]').count(), 3, '複製後のカードの数');
}, phone);

add('P2', 'どの画面でも、ページが横にはみ出さない（一覧・各マスタ・データ・案件の 4 シート・JCOS の基本情報と試算）', async ({ page }) => {
  // はみ出しは、最後にまとめて報告する（最初の 1 画面で止めず、どの画面がはみ出しているかを全部出す）
  const seen = [];
  const check = async (label) => { await sleep(120); seen.push([label, await overflowX(page)]); };
  await loadSample(page);
  await check('案件一覧');
  for (const t of ['スタッフ', '会場', 'コンテンツ', 'パーツ', 'データ']) { await tab(page, t); await check(`タブ:${t}`); }
  await tab(page, '案件');
  await openProject(page);
  // シートの切り替えは、直接押す（はみ出した画面では、下のタブが画面の外に出て押せないことがある。押せるかどうかは P4 で確かめる）
  const go = (label) => page.locator('.sheettabs button', { hasText: label }).evaluate((b) => b.click());
  for (const s of ['基本情報', 'スタッフ配置', 'レイアウト', '試算']) { await go(s); await check(`シート:${s}`); }
  await go('基本情報');
  await page.locator('.warnbtn').evaluate((b) => b.click());
  await check('基本情報＋警告欄');
  if (await page.locator('[data-testid="calc-mode"]').count()) {
    await toJcos(page);
    await check('基本情報（JCOS）');
    await go('試算');
    await check('試算（JCOS）');
  }
  const bad = seen.filter(([, o]) => o > 0);
  ok(bad.length === 0, `ページが横にはみ出している画面: ${bad.map(([l, o]) => `${l}（${o}px）`).join('、')}`);
  eq(seen.length, 13, '確認した画面の数');
}, phone);

add('P3', 'タッチ端末では、入力欄の文字が 16px 以上（iPhone の Safari が、入力時に画面を自動で拡大する条件を作らない）', async ({ page }) => {
  const check = async (label) => { const small = await smallInputs(page); ok(small.length === 0, `「${label}」に 16px 未満の入力欄があります: ${small.slice(0, 5).join('、')}`); };
  await loadSample(page);
  for (const t of ['スタッフ', '会場', 'コンテンツ', 'パーツ']) { await tab(page, t); await check(`タブ:${t}`); }
  await tab(page, '案件');
  await openProject(page);
  for (const s of ['基本情報', 'スタッフ配置', 'レイアウト']) { await sheet(page, s); await check(`シート:${s}`); }
  await page.getByRole('button', { name: '周辺環境（雛形）' }).click();
  await check('レイアウト（周辺環境）');
  await sheet(page, '基本情報');
  await toJcos(page);
  await check('基本情報（JCOS）');
  await sheet(page, '試算');
  await check('試算（JCOS）');
  // 入力欄が実際にあること（何も無い画面を見て合格にしない）
  ok((await page.locator('[data-testid="jcos-days"] input').count()) >= 5, '日別の表に入力欄がありません');
}, phone);

add('P4', '下のシートタブは、どのシートでも画面の中にあり、タッチで切り替えられる。上のタブ（データまで）も横スクロールなしで見える', async ({ page }) => {
  await loadSample(page);
  for (const t of ['案件', 'スタッフ', '会場', 'コンテンツ', 'パーツ', 'データ']) {
    ok(await onScreen(page, page.locator('.app__tabs button', { hasText: t }).first()), `上のタブ「${t}」が画面の外にあります`);
  }
  await openProject(page);
  const order = ['試算', 'レイアウト', 'スタッフ配置', '基本情報', '試算'];
  for (const s of order) {
    for (const name of ['基本情報', 'スタッフ配置', 'レイアウト', '試算']) {
      ok(await onScreen(page, page.locator('.sheettabs button', { hasText: name })), `下のタブ「${name}」が画面の外にあります（切り替え先: ${s}）`);
    }
    const b = await page.locator('.sheettabs button', { hasText: s }).boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForSelector(`.sheettabs button.is-on:has-text("${s}")`);
    // ページの下までスクロールしても、タブは画面の下に固定されたまま
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(120);
    ok(await onScreen(page, page.locator('.sheettabs')), `「${s}」を下までスクロールすると、下のタブが画面の外に出ます`);
    ok((await page.locator('.sheettabs button').first().boundingBox()).height >= 40, '下のタブの高さが 40px 未満です（タッチで押しにくい）');
  }
}, phone);

add('P5', '試算（汎用）は、主要な数値が横スクロールなしで読める。計算式は項目名の下に出る。明細の表は、表の中だけで横に動く', async ({ page }) => {
  await setup(page);
  await sheet(page, '試算');
  const row = (label) => page.locator('.est__summary tbody tr', { hasText: label }).first();
  for (const [label, value] of [['売上 計', '¥400,000'], ['費用 計', '¥333,150'], ['利益', '¥66,850']]) {
    const cell = row(label).locator('td').nth(1);
    eq((await cell.innerText()).trim(), value, label);
    await cell.scrollIntoViewIfNeeded();
    const b = await cell.boundingBox();
    ok(b.x >= 0 && b.x + b.width <= page.viewportSize().width + 0.5, `「${label}」の金額が、画面の幅に収まっていません`);
  }
  // 計算式（3 列目）は隠し、項目名の下に出している
  eq(await row('材料費').locator('td').nth(2).isVisible(), false, '計算式の列');
  const shown = await row('材料費').locator('.est__label').evaluate((el) => getComputedStyle(el, '::after').content);
  ok(shown.includes('予定個数') && shown.includes('材料原価'), `項目名の下の計算式: ${shown}`);
  // 明細の表（人件費の内訳）は、はみ出すぶんを表の中でスクロールする（ページは動かない）
  const wrap = page.locator('.est .grid-wrap').first();
  ok(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth), '人件費の内訳が、表の中でスクロールできる状態になっていません');
  eq(await overflowX(page), 0, 'ページの横はみ出し');
}, phone);

add('P6', 'PC の幅でも、試算のまとめの表がページからはみ出さない（幅 1,000px）', async ({ page }) => {
  await setup(page);
  await sheet(page, '試算');
  eq(await overflowX(page), 0, 'ページの横はみ出し');
  ok(await page.locator('.est__summary tbody tr', { hasText: '材料費' }).first().locator('td').nth(2).isVisible(), 'PC の幅では、計算式の列が見えるはずです');
  // PC の幅では、一覧は表のまま（案件名を押しても開ける）
  await back(page);
  eq(await page.locator('[data-testid="project-cards"]').count(), 0, 'PC の幅でのカード表示');
  await page.locator('.grid tbody tr', { hasText: '11/13' }).locator('.grid__link').click();
  await page.waitForSelector('.sheettabs');
}, { viewport: { width: 1000, height: 800 } });

// N. 数値入力 ──────────────────────────────────────────────
add('N1', 'タッチで欄に触れて、末尾の 1 桁だけを消して打ち直せる（321 → 末尾の 1 を消して 0 → 320。以前は 0 になった）', async ({ page }) => {
  await setup(page);
  const count = page.locator('[data-c="plannedCount"]').first();
  await tapEnd(page, count);
  await page.keyboard.press('Control+A');
  await type(page, '321');
  eq(await count.inputValue(), '321', '321 と入力');
  ok((await headProfit(page)).includes('¥60,035'), `321 個のときの利益: ${await headProfit(page)}`);
  await tapOn(page, page.locator('h3', { hasText: '実施コンテンツ' }));        // いったん欄の外に触れる
  await tapEnd(page, count);                                                 // もう一度、欄に触れる
  await page.keyboard.press('Backspace');
  eq(await count.inputValue(), '32', '削除キーを 1 回押したあと');
  await type(page, '0');
  eq(await count.inputValue(), '320', '0 を打ったあと');
  ok((await headProfit(page)).includes('¥60,360'), `320 個のときの利益: ${await headProfit(page)}`);
  await tapOn(page, page.locator('h3', { hasText: '実施コンテンツ' }));
  eq(await count.inputValue(), '320', '欄を離れたあと');
}, phone);

add('N2', 'タッチで欄に触れても、全選択にならない。全選択してから打てば、置き換わる', async ({ page }) => {
  await setup(page);
  const count = page.locator('[data-c="plannedCount"]').first();
  await tapEnd(page, count);
  eq(await count.evaluate((el) => [el.selectionStart, el.selectionEnd]), [3, 3], '触れた直後の選択範囲（末尾にカーソル）');
  await type(page, '5');
  eq(await count.inputValue(), '3005', '触れてそのまま打つと、追記になる');
  await page.keyboard.press('Control+A');
  await type(page, '250');
  eq(await count.inputValue(), '250', '全選択して打つと、置き換わる');
  // 数字のキーボードが開く指定になっている
  eq(await count.evaluate((el) => [el.type, el.inputMode]), ['text', 'decimal'], '入力欄の種類');
}, phone);

add('N3', '打っている途中の文字は、勝手に確定・補正されない。全角で打った数字・桁区切りも受け取る', async ({ page }) => {
  await setup(page);
  const fixed = kv(page, '固定売上');
  await tapEnd(page, fixed);
  await page.keyboard.press('Control+A');
  await type(page, '0120');
  eq(await fixed.inputValue(), '0120', '先頭の 0 は、打っている間は消えない');
  await page.keyboard.press('Control+A');
  await type(page, '12.');
  eq(await fixed.inputValue(), '12.', '小数点を打った直後');
  await type(page, '5');
  eq(await fixed.inputValue(), '12.5', '小数');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('４０００００');                              // 全角（日本語入力のまま打った数字）
  eq(await fixed.inputValue(), '400000', '全角の数字');
  ok((await headProfit(page)).includes('¥66,850'), `全角で 400000 と打ったあとの利益: ${await headProfit(page)}`);
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('1,234,567円');
  eq(await fixed.inputValue(), '1234567', '桁区切り・単位つき');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('abc');
  eq(await fixed.inputValue(), '', '数字でない文字');
  await tapOn(page, page.locator('h3', { hasText: '実施コンテンツ' }));
  eq(await fixed.inputValue(), '0', '空欄で離れると 0');
}, phone);

add('N4', '日本語入力の変換中は、打ったままの文字を見せ、確定したときに数値にする（変換の途中で書き換えない）', async ({ page }) => {
  await setup(page);
  const fixed = kv(page, '固定売上');
  await tapEnd(page, fixed);
  await page.keyboard.press('Control+A');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '５', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '５０', selectionStart: 2, selectionEnd: 2 });
  eq(await fixed.inputValue(), '５０', '変換中（確定前）は、打ったままの全角');
  await cdp.send('Input.insertText', { text: '５０' });                        // 確定
  eq(await until(() => fixed.inputValue(), (v) => v === '50'), '50', '確定後は半角の数値');
  ok((await until(() => headProfit(page), (t) => t.includes('−') || t.includes('-'))).length > 0, '確定した値が試算に反映されていません');
}, phone);

add('N5', 'PC（マウス）では、これまでどおり、クリックして打つと数字が置き換わる', async ({ page }) => {
  await setup(page);
  const count = page.locator('[data-c="plannedCount"]').first();
  await count.click();
  await type(page, '320');
  eq(await count.inputValue(), '320', 'クリックして打った値');
  ok((await headProfit(page)).includes('¥60,360'), `利益: ${await headProfit(page)}`);
});

// J. JCOS 案件の収支 ─────────────────────────────────────────
add('J1', '収支の計算方法を JCOS 案件にすると、請求と実費を分けた粗利になる（請求 200,000 − 実費 163,000 ＝ 37,000）', async ({ page }) => {
  await setup(page);
  ok((await headProfit(page)) === '利益 ¥66,850', `切り替え前: ${await headProfit(page)}`);
  await toJcos(page);
  eq(await headProfit(page), `粗利（管理上） ¥${J0.gross.toLocaleString('ja-JP')}`, '見出しの表示');
  eq([await kv(page, '請求：人件費').inputValue(), await kv(page, '請求：材料費').inputValue(), await kv(page, '支払い：アルバイト代').inputValue(), await kv(page, '支払い：材料原価').inputValue()],
    ['30000', '10000', '15000', '220'], 'JCOS の条件の初期値');
  eq(await page.locator('table.kv tr', { hasText: '固定売上' }).count(), 0, 'JCOS 案件では、固定売上の欄を出さない');
  const j = await jcos(page);
  eq([j.billing, j.cost, j.gross, j.basis, j.actual], [J0.billing, J0.cost, J0.gross, 'planned', 0], '請求・実費・粗利');
  eq(j.over, PLANNED * UNIT - 10000 * DAYS, '材料費の超過（原価 66,000 − 請求 50,000）');
  // 計算に入れていない汎用の項目が、金額つきで出ている（黙って落とさない）
  const ex = (await page.locator('[data-testid="jcos-excluded"]').innerText()).replace(/\s+/g, ' ');
  for (const s of ['固定売上：¥400,000', 'スタッフ配置の人件費（時給・交通費）：¥84,800', 'コンテンツの材料マスタによる材料費：¥97,350', '会場費：¥100,000', '備品費（レイアウト連動）：¥29,000']) {
    ok(ex.includes(s), `「この計算に入れていない項目」に「${s}」がありません: ${ex}`);
  }
  // 一覧にも粗利で出る
  await back(page);
  const row = (await page.locator('.grid tbody tr', { hasText: '11/13' }).innerText()).replace(/\s+/g, ' ');
  ok(row.includes('¥200,000') && row.includes('¥163,000') && row.includes('¥37,000（粗利）'), `一覧の行: ${row}`);
});

add('J2', '汎用に戻すと元の試算に戻り、JCOS に戻すと前の JCOS の条件に戻る（どちらの入力値も消えない）', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await kv(page, '支払い：材料原価').fill('250');
  await sheet(page, '試算');
  await dayRow(page, D[0]).locator('input[aria-label*="実績個数"]').fill('80');
  const before = await jcos(page);
  await sheet(page, '基本情報');
  await toGeneric(page);
  eq(await headProfit(page), '利益 ¥66,850', '汎用に戻したあと');
  eq(await kv(page, '固定売上').inputValue(), '400000', '固定売上（消えていない）');
  await sheet(page, '試算');
  eq(await page.locator('[data-testid="jcos-view"]').count(), 0, '汎用では JCOS の表示を出さない');
  eq((await page.locator('.est__summary tbody tr', { hasText: '利益' }).first().locator('td').nth(1).innerText()).trim(), '¥66,850', '汎用の試算の利益');
  eq(await page.locator('[data-testid="report-bar"]').count(), 0, '汎用では日報の同期の帯を出さない');
  await sheet(page, '基本情報');
  await toJcos(page);
  eq(await kv(page, '支払い：材料原価').inputValue(), '250', '材料原価（前の値に戻る）');
  eq(await jcos(page), before, 'JCOS に戻したあとの収支');
});

add('J3', 'レイアウトで椅子・テーブルを増やしても、JCOS 案件の粗利は変わらない（汎用の案件では、備品費のぶん利益が変わる）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  eq(await headProfit(page), '利益 ¥66,350', '汎用: 椅子を 1 脚増やすと、利益が 500 円下がる');
  await sheet(page, '基本情報');
  await toJcos(page);
  const g0 = await headProfit(page);
  eq(g0, `粗利（管理上） ¥${J0.gross.toLocaleString('ja-JP')}`, 'JCOS: 椅子を増やした状態でも、粗利は条件どおり');
  await sheet(page, 'レイアウト');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  await page.getByRole('button', { name: 'テーブル 150×60を増やす' }).click();
  await page.getByRole('button', { name: '登録スペース（パーテーション区画）を増やす' }).click();
  await page.getByRole('button', { name: '椅子（その他）を減らす' }).click();
  eq(await headProfit(page), g0, 'JCOS: パーツを増減したあとの粗利');
  const j = await jcos(page);
  eq([j.billing, j.cost, j.gross], [J0.billing, J0.cost, J0.gross], 'JCOS: 請求・実費・粗利');
});

add('J4', '請求する日と、アルバイトが稼働する日は、別々に変えられる（請求対象日数とアルバイト稼働日数を混同しない）', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await sheet(page, '試算');
  await dayRow(page, D[2]).locator('input[type=checkbox]').uncheck();                          // 11/15 は請求しない
  let j = await jcos(page);
  eq([j.billing, j.cost], [BILL_DAY * 4, J0.cost], '請求しない日を作ると、請求だけが 1 日ぶん減る（実費は同じ）');
  await dayRow(page, D[0]).getByRole('button', { name: /アルバイトを減らす/ }).click();          // 11/13 はアルバイトなし
  await dayRow(page, D[1]).getByRole('button', { name: /アルバイトを増やす/ }).click();          // 11/14 は 2 人
  await dayRow(page, D[1]).getByRole('button', { name: /アルバイトを増やす/ }).click();          // 11/14 は 3 人
  j = await jcos(page);
  const partDays = 0 + 3 + 1 + 1 + 1;
  eq([j.billing, j.cost], [BILL_DAY * 4, PART * partDays + PLANNED * UNIT + OTHER], 'アルバイトの人数を変えると、実費だけが変わる（請求は同じ）');
  const cards = (await page.locator('.cards').innerText()).replace(/\s+/g, ' ');
  ok(cards.includes('請求 4 日／会期 5 日') && cards.includes(`アルバイト ${partDays} 人日`), `日数の表示: ${cards}`);
  // 日別の粗利: 11/13 ＝ 請求 40,000 − アルバイト 0 − 材料 60×220 ／ 11/15 ＝ 請求 0 − 15,000 − 13,200
  const gross = async (d) => yenNum((await dayRow(page, d).locator('td[data-label="粗利"]').innerText()).split(/\s/)[0]);
  eq([await gross(D[0]), await gross(D[1]), await gross(D[2])], [BILL_DAY - 60 * UNIT, BILL_DAY - 3 * PART - 60 * UNIT, -PART - 60 * UNIT], '日別の粗利');
  // 再読み込みしても残る
  await page.reload();
  await openProject(page);
  eq(await jcos(page), j, '再読み込み後');
});

add('J5', '実績個数を入れた日は実績、入れていない日は予定で計算する。予定だけの粗利は別に出る。消すと予定に戻る', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await sheet(page, '試算');
  const manual = (d) => dayRow(page, d).locator('input[aria-label*="実績個数"]');
  await manual(D[0]).fill('80');
  await manual(D[1]).fill('40');
  let j = await jcos(page);
  const count = 80 + 40 + 60 * 3;
  eq([j.basis, j.actual, j.cost, j.gross], ['mixed', 120, PART * DAYS + count * UNIT + OTHER, J0.billing - (PART * DAYS + count * UNIT + OTHER)], '実績 2 日 ＋ 予定 3 日');
  eq(j.plannedGross, J0.gross, '予定だけで計算した粗利は、実績を入れても変わらない');
  eq([await dayRow(page, D[0]).getAttribute('data-basis'), await dayRow(page, D[2]).getAttribute('data-basis')], ['actual', 'planned'], '日ごとの計算のもと');
  ok((await dayRow(page, D[0]).locator('td[data-label="材料原価"]').innerText()).replace(/\s+/g, ' ').includes(`超過 ¥${(80 * UNIT - 10000).toLocaleString('ja-JP')}`), '11/13 の材料費の超過（80 個 × 220 − 10,000 ＝ 7,600）');
  ok(!(await dayRow(page, D[1]).locator('td[data-label="材料原価"]').innerText()).includes('超過'), '11/14（40 個＝8,800 円）は超過なし');
  ok((await page.locator('[data-testid="jcos-basis"]').innerText()).includes('実績 2 日分（120 個）＋ 残り 3 日は予定個数で計算'), `計算のもとの表示: ${await page.locator('[data-testid="jcos-basis"]').innerText()}`);
  // 0 個も実績（未入力とは区別する）
  await manual(D[2]).fill('0');
  j = await jcos(page);
  eq([j.actual, j.basis, j.cost], [120, 'mixed', PART * DAYS + (80 + 40 + 0 + 120) * UNIT + OTHER], '0 個の実績');
  // 消すと予定に戻る
  for (const d of [D[0], D[1], D[2]]) await manual(d).fill('');
  j = await jcos(page);
  eq([j.basis, j.actual, j.gross], ['planned', 0, J0.gross], '実績を消したあと');
});

add('J6', '単価・追加の請求（予備費）・その他実費は、案件ごとに変えられ、収支に反映される', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await kv(page, '請求：人件費').fill('35000');
  await kv(page, '請求：材料費').fill('12000');
  await kv(page, '支払い：アルバイト代').fill('16000');
  await kv(page, '支払い：材料原価').fill('250');
  await page.getByRole('button', { name: '＋ 請求を追加' }).click();
  const extra = page.locator('h3:has-text("追加の請求") + .grid-wrap');
  await extra.locator('[data-c="name"]').fill('予備費');
  await extra.locator('[data-c="amount"]').fill('20000');
  const other = page.locator('h3:has-text("その他実費") + .grid-wrap');
  await other.getByRole('button', { name: '＋ 費目を追加' }).click();
  await other.locator('[data-c="name"]').last().fill('追加レンタル（椅子）');
  await other.locator('[data-c="amount"]').last().fill('8000');
  const j = await jcos(page);
  const billing = (35000 + 12000) * DAYS + 20000;
  const cost = 16000 * DAYS + PLANNED * 250 + OTHER + 8000;
  eq([j.billing, j.cost, j.gross], [billing, cost, billing - cost], '変更後の請求・実費・粗利');
  // ほかの案件（デモ）には影響しない
  await back(page);
  const demo = (await page.locator('.grid tbody tr', { hasText: '12/5' }).innerText()).replace(/\s+/g, ' ');
  ok(demo.includes('¥11,260') && !demo.includes('（粗利）'), `デモ案件（汎用）の行: ${demo}`);
});

add('J7', 'JCOS 案件を複製すると、条件（単価・追加の請求）は引き継ぎ、実績と日ごとの設定は引き継がない', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await kv(page, '支払い：材料原価').fill('250');
  await sheet(page, '試算');
  await dayRow(page, D[0]).locator('input[aria-label*="実績個数"]').fill('99');
  await dayRow(page, D[1]).locator('input[type=checkbox]').uncheck();
  await back(page);
  await page.locator('.grid tbody tr', { hasText: '11/13' }).getByRole('button', { name: '複製', exact: true }).click();
  await page.locator('.grid tbody tr', { hasText: 'ikyu（コピー）' }).getByRole('button', { name: '開く', exact: true }).click();
  await page.waitForSelector('.sheettabs');
  eq(await kv(page, '支払い：材料原価').inputValue(), '250', '複製先の材料原価');
  const j = await jcos(page);
  eq([j.basis, j.actual, j.billing, j.cost], ['planned', 0, J0.billing, PART * DAYS + PLANNED * 250 + OTHER], '複製先の収支（実績なし・全日請求）');
});

add('J8', 'ログインしていないときは、日報の同期のボタンを出さず、手入力できることを案内する', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  const bar = page.locator('[data-testid="report-bar"]');
  ok((await bar.innerText()).includes('実績個数は、試算の「日別」の表に手入力もできます'), `案内: ${await bar.innerText()}`);
  eq(await page.locator('[data-testid="report-sync"]').count(), 0, '同期のボタン');
});

// U. 図の近くの「元に戻す」 ─────────────────────────────────────
add('U1', '図を操作している位置から、すぐに元に戻せる（上部のツールバーが見えていないとき、右下に「元に戻す」が出る。下のタブとは重ならない）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const fab = page.locator('[data-testid="undo-fab"] button');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(250);
  eq(await page.locator('[data-testid="undo-fab"]').count(), 0, '上部のツールバーが見えている間は、出さない');
  const label = page.locator('svg.layout-svg tspan', { hasText: /^商談席1$/ });
  await label.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await fab.waitFor();
  ok(await fab.isDisabled(), 'まだ何も変えていないので、押せない状態のはずです');
  // 下のシートタブ・画面の端と重ならない
  const f = await fab.boundingBox(), t = await page.locator('.sheettabs').boundingBox(), v = page.viewportSize();
  ok(f.y + f.height <= t.y, `「元に戻す」が下のタブと重なっています（ボタンの下端 ${Math.round(f.y + f.height)} ／ タブの上端 ${Math.round(t.y)}）`);
  ok(f.x >= 0 && f.x + f.width <= v.width && f.height >= 44, '「元に戻す」が画面からはみ出している、または小さすぎます');
  // タッチでパーツを動かして、その場で元に戻す
  const pos = async () => { const s = await page.locator('svg.layout-svg').boundingBox(); const b = await label.boundingBox(); return [Math.round(b.x - s.x), Math.round(b.y - s.y)]; };
  const p0 = await pos();
  const b = await label.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = (kind, x, y) => cdp.send('Input.dispatchTouchEvent', { type: kind, touchPoints: kind === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', b.x + 3, b.y + 3);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', b.x + 3 + i * 4, b.y + 3 + i * 3); await sleep(16); }
  await touch('touchEnd');
  const p1 = await until(pos, (p) => Math.abs(p[0] - p0[0]) > 10);
  ok(Math.abs(p1[0] - p0[0]) > 10, `タッチのドラッグでパーツが動いていません（${p0} → ${p1}）`);
  const y0 = await page.evaluate(() => window.scrollY);
  const top0 = (await page.locator('svg.layout-svg').boundingBox()).y;
  ok(await fab.isEnabled(), '変更したあとは、押せるはずです');
  // 指を離してからボタンに触れるまでの間（人の操作では 0.2 秒以上あく）。間を置かずに触れると、ブラウザが「なぞった勢いを止めるタップ」と
  // みなして、押したことにならない（Chromium の模擬タッチで確認。0.05 秒あければ押せる）
  await sleep(200);
  const fb = await fab.boundingBox();
  await page.touchscreen.tap(fb.x + fb.width / 2, fb.y + fb.height / 2);
  eq(await until(pos, (p) => p[0] === p0[0] && p[1] === p0[1]), p0, '「元に戻す」を押したあとの位置');
  ok(Math.abs((await page.evaluate(() => window.scrollY)) - y0) < 5, '「元に戻す」を押しても、画面の位置は動かない（上までスクロールしない）');
  ok(Math.abs((await page.locator('svg.layout-svg').boundingBox()).y - top0) < 2, '「元に戻す」を押しても、図は画面の中で上下に動かない');
  // 「選択中のパーツ」は図の下にある（パーツを選んでも、図が押し下げられない）
  const figure = await page.locator('.editor__canvas').boundingBox(), selPanel = await page.locator('.panel--sel').boundingBox();
  ok(selPanel.y >= figure.y + figure.height - 1, '狭い画面では、「選択中のパーツ」の欄は図の下に置くはずです');
  ok(await fab.isDisabled(), '戻しきったので、押せない状態に戻るはずです');
}, phone);

add('U2', '会場の雛形の編集でも、図の近くで元に戻せる（下のタブが無い画面では、画面の下端に出る）', async ({ page }) => {
  await loadSample(page);
  await tab(page, '会場');
  await page.getByRole('button', { name: '雛形を編集' }).click();
  await page.getByRole('button', { name: '＋ 通路' }).click();
  const n = () => page.locator('.editor__envgrid tbody tr').count();
  const before = await n();
  await page.locator('svg.layout-svg').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const fab = page.locator('[data-testid="undo-fab"] button');
  await fab.waitFor();
  const f = await fab.boundingBox();
  await page.touchscreen.tap(f.x + f.width / 2, f.y + f.height / 2);
  eq(await until(n, (c) => c === before - 1), before - 1, '元に戻したあとの、周辺環境の数');
}, phone);

// F. 保存 ────────────────────────────────────────────────
/** 保存用に作られた URL（blob:）を記録する */
const TRACK_BLOBS = () => {
  window.__blobs = [];
  const make = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = make(b); window.__blobs.push({ url: u, type: b.type, size: b.size, at: Date.now() }); return u; };
};
/** 保存用の URL が、まだ読めるか */
const alive = (page, type) => page.evaluate(async (type) => {
  const b = window.__blobs.filter((x) => x.type === type).pop();
  if (!b) return 'URL が作られていません';
  try { const r = await fetch(b.url); return r.ok ? (await r.blob()).size === b.size : false; } catch { return false; }
}, type);
async function saved(dl) {
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}

add('F1', 'JSON バックアップを保存できる。保存用の URL は、3 秒たっても破棄されていない（以前は 1 秒で破棄していた）', async ({ page }) => {
  await loadSample(page);
  await tab(page, 'データ');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'バックアップを保存（JSON）' }).click()]);
  ok(/^workshop-planner-backup-この端末-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), `保存名: ${dl.suggestedFilename()}`);
  const json = JSON.parse((await saved(dl)).toString('utf8'));
  eq([json.projects.length, json.venues.length, json.staff.length], [2, 1, 3], 'バックアップの中身（案件・会場・スタッフの数）');
  await sleep(3000);
  eq(await alive(page, 'application/json'), true, '3 秒後に、保存用の URL を読めるか');
}, { ...phone, init: TRACK_BLOBS });

add('F2', '配置図の PDF を保存できる。保存用の URL は、3 秒たっても破棄されていない', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /PDF ダウンロード/ }).click()]);
  eq(dl.suggestedFilename(), 'ikyu_ラソラ札幌_20261113_イベント配置図_V1.pdf', '保存名');
  const bytes = await saved(dl);
  ok(bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 50000, `PDF の中身（${bytes.length} バイト）`);
  await page.waitForFunction(() => !document.querySelector('.toolbar button.primary')?.disabled);
  await sleep(3000);
  eq(await alive(page, 'application/pdf'), true, '3 秒後に、保存用の URL を読めるか');
  ok((await page.locator('[data-testid="version-state"]').getAttribute('data-status')) === 'issued', '出力後は「出力済み」になる');
}, { ...phone, init: TRACK_BLOBS });

add('F3', 'JCOS の条件・手入力の実績を含むバックアップを復元すると、同じ収支に戻る', async ({ page }) => {
  await setup(page);
  await toJcos(page);
  await sheet(page, '試算');
  await dayRow(page, D[0]).locator('input[aria-label*="実績個数"]').fill('77');
  const before = await jcos(page);
  await tab(page, 'データ');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'バックアップを保存（JSON）' }).click()]);
  const file = await saved(dl);
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).click();     // いったんサンプルで上書き（JCOS の設定が消える）
  await openProject(page);
  eq(await headProfit(page), '利益 ¥66,850', '上書き後は汎用');
  await tab(page, 'データ');
  await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: file });
  await page.waitForSelector('text=案件一覧');
  await openProject(page);
  eq(await jcos(page), before, '復元後の収支');
});

// ── 実行 ────────────────────────────────────────────────────
async function startServer() {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL, stop: () => {} };
  const port = 5180 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) return { base, stop: () => child.kill() }; } catch { /* まだ起動中 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error('開発サーバーを起動できませんでした（npm install は済んでいますか？）');
}

const { chromium, devices } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch({ env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8', LC_ALL: process.env.LC_ALL || 'C.UTF-8' } });
const results = [];
try {
  for (const s of scenarios.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').some((p) => x.id.startsWith(p)))) {
    const base = { timezoneId: 'Asia/Tokyo', locale: 'ja-JP', acceptDownloads: true };
    // スマホ: iPhone 14 相当（幅 390px・タッチ）。それ以外: PC の幅
    const context = await browser.newContext(s.opts.phone ? { ...devices['iPhone 14'], ...base } : { viewport: s.opts.viewport ?? { width: 1440, height: 950 }, ...base });
    if (s.opts.init) await context.addInitScript(s.opts.init);
    const page = await context.newPage();
    const errors = [];
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.setDefaultTimeout(8000);
    let detail = '';
    try {
      await page.goto(server.base);
      await s.fn({ page });
      if (errors.length) throw new Error(`ブラウザのエラー: ${errors[0]}`);
    } catch (e) {
      detail = String(e.message ?? e).split('\n')[0];
    }
    results.push({ ...s, ok: !detail, detail });
    console.log(`${detail ? '✗' : '✓'} ${s.id} ${s.title}${detail ? `\n      → ${detail}` : ''}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} 項目中 ${results.length - failed.length} 合格／${failed.length} 不合格${failed.length ? `（${failed.map((r) => r.id).join(', ')}）` : ''}`);
process.exit(failed.length ? 1 : 0);
