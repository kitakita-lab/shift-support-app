// playwright の読み込み（このリポジトリの依存には入れていないため、置き場所の候補を順に探す）
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadPlaywright() {
  const bases = [path.join(ROOT, 'package.json')];
  if (process.env.PLAYWRIGHT_PATH) bases.push(path.join(process.env.PLAYWRIGHT_PATH, 'x'));
  for (const p of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) bases.push(path.join(p, 'x'));
  try { bases.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'x')); } catch { /* npm が無い環境 */ }
  bases.push('/opt/node-tools/node_modules/x');
  for (const b of bases) {
    try { return createRequire(b)('playwright'); } catch { /* 次の候補へ */ }
  }
  throw new Error('playwright が見つかりません。`npm i -D playwright && npx playwright install chromium` を実行するか、PLAYWRIGHT_PATH=<playwright の入った node_modules> を指定してください。');
}
