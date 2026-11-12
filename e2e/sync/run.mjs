#!/usr/bin/env node
// 同期・権限まわりの確認をまとめて実行する。
// ローカルの Firebase エミュレータ（Firestore・認証）を起動し、その上で次を流す:
//   - main.mjs   … 複数の端末に見立てたブラウザでの同期の確認
//   - rules.mjs  … セキュリティルールの確認（存在する場合）
//
// 使い方:
//   node e2e/sync/run.mjs                 … すべて
//   ONLY=S2 node e2e/sync/run.mjs         … 記号が S2 で始まる項目だけ
//   node e2e/sync/run.mjs rules           … ルールの確認だけ
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
if (what === 'all' || what === 'sync') scripts.push('e2e/sync/main.mjs');
if ((what === 'all' || what === 'rules') && fs.existsSync(path.join(here, 'rules.mjs'))) scripts.push('e2e/sync/rules.mjs');
if (scripts.length === 0) { console.error(`実行するものがありません: ${what}`); process.exit(2); }

const bin = process.env.FIREBASE_TOOLS_BIN;
const [cmd, pre] = bin ? [bin, []] : ['npx', ['-y', 'firebase-tools@15.36.0']];
const inner = scripts.map((s) => `node ${s}`).join(' ; ');
const r = spawnSync(cmd, [...pre, 'emulators:exec', '--only', 'firestore,auth', '--project', 'demo-kkl', '--config', 'firebase.emulator.json', `sh -c '${inner.replace(/ ; /g, " && ").replace(/'/g, "'\\''")}'`], {
  cwd: root, stdio: 'inherit', env: process.env,
});
process.exit(r.status ?? 1);
