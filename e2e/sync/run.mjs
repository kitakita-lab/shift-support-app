#!/usr/bin/env node
// 同期・権限まわりの確認をまとめて実行する。
// ローカルの Firebase エミュレータ（Firestore・認証）を起動し、その上で次を流す:
//   - main.mjs   … 複数の端末に見立てたブラウザでの同期の確認（修正前後を比べる 10 項目）
//   - v3.mjs     … Version 3 で追加した確認（移行・古いアプリとの互換性・メンバー制の画面・圏外と競合）
//   - report.mjs … 日報の同期（Version 4）。Google Sheets API の応答は差し替える（実際の Google にはつながない）
//   - rules.mjs  … セキュリティルールの確認
//
// 使い方:
//   node e2e/sync/run.mjs                 … すべて
//   node e2e/sync/run.mjs sync            … main.mjs と v3.mjs と report.mjs
//   node e2e/sync/run.mjs main|v3|report|rules … どれか 1 つ
//   node e2e/sync/run.mjs before          … main.mjs を、Version 2 のコード（修正前）に対して実行する（前後比較用）
//   RULES=firestore.rules node e2e/sync/run.mjs rules … 現在のルールに対して実行する（既定はルール案）
//   ONLY=S2,M1 node e2e/sync/run.mjs sync … 記号が S2・M1 で始まる項目だけ
//
// 必要なもの: Java（エミュレータ本体）、firebase-tools、playwright と Chromium。いずれもリポジトリの依存には入れていない。
//   firebase-tools は、環境変数 FIREBASE_TOOLS_BIN に実行ファイルの場所を指定するか、無ければ npx で取得する。
// 相手にするのは架空のプロジェクト（demo-kkl）だけで、実際の Firebase プロジェクトにはつながない。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const what = process.argv[2] ?? 'all';
const scripts = [];
if (['all', 'sync', 'main', 'before'].includes(what)) scripts.push('e2e/sync/main.mjs');
if (what === 'before') process.env.KKL_TARGET = 'v2';
if (['all', 'sync', 'v3'].includes(what) && fs.existsSync(path.join(here, 'v3.mjs'))) scripts.push('e2e/sync/v3.mjs');
if (['all', 'sync', 'report'].includes(what) && fs.existsSync(path.join(here, 'report.mjs'))) scripts.push('e2e/sync/report.mjs');
if (['all', 'rules'].includes(what) && fs.existsSync(path.join(here, 'rules.mjs'))) scripts.push('e2e/sync/rules.mjs');
if (scripts.length === 0) { console.error(`実行するものがありません: ${what}`); process.exit(2); }

const bin = process.env.FIREBASE_TOOLS_BIN;
const [cmd, pre] = bin ? [bin, []] : ['npx', ['-y', 'firebase-tools@15.36.0']];
// どれかが不合格でも残りを実行し、最後にまとめて結果（終了コード）を返す
const inner = `rc=0; ${scripts.map((s) => `node ${s} || rc=1`).join('; ')}; exit $rc`;
const r = spawnSync(cmd, [...pre, 'emulators:exec', '--only', 'firestore,auth', '--project', 'demo-kkl', '--config', 'firebase.emulator.json', `sh -c '${inner}'`], {
  cwd: root, stdio: 'inherit', env: process.env,
});
process.exit(r.status ?? 1);
