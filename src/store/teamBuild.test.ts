import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_ID } from './team';

// 実際に `vite build` を走らせて、止まる条件では、ビルドが失敗して、配信するものが作られないことを確かめる。
// いちばん大事な守り（本番ではないビルドは、検証用のチーム名が無いと作れない）を、`npm test` だけでも確かめられるようにする。
// 止まる条件のビルドは、最初の段階（buildStart）で終わるので、短い。止まらない条件・ブラウザでの確認は、e2e/guard.mjs。
const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kkl-team-build-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/** 実際の Firebase の設定に見える値（架空。実在しないプロジェクト） */
const REAL = { VITE_FIREBASE_API_KEY: 'key-for-build-test', VITE_FIREBASE_PROJECT_ID: 'kkl-build-test-project' };
const APP_KEYS = ['VITE_TEAM_ID', 'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_EMULATOR'];

function build(name: string, extra: Record<string, string>): Promise<{ code: number | null; out: string; made: boolean }> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_') || k === 'VERCEL' || k.startsWith('VERCEL_')) delete env[k];
  for (const k of APP_KEYS) env[k] = '';          // 手元の .env* の値より、ここで渡した空（＝無い）が優先される
  const dir = path.join(TMP, name);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dir, '--emptyOutDir'], {
      cwd: ROOT, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, made: fs.existsSync(dir) && fs.readdirSync(dir).length > 0 }));
  });
}

describe('実際のビルド（vite build）: 本番ではないビルドは、検証用のチーム名が無いと、作れない', () => {
  it('Vercel のプレビュー × 実際の Firebase で、チーム名が無い・通常のチーム名・使えない形 → ビルドが失敗し、何も作られない', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['unset', { ...REAL, VERCEL_ENV: 'preview' }, 'unset'],
      ['default', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: DEFAULT_TEAM_ID }, 'production-team'],
      ['invalid', { ...REAL, VERCEL_ENV: 'preview', VITE_TEAM_ID: 'kkl preview' }, 'invalid'],
      ['local-unset', { ...REAL }, 'unset'],
    ];
    const done = await Promise.all(cases.map(([name, env]) => build(name, env)));
    cases.forEach(([name, , reason], i) => {
      const b = done[i];
      expect(b.code, `${name}\n${b.out.slice(-400)}`).not.toBe(0);
      expect(b.code, name).not.toBeNull();
      expect(b.made, name).toBe(false);
      expect(b.out, name).toContain(`Build stopped for safety (${reason})`);
      expect(b.out, name).toContain(`-> STOPPED (${reason})`);
      expect(b.out, name).not.toMatch(/\[kkl\] VITE_TEAM_ID=/);
      expect(b.out, name).not.toContain('default team)');
    });
  }, 120000);
});
