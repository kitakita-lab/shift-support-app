#!/usr/bin/env node
// 実ブラウザ（Chromium）での動作確認。`npm test`（計算・警告・版数などの単体テスト）では確かめられない、
// 「画面で実際に操作したときの挙動」を自動操作で確認する。実機確認の前の先回り検証用。
//
// 使い方:
//   node e2e/verify.mjs                                   … 開発サーバーを自分で起動して確認
//   BASE_URL=http://127.0.0.1:5173/ node e2e/verify.mjs   … 起動済みのサーバーを確認
//   ONLY=E node e2e/verify.mjs                            … 記号が E で始まる項目だけ
//
// 必要なもの: playwright と Chromium（このリポジトリの依存には入れていない）。
//   見つからない場合は `npm i -D playwright && npx playwright install chromium`、
//   または PLAYWRIGHT_PATH=<playwright の入った node_modules> を指定する。
// 確認していないもの: Firebase へのログインと同期、Safari / iPhone / iPad、日本語入力（IME）の実キー操作。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, loadPlaywright } from './playwright.mjs';

// ── 小道具 ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yenNum = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期待 ${e} ／ 実際 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }
/** 条件が満たされるまで待つ（最大 4 秒）。最後の値を返す */
async function until(fn, pred = (v) => !!v, timeout = 4000) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await fn();
    if (pred(v) || Date.now() - t0 > timeout) return v;
    await sleep(60);
  }
}

// ── 画面操作 ────────────────────────────────────────────────
const tab = (page, label) => page.locator('.app__tabs button', { hasText: label }).click();
const sheet = (page, label) => page.locator('.sheettabs button', { hasText: label }).click();
async function loadSample(page) {
  await tab(page, 'データ');
  await page.getByRole('button', { name: 'サンプルデータを読み込む' }).click();
  await page.waitForSelector('text=案件一覧');
}
/** ラソラ札幌 11/13〜17 の案件を開く。無ければ（V1 など）先頭の案件を開く */
async function openTarget(page) {
  const lasora = page.locator('.grid tbody tr', { hasText: '11/13' });
  const isLasora = (await lasora.count()) > 0;
  await (isLasora ? lasora.first() : page.locator('.grid tbody tr').first()).getByRole('button', { name: '開く' }).click();
  await page.waitForSelector('.sheettabs');
  return isLasora;
}
async function setup(page) { await loadSample(page); return openTarget(page); }
/** 試算サマリーを { 項目名: 金額 } で読む */
async function readEstimate(page) {
  await sheet(page, '試算');
  const rows = await page.locator('.est__summary tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
  const out = {};
  for (const [label, value] of rows) out[label.replace(/（.*$/, '')] = value;
  return out;
}
const warnCount = async (page) => Number(/警告 (\d+)件/.exec(await page.locator('.warnbtn').innerText())[1]);
const versionText = (page) => page.locator('.toolbar__ver').innerText().then((t) => t.replace(/\s+/g, ' '));
const partCount = async (page, id) => Number(await page.locator(`[data-testid="count-${id}"]`).innerText());
const issuedText = async (page) => ((await page.locator('.panel__hint', { hasText: '出力履歴' }).count()) ? page.locator('.panel__hint', { hasText: '出力履歴' }).innerText() : '');
const labelsOnFigure = (page) => page.locator('svg.layout-svg tspan').allTextContents();
async function clickAt(page, locator, frac) {
  const b = await locator.boundingBox();
  await page.mouse.click(b.x + b.width * frac, b.y + b.height / 2);
}
async function type(page, text) { for (const ch of text) await page.keyboard.type(ch); }
async function exportPdf(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /PDF ダウンロード/ }).click()]);
  const stream = await dl.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  await page.waitForFunction(() => !document.querySelector('.toolbar button.primary')?.disabled);
  return { name: dl.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

// ── 確認項目 ────────────────────────────────────────────────
const scenarios = [];
const add = (id, title, fn, opts = {}) => scenarios.push({ id, title, fn, opts });

// A. サンプルと試算
add('A1', 'サンプルを読み込むと、ラソラ札幌 11/13〜17 の案件が警告 0 件で開き、試算が期待値どおり', async ({ page }) => {
  await loadSample(page);
  const rows = await page.locator('.grid tbody tr').allInnerTexts();
  eq(rows.length, 2, '案件数');
  ok(rows.some((r) => r.includes('11/13(金)〜11/17(火)（5日）') && r.includes('ラソラ札幌') && r.includes('フラワーボトル')), 'ラソラ札幌 11/13〜17 の案件がサンプルにありません');
  ok(await openTarget(page), 'ラソラ案件を開けません');
  eq(await page.locator('.warnbtn').innerText().then((t) => t.replace(/\s+/g, ' ').trim()), '⚠ 警告 0件 ▼', '警告ボタン');
  const e = await readEstimate(page);
  eq([e['売上 計'], e['人件費'], e['材料費'], e['会場費'], e['備品費'], e['その他費用'], e['費用 計'], e['利益'], e['利益率']],
    ['¥400,000', '¥84,800', '¥97,350', '¥100,000', '¥29,000', '¥22,000', '¥333,150', '¥66,850', '16.7%'], '試算');
  ok(Object.values(e).some((v) => v === '70.0h／制作席 16席／その他 6脚'), `総労働時間／制作席／その他の椅子: ${JSON.stringify(e)}`);
  eq(e['参考: 必要な回転数'], '3.8回', '必要な回転数（300 個 ÷（16 席 × 5 日）＝ 3.75）');
});
add('A2', '再読み込み（F5）してもデータが残る', async ({ page }) => {
  await loadSample(page);
  const before = await page.locator('.grid tbody tr').allInnerTexts();
  await sleep(1200);
  await page.reload();
  eq(await page.locator('.grid tbody tr').allInnerTexts(), before, '案件一覧');
});

add('A3', '入力した直後に再読み込みしても、最後の入力が消えない', async ({ page }) => {
  await setup(page);
  await sleep(1200);
  const memo = () => page.locator('table.kv tr', { hasText: 'メモ' }).locator('input');
  await memo().fill('直前の入力');
  await page.reload();                     // 待たずに再読み込み
  await openTarget(page);
  eq(await memo().inputValue(), '直前の入力', 'メモ');
});

// B. 数値入力
add('B1', '0 が入っている欄をクリックして 120 と打つと 120 になる（クリック位置によらない）', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '＋ コンテンツを追加' }).click();
  const cell = page.locator('[data-c="plannedCount"]').nth(1);
  const got = [];
  for (const frac of [0.1, 0.5, 0.9, 0.97]) {
    await cell.fill('0');
    await page.locator('h3').first().click();
    await clickAt(page, cell, frac);
    await type(page, '120');
    await page.locator('h3').first().click();
    got.push(await cell.inputValue());
  }
  eq(got, ['120', '120', '120', '120'], '予定個数（左端・中央・右寄り・右端をクリック）');
  await page.getByRole('button', { name: '＋ 費目を追加' }).click();
  const amount = page.locator('[data-c="amount"]').last();
  await clickAt(page, amount, 0.5);
  await type(page, '5000');
  await page.locator('h3').first().click();
  eq(await amount.inputValue(), '5000', 'その他費用の金額');
  const fee = page.locator('table.kv tr', { hasText: '会場費：固定額' }).locator('input');
  await clickAt(page, fee, 0.5);
  await type(page, '30000');
  await page.locator('h3').first().click();
  eq(await fee.inputValue(), '30000', '会場費：固定額');
});
add('B2', '値が入っている欄をクリックして打つと、その数字に置き換わる（休憩 60 → 45）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'スタッフ配置');
  const brk = page.locator('[data-c="breakMinutes"]').first();
  eq(await brk.inputValue(), '60', '休憩（初期値）');
  await clickAt(page, brk, 0.5);
  await type(page, '45');
  await page.locator('h3').first().click();
  eq(await brk.inputValue(), '45', '休憩');
});
add('B3', '数値欄で ↑↓ キーを押したり、ホイールを回したりしても値が変わらない', async ({ page }) => {
  await setup(page);
  const cell = page.locator('[data-c="plannedCount"]').first();
  const before = await cell.inputValue();
  await cell.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  eq(await cell.inputValue(), before, '↑↓ キーの後');
  await cell.focus();
  const b = await cell.boundingBox();
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.wheel(0, 120);
  await sleep(200);
  eq(await cell.inputValue(), before, 'ホイールの後');
  // 右端（スピンボタンがあった位置）をクリックしても変わらない
  await page.locator('h3').first().click();
  await clickAt(page, cell, 0.9);
  await page.locator('h3').first().click();
  eq(await cell.inputValue(), before, '右寄りをクリックした後');
});
add('B4', 'マイナス（-5）と小数（12.5）をそのまま入力できる', async ({ page }) => {
  await setup(page);
  const spare = page.locator('[data-c="sparePct"]').first();
  await spare.click(); await page.keyboard.press('Control+A'); await type(page, '-5');
  await page.locator('h3').first().click();
  eq(await spare.inputValue(), '-5', '予備率に -5');
  await spare.click(); await page.keyboard.press('Control+A'); await type(page, '12.5');
  await page.locator('h3').first().click();
  eq(await spare.inputValue(), '12.5', '予備率に 12.5');
  const rate = page.locator('table.kv tr', { hasText: '歩合' }).locator('input');
  await rate.click(); await type(page, '3.5');
  await page.locator('h3').first().click();
  eq(await rate.inputValue(), '3.5', '会場費の歩合に 3.5');
});
add('B5', '図面サイズに 1200 と打てる（Enter で確定）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await page.getByRole('button', { name: '周辺環境（雛形）' }).click();
  const w = page.locator('label', { hasText: '図面サイズ(cm) 幅' }).locator('input');
  await w.click(); await page.keyboard.press('Control+A'); await type(page, '1200');
  await page.keyboard.press('Enter');
  const vb = await until(() => page.locator('svg.layout-svg').getAttribute('viewBox'), (v) => v.split(' ')[2] === '1200');
  eq(vb.split(' ')[2], '1200', '図面の幅');
  eq(await w.inputValue(), '1200', '入力欄');
});
add('B6', '日本語入力の変換確定の Enter ではセルが移動しない。通常の Enter は下のセルへ移動する', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '＋ 費目を追加' }).click();
  const first = page.locator('[data-c="name"]').nth(0);
  const active = () => page.evaluate(() => `${document.activeElement?.dataset?.c}@${document.activeElement?.dataset?.r}`);
  await first.focus();
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229, isComposing: true, bubbles: true, cancelable: true })));
  eq(await active(), 'name@0', '変換確定の Enter の後のフォーカス');
  await page.keyboard.press('Enter');
  eq(await active(), 'name@1', '通常の Enter の後のフォーカス');
  await page.keyboard.press('Shift+Enter');
  eq(await active(), 'name@0', 'Shift+Enter の後のフォーカス');
});

add('B7', 'Tab で入った欄の中をクリックすると、その位置にカーソルが入って追記できる（全部が置き換わらない）', async ({ page }) => {
  await setup(page);
  await page.locator('table.kv tr', { hasText: '状態' }).locator('select').focus();
  await page.keyboard.press('Tab');
  const fixed = page.locator('table.kv tr', { hasText: '固定売上' }).locator('input');
  const before = await fixed.inputValue();
  const b = await fixed.boundingBox();
  await page.mouse.click(b.x + b.width - 6, b.y + b.height / 2);   // 数字の末尾あたり
  await type(page, '9');
  eq(await fixed.inputValue(), `${before}9`, '固定売上');
});
add('B8', '図面サイズ: 打ちかけのまま図をドラッグしても変更が消えない。空欄で離れても、同じ値を打ち直しても何も変わらない', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await exportPdf(page);                                            // V1 を出力済みにしておく
  await page.getByRole('button', { name: '周辺環境（雛形）' }).click();
  const w = page.locator('label', { hasText: '図面サイズ(cm) 幅' }).locator('input');
  const width = () => page.locator('svg.layout-svg').getAttribute('viewBox').then((v) => v.split(' ')[2]);
  await w.click(); await page.keyboard.press('Control+A'); await type(page, '1440.0'); await page.keyboard.press('Enter');
  eq(await versionText(page), '現在の版 V1（出力済み・編集すると V2 になります）', '同じ値を打ち直した後の版');
  await w.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
  await page.locator('.panel__hint').first().click();
  eq([await width(), await versionText(page)], ['1440', '現在の版 V1（出力済み・編集すると V2 になります）'], '空欄で離れた後');
  await w.click(); await page.keyboard.press('Control+A'); await type(page, '1600');   // 確定しないまま…
  const t = await page.locator('svg.layout-svg text', { hasText: 'DECO HOME' }).first().boundingBox();
  await page.mouse.move(t.x + 5, t.y + 5);
  await page.mouse.down();                                          // …図の中の周辺環境をドラッグ
  await page.mouse.move(t.x + 45, t.y + 35, { steps: 5 });
  await page.mouse.up();
  eq(await until(width, (v) => v === '1600'), '1600', '打ちかけのままドラッグした後の図面の幅');
});

// C. スタッフ配置と警告
add('C1', '配置表のクリックで配置／解除でき、人件費が連動する', async ({ page }) => {
  await setup(page);
  const base = yenNum((await readEstimate(page))['人件費']);
  await sheet(page, 'スタッフ配置');
  const head = (await page.locator('.matrix thead th').allInnerTexts()).filter((t) => /\d+\/\d+\(/.test(t));
  const empty = page.locator('.matrix__cell:not(.is-on) button').first();
  const label = await empty.getAttribute('aria-label');
  ok(head.length > 0 && label, '配置表が表示されていません');
  const rows = await page.locator('[data-c="breakMinutes"]').count();
  await empty.click();
  const cellBtn = page.getByRole('button', { name: label, exact: true });
  eq(await cellBtn.innerText(), '10:00-18:00', 'クリック後のセル');
  eq(await page.locator('[data-c="breakMinutes"]').count(), rows + 1, '配置明細の行数');
  const cost = yenNum(await page.locator('.grid tbody tr').last().locator('td').nth(8).innerText());
  ok(cost > 0, `追加した配置の人件費が 0 です`);
  eq(yenNum((await readEstimate(page))['人件費']), base + cost, '試算の人件費');
  await sheet(page, 'スタッフ配置');
  await cellBtn.click();
  eq((await cellBtn.innerText()).trim(), '', 'もう一度クリックした後のセル');
  eq(yenNum((await readEstimate(page))['人件費']), base, '解除後の人件費');
});
add('C2', '掛け持ちになる配置は確認ダイアログで選べる（キャンセルなら配置されず、OK なら配置される＝禁止しない）', async ({ page, dialogs, setAnswer }) => {
  await loadSample(page);
  const row = page.locator('.grid tbody tr').last();
  await row.getByRole('button', { name: '複製' }).click();          // 同じ期間の案件ができる（スタッフ配置は引き継がない）
  await page.locator('.grid tbody tr').last().getByRole('button', { name: '開く' }).click();
  await sheet(page, 'スタッフ配置');
  eq(await page.locator('.matrix__cell.is-on').count(), 0, '複製した直後は、誰も配置されていない');
  const cell = page.locator('.matrix__cell button').first();        // スタッフA × 11/13（元の案件で配置済みの枠）
  setAnswer(false);
  await cell.click();                                               // 元の案件と掛け持ちになる → 確認 → キャンセル
  ok(dialogs.some((m) => m.includes('別案件') && m.includes('このまま配置しますか')), `確認ダイアログが出ていません: ${JSON.stringify(dialogs)}`);
  eq((await cell.innerText()).trim(), '', 'キャンセルした場合');
  setAnswer(true);
  await cell.click();                                               // OK
  eq(await cell.innerText(), '10:00-18:00', 'OK した場合');
  ok((await warnCount(page)) > 0, '掛け持ちの警告が案件に表示されていません');
});
add('C3', '明細で同じ人を同じ日に重ねると、警告が出てセルが黄色になるが、入力はそのまま残る', async ({ page }) => {
  await setup(page);
  await sheet(page, 'スタッフ配置');
  eq(await warnCount(page), 0, '最初の警告件数');
  const firstStaff = await page.locator('[data-c="staffId"]').first().inputValue();
  await page.getByRole('button', { name: '＋ 配置を追加' }).click();
  await page.locator('[data-c="staffId"]').last().selectOption(firstStaff);
  eq(await warnCount(page), 2, '重複させた後の警告件数（2 行とも）');
  ok((await page.locator('td.is-warn').count()) >= 2, '黄色のセルがありません');
  eq(await page.locator('[data-c="staffId"]').last().inputValue(), firstStaff, '入力した値');
  await page.locator('.warnbtn').click();
  ok((await page.locator('.warnlist li').allInnerTexts()).every((t) => t.includes('同じ時間帯に重複して配置されています')), '警告一覧の文言');
  await page.locator('.grid button[title="この行を削除"]').last().click();
  eq(await warnCount(page), 0, '重複を消した後の警告件数');
});

add('C4', '使用中のスタッフをマスタから消そうとすると確認が出る（キャンセルで残り、OK で消えて案件側に警告が出る）', async ({ page, dialogs, setAnswer }) => {
  await loadSample(page);
  await tab(page, 'スタッフ');
  const n = await page.locator('.grid tbody tr').count();
  setAnswer(false);
  await page.locator('.grid button[title="この行を削除"]').first().click();
  ok(dialogs.at(-1)?.includes('使われています') && dialogs.at(-1)?.includes('削除しますか'), `確認ダイアログ: ${dialogs.at(-1)}`);
  eq(await page.locator('.grid tbody tr').count(), n, 'キャンセルした場合の行数');
  setAnswer(true);
  await page.locator('.grid button[title="この行を削除"]').first().click();
  eq(await page.locator('.grid tbody tr').count(), n - 1, 'OK した場合の行数');
  await tab(page, '案件');
  await openTarget(page);
  ok((await warnCount(page)) > 0, '案件に警告が出ていません');
  await page.locator('.warnbtn').click();
  ok((await page.locator('.warnlist li').allInnerTexts()).some((t) => t.includes('スタッフが未選択、またはマスタから削除されています')), '警告一覧の文言');
});
add('C5', '会場をマスタから消すと、その会場を使っている案件に警告が出る', async ({ page, dialogs }) => {
  await loadSample(page);
  await tab(page, '会場');
  await page.locator('.grid button[title="この行を削除"]').first().click();
  ok(dialogs.at(-1)?.includes('使われています'), `確認ダイアログ: ${dialogs.at(-1)}`);
  await tab(page, '案件');
  await openTarget(page);
  eq(await warnCount(page), 1, '警告件数');
  await page.locator('.warnbtn').click();
  ok((await page.locator('.warnlist li').allInnerTexts()).some((t) => t.includes('会場がマスタから削除されています')), '警告一覧の文言');
});

add('C6', '会場の雛形エディタの「元に戻す」は、別の会場の雛形に影響しない', async ({ page }) => {
  await loadSample(page);
  await tab(page, '会場');
  await page.getByRole('button', { name: '＋ 会場を追加' }).click();
  await page.locator('[data-c="name"]').nth(1).fill('別会場');
  const rows = page.locator('.grid tbody tr');
  const count = (i) => rows.nth(i).locator('td').nth(4).innerText();
  const [a0, b0] = [await count(0), await count(1)];
  await rows.nth(0).getByRole('button', { name: '雛形を編集' }).click();
  await page.getByRole('button', { name: '＋ 文字' }).click();      // 1 つ目の会場を編集
  await rows.nth(1).getByRole('button', { name: '雛形を編集' }).click();   // 2 つ目の会場の編集に切り替え
  const undo = page.getByRole('button', { name: /元に戻す/ });
  if (await undo.isEnabled()) await undo.click();
  eq([await count(0), await count(1)], [String(Number(a0) + 1), b0], '雛形の要素数（1 つ目は編集後のまま、2 つ目は変わらない）');
});

// D. レイアウトと試算の連動
add('D1', '椅子（制作席）を ＋1 すると制作席の数と備品費が増え、−1 で元に戻る', async ({ page }) => {
  await setup(page);
  const e0 = await readEstimate(page);
  const days = Number(/× (\d+)日/.exec(await page.locator('.est__summary').innerText())[1]);
  const chairRow = await page.locator('.est .grid tbody tr', { hasText: '椅子（制作席）' }).last().locator('td').allInnerTexts();
  const unit = yenNum(chairRow[3]) * (chairRow[3].includes('/日') ? days : 1);
  const seats0 = Number(/制作席 (\d+)席/.exec(JSON.stringify(e0))[1]);
  await sheet(page, 'レイアウト');
  const n0 = await partCount(page, 'pt-chair');
  eq(n0, seats0, '椅子（制作席）の個数と制作席の数');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  eq(await partCount(page, 'pt-chair'), n0 + 1, '＋1 後の椅子の個数');
  const e1 = await readEstimate(page);
  eq(Number(/制作席 (\d+)席/.exec(JSON.stringify(e1))[1]), seats0 + 1, '＋1 後の制作席の数');
  eq(yenNum(e1['備品費']), yenNum(e0['備品費']) + unit, '＋1 後の備品費');
  eq(yenNum(e1['利益']), yenNum(e0['利益']) - unit, '＋1 後の利益');
  await sheet(page, 'レイアウト');
  await page.getByRole('button', { name: '椅子（制作席）を減らす' }).click();
  const e2 = await readEstimate(page);
  eq([e2['備品費'], e2['利益']], [e0['備品費'], e0['利益']], '−1 後（元に戻る）');
});
add('D2', '組み合わせ配置「L字」を追加すると、テーブルが 3 台増えて ③-1〜③-3 の番号が付き、備品費が 3 台分増える', async ({ page }) => {
  await setup(page);
  const e0 = await readEstimate(page);
  const days = Number(/× (\d+)日/.exec(await page.locator('.est__summary').innerText())[1]);
  const tableRow = await page.locator('.est .grid tbody tr', { hasText: 'テーブル 150×60' }).last().locator('td').allInnerTexts();
  const unit = yenNum(tableRow[3]) * (tableRow[3].includes('/日') ? days : 1);
  await sheet(page, 'レイアウト');
  const n0 = await partCount(page, 'pt-table');
  await page.locator('.editor__side tr', { hasText: /^\s*1\s*L字/ }).getByRole('button', { name: '＋ 配置' }).click();
  eq(await partCount(page, 'pt-table'), n0 + 3, 'テーブルの個数');
  const labels = await labelsOnFigure(page);
  ok(['③-1', '③-2', '③-3'].every((l) => labels.includes(l)), `③-1〜③-3 の番号: ${labels.filter((l) => /[①②③]/.test(l))}`);
  ok(await page.locator('svg.layout-svg text', { hasText: 'L字③' }).count(), 'グループ名 L字③');
  eq(yenNum((await readEstimate(page))['備品費']), yenNum(e0['備品費']) + unit * 3, '備品費');
});
add('D3', 'L字のテーブルを 1 台ドラッグすると 3 台とも同じだけ動き、Ctrl+Z で元に戻る', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  // 図の左上からの相対位置（警告欄の出入りで図全体が上下しても影響を受けないようにする）
  const pos = async () => {
    const svg = await page.locator('svg.layout-svg').boundingBox();
    const out = [];
    for (const l of ['①-1', '①-2', '①-3']) {
      const b = await page.locator('svg.layout-svg tspan', { hasText: new RegExp(`^${l}$`) }).boundingBox();
      out.push([Math.round(b.x - svg.x), Math.round(b.y - svg.y)]);
    }
    return out;
  };
  const p0 = await pos();
  const b = await page.locator('svg.layout-svg tspan', { hasText: /^①-1$/ }).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  const p1 = await pos();
  const d = p1.map((p, i) => [p[0] - p0[i][0], p[1] - p0[i][1]]);
  ok(Math.abs(d[0][0]) > 20 && Math.abs(d[0][1]) > 10, `動いていません: ${JSON.stringify(d)}`);
  ok(d.every((x) => Math.abs(x[0] - d[0][0]) <= 1 && Math.abs(x[1] - d[0][1]) <= 1), `3 台の移動量がそろっていません: ${JSON.stringify(d)}`);
  eq(await page.locator('svg.layout-svg rect[data-noexport]').count(), 3, '選択枠の数（グループ全体）');
  await page.locator('.editor').focus();
  await page.keyboard.press('Control+z');
  eq(await until(pos, (p) => JSON.stringify(p) === JSON.stringify(p0)), p0, 'Ctrl+Z の後の位置');
});
add('D4', 'テーブル番号を手動で上書きできる。上書きした台は連番を使わず（①-1・受付・①-2）、空に戻すと自動の番号に戻る', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const b = await page.locator('svg.layout-svg tspan', { hasText: /^①-2$/ }).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  const input = page.locator('.panel label', { hasText: '表示名' }).locator('input');
  await input.click();
  await page.keyboard.type('受付');
  const group1 = async () => (await labelsOnFigure(page)).filter((t) => /^①-|受付/.test(t));
  eq(await until(group1, (v) => v.includes('受付')), ['①-1', '受付', '①-2'], '上書き後（上書きした台は連番を使わない）');
  await input.fill('');
  eq(await until(group1, (v) => !v.includes('受付')), ['①-1', '①-2', '①-3'], '空に戻した後');
});

add('D5', '画面幅の狭い端末（縦並びの表示）でも、図が幅いっぱいに出て、ドラッグしたパーツが飛ばない', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const svg = () => page.locator('svg.layout-svg').boundingBox();
  ok((await svg()).width >= 390 - 40, `図の幅が狭すぎます（${Math.round((await svg()).width)}px）`);
  // 単体（商談席1）と、グループ（L字①）をそれぞれ (+20, +15)px ドラッグ
  for (const name of ['商談席1', '①-1']) {
    const label = page.locator('svg.layout-svg tspan', { hasText: new RegExp(`^${name}$`) });
    await label.scrollIntoViewIfNeeded();
    const rel = async () => { const s = await svg(); const b = await label.boundingBox(); return [b.x - s.x, b.y - s.y]; };
    const p0 = await rel();
    const b = await label.boundingBox();
    await page.mouse.move(b.x + 3, b.y + 3);
    await page.mouse.down();
    await page.mouse.move(b.x + 23, b.y + 18, { steps: 5 });
    await page.mouse.up();
    const p1 = await until(rel, (p) => Math.abs(p[0] - p0[0]) > 5);
    const d = [Math.round(p1[0] - p0[0]), Math.round(p1[1] - p0[1])];
    ok(Math.abs(d[0] - 20) <= 3 && Math.abs(d[1] - 15) <= 3, `「${name}」を (+20,+15)px ドラッグ → 図の中での移動 (${d})px`);
  }
}, { viewport: { width: 390, height: 844 } });

add('D6', 'ドラッグの途中でページをスクロールしても、パーツはカーソルに付いてくる', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const label = page.locator('svg.layout-svg tspan', { hasText: /^商談席1$/ });
  const b = await label.boundingBox();
  await page.mouse.move(b.x + 3, b.y + 3);
  await page.mouse.down();
  await page.mouse.move(b.x + 13, b.y + 13, { steps: 3 });
  await page.mouse.wheel(0, 150);
  await sleep(150);
  await page.mouse.move(b.x + 14, b.y + 14);
  await sleep(100);
  const b2 = await label.boundingBox();
  await page.mouse.up();
  const off = [Math.round(b2.x - (b.x + 11)), Math.round(b2.y - (b.y + 11))];
  ok(Math.abs(off[0]) <= 4 && Math.abs(off[1]) <= 4, `カーソルとパーツのずれ (${off})px`);
}, { viewport: { width: 1440, height: 600 } });

add('D7', 'グループ（L字）を選んで Delete を押すと、選択枠のとおりグループごと消える（Ctrl+Z で戻る）。「この 1 台を削除」は 1 台だけ消す', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const n0 = await partCount(page, 'pt-table');
  const pick = async () => {
    const b = await page.locator('svg.layout-svg tspan', { hasText: /^①-1$/ }).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    eq(await page.locator('svg.layout-svg rect[data-noexport]').count(), 3, '選択枠の数（グループ全体）');
  };
  await pick();
  await page.locator('.editor').focus();
  await page.keyboard.press('Delete');
  eq(await until(() => partCount(page, 'pt-table'), (n) => n === n0 - 3), n0 - 3, 'Delete 後のテーブルの個数（3 台とも消える）');
  eq(await page.locator('svg.layout-svg text', { hasText: /^L字②$/ }).count(), 0, 'グループは 1 つに減る');
  await page.keyboard.press('Control+z');
  eq(await until(() => partCount(page, 'pt-table'), (n) => n === n0), n0, 'Ctrl+Z の後のテーブルの個数');
  await pick();
  await page.getByRole('button', { name: 'この 1 台を削除' }).click();
  eq(await until(() => partCount(page, 'pt-table'), (n) => n === n0 - 1), n0 - 1, '「この 1 台を削除」の後のテーブルの個数');
  const labels = await labelsOnFigure(page);
  ok(labels.includes('①-1') && labels.includes('①-2') && !labels.includes('①-3'), `残った 2 台は ①-1・①-2 に詰まる: ${labels.filter((l) => /^①/.test(l))}`);
});
add('D8', '図面サイズを小さくしてパーツが図面の外に出ると、警告が出る（パーツは自動では動かさない）。元に戻すと消える', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const total = async () => (await page.locator('.editor__side .stepper span').allInnerTexts()).reduce((a, b) => a + Number(b), 0);
  const n0 = await total();
  await page.getByRole('button', { name: '周辺環境（雛形）' }).click();
  const width = page.locator('label', { hasText: '図面サイズ(cm) 幅' }).locator('input');
  await width.click();
  await type(page, '700');
  await page.keyboard.press('Enter');
  const warn = await until(() => page.locator('.editor__canvas .warnlist').innerText().catch(() => ''), (t) => t.includes('図面の外'));
  ok(/図面の外にパーツがあります（\d+個: /.test(warn), `図面外の警告: ${warn}`);
  await page.getByRole('button', { name: 'パーツ配置' }).click();
  eq(await total(), n0, 'パーツの個数（自動では消えない・動かさない）');
  await page.getByRole('button', { name: /元に戻す/ }).click();
  eq(await until(() => page.locator('.editor__canvas .warnlist').count(), (n) => n === 0), 0, '元に戻した後は警告が消える');
});
add('D9', '制作席とその他の椅子を分けて数える。上限回転数を入力すると、席が足りない計算のときだけ警告が出る', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await page.getByRole('button', { name: '椅子（その他）を増やす' }).click();
  let e = await readEstimate(page);
  ok(Object.values(e).some((v) => v === '70.0h／制作席 16席／その他 7脚'), `その他の椅子を増やしても制作席は変わらない: ${JSON.stringify(e)}`);
  eq(e['参考: 必要な回転数'], '3.8回', '必要な回転数（その他の椅子では変わらない）');
  eq(await warnCount(page), 0, '上限回転数 4（サンプルの仮の値）では警告なし');
  await sheet(page, '基本情報');
  const turns = page.locator('[data-c="maxTurns"]').first();
  eq(await turns.inputValue(), '4', 'サンプルの上限回転数');
  await turns.click();
  await type(page, '3');                      // 300 個 ÷ 3 回 ＝ 100 席・日 ＞ 16 席 × 5 日 ＝ 80 席・日
  eq(await until(() => warnCount(page), (n) => n === 1), 1, '上限回転数 3 では警告 1 件');
  await page.locator('.warnbtn').click();
  ok((await page.locator('.pv .warnlist').first().innerText()).includes('制作席が足りない計算です：必要 100 席・日'), '警告文');
  ok(await turns.evaluate((el) => el.closest('td').classList.contains('is-warn')), '上限回転数の欄が黄色になる');
  eq(await turns.inputValue(), '3', '入力した値はそのまま残る（拒否しない）');
  await turns.fill('');
  eq(await until(() => warnCount(page), (n) => n === 0), 0, '空欄に戻すと警告しない');
});
add('D10', '案件を複製すると、コンテンツ・費用・レイアウトは引き継ぎ、スタッフ配置は引き継がない', async ({ page }) => {
  await loadSample(page);
  await page.locator('.grid tbody tr', { hasText: '11/13' }).first().getByRole('button', { name: '複製' }).click();
  const copy = page.locator('.grid tbody tr', { hasText: 'ikyu（コピー）' });
  await copy.waitFor();
  ok((await page.locator('[data-testid="notices"]').innerText()).includes('スタッフ配置 10 件は引き継いでいません'), '複製時の表示');
  await copy.getByRole('button', { name: '開く' }).click();
  await page.waitForSelector('.sheettabs');
  const e = await readEstimate(page);
  eq([e['人件費'], e['材料費'], e['会場費'], e['備品費'], e['その他費用']], ['¥0', '¥97,350', '¥100,000', '¥29,000', '¥22,000'], '複製した案件の試算（人件費だけ 0）');
  await sheet(page, 'スタッフ配置');
  eq(await page.locator('.matrix__cell.is-on').count(), 0, '配置表は空');
  await sheet(page, 'レイアウト');
  eq([await partCount(page, 'pt-table'), await partCount(page, 'pt-chair'), await versionText(page)], [6, 16, '現在の版 V1（未出力）'], 'レイアウトは複製され、版は V1 から');
});

// E. PDF と版数
add('E1', 'PDF をダウンロードできる（A4 横・1 ページ・画像 1 枚）。保存名に案件名・会場名・会期の開始日・版数が入る', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const { name, bytes } = await exportPdf(page);
  const text = bytes.toString('latin1');
  ok(text.startsWith('%PDF-1.4'), 'PDF のヘッダーがありません');
  ok(text.trimEnd().endsWith('%%EOF'), 'PDF の終端がありません');
  ok(text.includes('/Count 1'), '1 ページではありません');
  ok(text.includes('/MediaBox [0 0 841.89 595.28]'), 'A4 横ではありません');
  eq((text.match(/\/Subtype \/Image/g) ?? []).length, 1, '画像の数');
  ok(bytes.length > 100000, `サイズが小さすぎます（${bytes.length} バイト）`);
  eq(name, 'ikyu_ラソラ札幌_20261113_イベント配置図_V1.pdf', '保存名');
});
add('E2', 'PDF の画像に、未確認事項欄（黄色い枠と文字）が入っている', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const box = await page.evaluate(() => {
    const svg = document.querySelector('svg.layout-svg');
    const r = [...svg.querySelectorAll('rect')].find((x) => x.getAttribute('fill') === '#fffbe6');
    const vb = svg.viewBox.baseVal;
    const items = [...svg.querySelectorAll('text')].map((t) => t.textContent).filter((t) => t.startsWith('・'));
    return r ? { x: r.x.baseVal.value, y: r.y.baseVal.value, w: r.width.baseVal.value, h: r.height.baseVal.value, vb: [vb.x, vb.y, vb.width, vb.height], items } : null;
  });
  ok(box, '画面の図に未確認事項欄がありません');
  ok(box.items.length >= 3, `未確認事項の項目数: ${box.items.length}`);
  const { bytes } = await exportPdf(page);
  const text = bytes.toString('latin1');
  const m = /\/Width (\d+) \/Height (\d+)[^>]*\/Length (\d+) >>\nstream\n/.exec(text);
  ok(m, 'PDF に画像がありません');
  const start = m.index + m[0].length;
  const jpeg = bytes.subarray(start, start + Number(m[3])).toString('base64');
  const px = await page.evaluate(async ({ jpeg, box }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/jpeg;base64,${jpeg}`; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const sx = img.width / box.vb[2], sy = img.height / box.vb[3];
    const at = (x, y) => [...g.getImageData(Math.round((x - box.vb[0]) * sx), Math.round((y - box.vb[1]) * sy), 1, 1).data].slice(0, 3);
    // 欄の中（文字のない右側）と、欄のすぐ上（図面の地の色）
    const inside = at(box.x + box.w - 60, box.y + box.h / 2);
    const above = at(box.x + box.w - 60, box.y - 4);
    // 見出し・項目の文字があるあたりの濃い画素の数
    const d = g.getImageData(Math.round((box.x + 16 - box.vb[0]) * sx), Math.round((box.y + 8 - box.vb[1]) * sy), Math.round(420 * sx), Math.round((box.h - 16) * sy)).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 140 && d[i + 1] < 140) dark += 1;
    return { inside, above, dark, size: [img.width, img.height] };
  }, { jpeg, box });
  eq(px.size[0], 3000, '画像の幅（px）');
  ok(px.inside[0] > 245 && px.inside[2] < 240 && px.inside[0] - px.inside[2] > 15, `欄の中が黄色ではありません: rgb(${px.inside})`);
  ok(px.above[0] - px.above[2] < 12, `欄の上が地の色ではありません: rgb(${px.above})`);
  ok(px.dark > 2000, `欄の中に文字が描かれていません（濃い画素 ${px.dark}）`);
});
add('E3', '出力すると V1 が「出力済み」になる。再出力では上がらず、編集した時点で V2 になる', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  eq(await versionText(page), '現在の版 V1（未出力）', '最初');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  await page.getByRole('button', { name: '椅子（制作席）を減らす' }).click();
  eq(await versionText(page), '現在の版 V1（未出力）', '出力前の編集');
  await exportPdf(page);
  eq(await versionText(page), '現在の版 V1（出力済み・編集すると V2 になります）', '出力後');
  const again = await exportPdf(page);
  eq([await versionText(page), again.name.endsWith('_V1.pdf')], ['現在の版 V1（出力済み・編集すると V2 になります）', true], '再出力後');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  eq(await versionText(page), '現在の版 V2（未出力）', '出力後に編集');
  eq(await page.locator('svg.layout-svg > text').first().textContent(), 'ikyu｜ラソラ札幌 イベント配置図 V2', '図のタイトル');
  ok((await issuedText(page)).includes('V1（'), '出力履歴に V1 がありません');
  const v2 = await exportPdf(page);
  ok(v2.name.endsWith('_V2.pdf'), `V2 の保存名: ${v2.name}`);
  ok(/V1（[\d-]+）、V2（[\d-]+）/.test(await issuedText(page)), `出力履歴: ${await issuedText(page)}`);
});
add('E4', '出力後に「元に戻す」で出力前の状態まで戻しても、出力履歴は消えず、版は V2 になる（V1 が 2 種類できない）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const n0 = await partCount(page, 'pt-chair');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  await exportPdf(page);                                            // 椅子 +1 の状態を V1 として出力
  await page.getByRole('button', { name: /元に戻す/ }).click();     // 椅子を増やす前へ
  eq(await partCount(page, 'pt-chair'), n0, '椅子の個数');
  ok((await issuedText(page)).includes('V1（'), `出力履歴が消えています: 「${await issuedText(page)}」`);
  eq(await versionText(page), '現在の版 V2（未出力）', '版');
  const pdf = await exportPdf(page);
  ok(pdf.name.endsWith('_V2.pdf'), `保存名: ${pdf.name}`);
});
add('E5', '出力済みの版で「会場雛形を読み込み直す」と、図が変わるので V2 になる', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await exportPdf(page);
  await page.getByRole('button', { name: '周辺環境（雛形）' }).click();
  await page.getByRole('button', { name: '会場雛形を読み込み直す' }).click();
  eq(await versionText(page), '現在の版 V2（未出力）', '版');
});
add('E6', '日本時間の朝 8:30 に出力しても、作成日と出力履歴は当日の日付になる（前日にならない）', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  eq(await page.locator('svg.layout-svg > text').last().textContent(), '作成日 2026-11-13', '図の作成日');
  await exportPdf(page);
  eq(await issuedText(page), '出力履歴: V1（2026-11-13）', '出力履歴');
}, { fixedTime: '2026-11-12T23:30:00Z' });

add('E7', '「編集すると V? になります」の表示と、実際に編集したときの版が一致する', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await exportPdf(page);                                            // V1
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  await exportPdf(page);                                            // V2
  await page.getByRole('button', { name: /元に戻す/ }).click();     // V1 を出力した時点の状態へ
  const said = /編集すると (V\d+) になります/.exec(await versionText(page))?.[1];
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  const got = /現在の版 (V\d+)/.exec(await versionText(page))?.[1];
  ok(said && said === got, `表示は ${said}、実際は ${got}`);
});

const nameInput = (page) => page.locator('table.kv tr', { hasText: '案件名' }).locator('input');
const figureTitleText = (page) => page.locator('svg.layout-svg > text').first().textContent();

add('E8', '出力後に案件名を変えると、次の版（未出力）と表示され、何が変わったかが分かる。次に出力した時点で、その版として記録される', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await exportPdf(page);                                            // V1
  await sheet(page, '基本情報');
  await nameInput(page).fill('ikyu 秋');
  await sheet(page, 'レイアウト');
  eq(await versionText(page), '現在の版 V2（未出力：V1 の出力後に「案件名・会場名」が変わりました）', '案件名を変えた後');
  eq(await figureTitleText(page), 'ikyu 秋｜ラソラ札幌 イベント配置図 V2', '図のタイトル');
  ok(/^出力履歴: V1（[\d-]+）$/.test(await issuedText(page)), `出力するまで、出力履歴は増えない: ${await issuedText(page)}`);
  const v2 = await exportPdf(page);
  eq(v2.name, 'ikyu_秋_ラソラ札幌_20261113_イベント配置図_V2.pdf', 'V2 の保存名');
  eq(await versionText(page), '現在の版 V2（出力済み・編集すると V3 になります）', 'V2 を出力した後');
  ok(/V1（[\d-]+）、V2（[\d-]+）/.test(await issuedText(page)), `出力履歴: ${await issuedText(page)}`);
  // 名前を元に戻すと、V2 として出力した図とは違うので V3（V1 と同じ図でも、V1 には戻さない＝番号は進むだけ）
  await sheet(page, '基本情報');
  await nameInput(page).fill('ikyu');
  await sheet(page, 'レイアウト');
  eq(await versionText(page), '現在の版 V3（未出力：V2 の出力後に「案件名・会場名」が変わりました）', '名前を戻した後');
});
add('E9', '出力後にパーツマスタの寸法を変えると次の版（未出力）になる。単価・保有数だけの変更では、出力済みのまま', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  await exportPdf(page);
  const reopen = async () => { await tab(page, '案件'); await openTarget(page); await sheet(page, 'レイアウト'); };
  await tab(page, 'パーツ');
  await page.locator('[data-c="unitCost"]').first().fill('777');    // テーブルの単価（図には出ない）
  await page.locator('[data-c="stockQty"]').first().fill('50');
  await reopen();
  eq(await versionText(page), '現在の版 V1（出力済み・編集すると V2 になります）', '単価・保有数を変えた後');
  await tab(page, 'パーツ');
  await page.locator('[data-c="widthCm"]').first().fill('160');     // テーブルの幅（図が変わる）
  await reopen();
  eq(await versionText(page), '現在の版 V2（未出力：V1 の出力後に「パーツ（位置・寸法・種類・表示名）」が変わりました）', '寸法を変えた後');
  ok((await exportPdf(page)).name.endsWith('_V2.pdf'), '次の出力は V2');
});
add('E10', '会期が図のタイトルの下に入る。会期を変えると図が変わるので、出力済みの版は次の版になる。会期を消すと、図にもファイル名にも入らない', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const period = () => page.locator('[data-testid="figure-period"]');
  eq(await period().textContent(), '会期 2026/11/13(金)〜11/17(火)', '図の会期');
  const box = async (loc) => loc.boundingBox();
  const [t, p] = [await box(page.locator('svg.layout-svg > text').first()), await box(period())];
  ok(p.y > t.y + t.height * 0.5, '会期はタイトルの下にある');
  await exportPdf(page);
  await sheet(page, '基本情報');
  await page.locator('table.kv tr', { hasText: '終了日' }).locator('input').fill('2026-11-18');
  await sheet(page, 'レイアウト');
  eq(await period().textContent(), '会期 2026/11/13(金)〜11/18(水)', '終了日を変えた後の会期');
  eq(await versionText(page), '現在の版 V2（未出力：V1 の出力後に「会期」が変わりました）', '会期を変えた後の版');
  await sheet(page, '基本情報');
  await page.locator('table.kv tr', { hasText: '終了日' }).locator('input').fill('');
  await sheet(page, 'レイアウト');
  eq(await period().count(), 0, '会期が未入力なら、図に出さない');
  eq((await exportPdf(page)).name, 'ikyu_ラソラ札幌_イベント配置図_V2.pdf', '会期が無いときの保存名（日付なし）');
});
add('E11', '出力済みで図が変わっていない版を、別の日に出力し直しても、作成日は最初に出力した日のまま。編集して次の版になると、その日の日付になる', async ({ page }) => {
  await setup(page);
  await sheet(page, 'レイアウト');
  const stamp = () => page.locator('svg.layout-svg > text').last().textContent();
  eq(await stamp(), '作成日 2026-11-13', '出力前（今日の日付）');
  await exportPdf(page);
  await page.clock.setFixedTime(new Date('2026-11-20T03:00:00Z'));  // 1 週間後
  await sheet(page, '試算');
  await sheet(page, 'レイアウト');
  eq(await stamp(), '作成日 2026-11-13', '1 週間後に開いても、V1 の作成日は出力した日');
  await exportPdf(page);
  eq(await issuedText(page), '出力履歴: V1（2026-11-13）', '出し直しても記録は増えない');
  await page.getByRole('button', { name: '椅子（制作席）を増やす' }).click();
  eq([await versionText(page), await stamp()], ['現在の版 V2（未出力）', '作成日 2026-11-20'], '編集して V2 になると、その日の日付');
}, { fixedTime: '2026-11-13T03:00:00Z' });
add('E12', '以前の版のアプリ（Version 2 まで）で出力済みだった図は、次の版（未出力）として表示され、次の出力で版が上がる', async ({ page }) => {
  await loadSample(page);
  await sleep(300);
  // Version 2 までの出力の記録（図の内容の指紋が無い）を持つデータにして、開き直す
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('kkl_workshop_v1'));
    for (const p of d.projects) p.layout.issued = [{ version: 1, issuedAt: '2026-11-01' }];
    localStorage.setItem('kkl_workshop_v1', JSON.stringify(d));
  });
  await page.reload();
  await openTarget(page);
  await sheet(page, 'レイアウト');
  eq(await versionText(page), '現在の版 V2（未出力：V1 は以前の版のアプリで出力したため、次は V2 として出力します）', '以前の版で出力済みの図');
  eq(await figureTitleText(page), 'ikyu｜ラソラ札幌 イベント配置図 V2', '図のタイトル');
  ok((await exportPdf(page)).name.endsWith('_V2.pdf'), '次の出力は V2');
  eq(await versionText(page), '現在の版 V2（出力済み・編集すると V3 になります）', '出力後');
  ok(/V1（2026-11-01）、V2（[\d-]+）/.test(await issuedText(page)), `出力履歴: ${await issuedText(page)}`);
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

const { chromium } = loadPlaywright();
const server = await startServer();
// 既定のロケール（POSIX）のままだと、ヘッドレス Chromium が日本語の保存名を捨ててしまうため UTF-8 にする
const browser = await chromium.launch({ env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8', LC_ALL: process.env.LC_ALL || 'C.UTF-8' } });
const results = [];
try {
  for (const s of scenarios.filter((x) => !process.env.ONLY || x.id.startsWith(process.env.ONLY))) {
    const context = await browser.newContext({ viewport: s.opts.viewport ?? { width: 1440, height: 950 }, timezoneId: 'Asia/Tokyo', locale: 'ja-JP', acceptDownloads: true });
    const page = await context.newPage();
    const dialogs = [];
    const errors = [];
    let answer = true;
    page.on('dialog', async (d) => { dialogs.push(d.message()); if (answer) await d.accept(); else await d.dismiss(); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.setDefaultTimeout(8000);
    let detail = '';
    try {
      if (s.opts.fixedTime) await page.clock.setFixedTime(new Date(s.opts.fixedTime));
      await page.goto(server.base);
      await s.fn({ page, dialogs, setAnswer: (v) => { answer = v; } });
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
