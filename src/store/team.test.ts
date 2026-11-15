import { describe, expect, it } from 'vitest';
import {
  BLOCKED_TEAM_ID, BLOCK_TEXT, BlockReason, DEFAULT_TEAM_ID, FirebaseKind, TeamDecision, TeamInput, buildEnvOf, buildReport, decideTeam, effectiveVercelEnv,
  firebaseKindOf, isValidTeamId,
} from './team';

// 実際の Firebase の設定に見える値（架空。demo- で始まらないプロジェクト ID）
const REAL = { apiKey: 'key-for-test', projectId: 'some-real-project' };
const DEMO = { apiKey: 'demo-key', projectId: 'demo-kkl' };
const NONE = { apiKey: undefined, projectId: undefined };

const blocked = (d: TeamDecision): BlockReason | null => (d.ok ? null : d.reason);
const team = (d: TeamDecision): string | null => (d.ok ? d.teamId : null);

describe('共有データの場所の決め方（本番のデータにつながるのは、本番のビルドだけ）', () => {
  describe('本番ではないビルド × 実際の Firebase（＝ Vercel のプレビュー・手元から実際の設定でつなぐ場合）', () => {
    for (const vercelEnv of ['preview', 'development', undefined, '']) {
      const label = vercelEnv === undefined ? '（なし）' : vercelEnv === '' ? '（空）' : vercelEnv;
      it(`VERCEL_ENV=${label}: チーム名が無ければ、止める（通常のチームに切り替えない）`, () => {
        for (const teamId of [undefined, null, '']) {
          const d = decideTeam({ ...REAL, vercelEnv, teamId });
          expect(blocked(d), String(teamId)).toBe('unset');
          expect(team(d)).toBeNull();
        }
      });
      it(`VERCEL_ENV=${label}: 通常のチーム名を書いても、止める`, () => {
        expect(blocked(decideTeam({ ...REAL, vercelEnv, teamId: DEFAULT_TEAM_ID }))).toBe('production-team');
      });
      it(`VERCEL_ENV=${label}: 使えない形のチーム名は、止める`, () => {
        for (const teamId of [' ', 'kkl preview', ' kkl-preview', 'kkl-preview ', 'kkl/preview', 'kkl.preview', '..', '.', 'KKL-Preview', 'Intention-Dev',
          'intention-dev ', ' intention-dev', 'intention-dev\n', 'intention-dev/', 'ab', 'a', '-kkl', 'kkl-', '1kkl', '__blocked__', 'チーム', 'kkl_preview', 'a'.repeat(41)]) {
          expect(blocked(decideTeam({ ...REAL, vercelEnv, teamId })), JSON.stringify(teamId)).toBe('invalid');
        }
      });
      it(`VERCEL_ENV=${label}: 通常とは別の、使える形のチーム名なら、その場所を使う（検証用のビルド）`, () => {
        for (const teamId of ['kkl-preview', 'kkl-preview-check', 'abc', 'a1b', 'a'.repeat(40)]) {
          expect(decideTeam({ ...REAL, vercelEnv, teamId })).toEqual({
            ok: true, env: buildEnvOf(vercelEnv), firebase: 'real', teamId, explicit: true, verify: true,
          });
        }
      });
    }
  });

  describe('本番のビルド（VERCEL_ENV が、ちょうど production）', () => {
    it('チーム名が無ければ、通常のチーム（これまでどおり）', () => {
      for (const teamId of [undefined, null, '']) {
        expect(decideTeam({ ...REAL, vercelEnv: 'production', teamId })).toEqual({
          ok: true, env: 'production', firebase: 'real', teamId: DEFAULT_TEAM_ID, explicit: false, verify: false,
        });
      }
    });
    it('通常のチーム名を書いてあっても、通常のチーム', () => {
      expect(decideTeam({ ...REAL, vercelEnv: 'production', teamId: DEFAULT_TEAM_ID })).toEqual({
        ok: true, env: 'production', firebase: 'real', teamId: DEFAULT_TEAM_ID, explicit: true, verify: false,
      });
    });
    it('別のチーム名を書いてあれば、その場所（検証用のビルドとして表示する）', () => {
      expect(decideTeam({ ...REAL, vercelEnv: 'production', teamId: 'kkl-preview' })).toMatchObject({ ok: true, teamId: 'kkl-preview', verify: true });
    });
    it('使えない形のチーム名は、本番のビルドでも止める（通常のチームへの切り替えで、設定の誤りを隠さない）', () => {
      expect(blocked(decideTeam({ ...REAL, vercelEnv: 'production', teamId: 'kkl preview' }))).toBe('invalid');
    });
    it('production に似た値（大文字・前後の空白・別の語）は、本番として扱わない', () => {
      for (const vercelEnv of ['Production', 'PRODUCTION', ' production', 'production ', 'prod', 'production\n', 'staging', 'true', '1']) {
        expect(buildEnvOf(vercelEnv), JSON.stringify(vercelEnv)).toBe('preview');
        expect(blocked(decideTeam({ ...REAL, vercelEnv })), JSON.stringify(vercelEnv)).toBe('unset');
      }
      expect(buildEnvOf('production')).toBe('production');
      expect(buildEnvOf(undefined)).toBe('local');
      expect(buildEnvOf(null)).toBe('local');
      expect(buildEnvOf('')).toBe('local');
    });
  });

  describe('実際の Firebase に届かないビルド（設定なし・架空のプロジェクト＝自動テスト）', () => {
    it('チーム名が無くても、通常のチーム名のまま動く（止めない）', () => {
      for (const fb of [NONE, DEMO]) for (const vercelEnv of [undefined, 'preview', 'production']) {
        expect(decideTeam({ ...fb, vercelEnv })).toMatchObject({ ok: true, teamId: DEFAULT_TEAM_ID, verify: false, explicit: false });
        expect(decideTeam({ ...fb, vercelEnv, teamId: 'kkl-preview-check' })).toMatchObject({ ok: true, teamId: 'kkl-preview-check', verify: true });
      }
    });
    it('使えない形のチーム名は、ここでも止める', () => {
      for (const fb of [NONE, DEMO]) expect(blocked(decideTeam({ ...fb, teamId: 'a b' }))).toBe('invalid');
    });
    it('Firebase の種類の見分け方', () => {
      expect(firebaseKindOf('k', 'kitakita-example')).toBe('real');
      expect(firebaseKindOf('k', 'demo-kkl')).toBe('demo');
      expect(firebaseKindOf('k', 'demo')).toBe('real');           // 「demo-」で始まらないものは、実際のプロジェクトとして扱う
      expect(firebaseKindOf('k', 'my-demo-project')).toBe('real');
      expect(firebaseKindOf('', 'p')).toBe('none');
      expect(firebaseKindOf('k', '')).toBe('none');
      expect(firebaseKindOf(undefined, undefined)).toBe('none');
      expect(firebaseKindOf(null, 'p')).toBe('none');
    });
  });

  it('どんな組み合わせでも: 通常のチームになるのは「本番のビルド」か「実際の Firebase に届かないビルド」だけ', () => {
    // 決まった種から作る、でたらめな入力（毎回同じ並び）。32 ビットの整数のまま計算し、上位のビットを使う
    let seed = 20261115;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return ((seed >>> 16) & 0x7fff) % n; };
    const chars = [...'abcdefghijklmnopqrstuvwxyz0123456789-', ' ', '/', '.', '_', 'A', 'Z', '\n', '\t', 'あ', '%', '\\', '"', "'"];
    const word = () => Array.from({ length: rnd(14) }, () => chars[rnd(chars.length)]).join('');
    const teamIds: Array<string | undefined | null> = [undefined, null, '', DEFAULT_TEAM_ID, BLOCKED_TEAM_ID, 'kkl-preview', 'undefined', 'null', 'false', 'true',
      `${DEFAULT_TEAM_ID} `, ` ${DEFAULT_TEAM_ID}`, DEFAULT_TEAM_ID.toUpperCase(), `${DEFAULT_TEAM_ID}/x`, `x/${DEFAULT_TEAM_ID}`, `${DEFAULT_TEAM_ID}-2`];
    const random: string[] = [];
    for (let i = 0; i < 400; i++) random.push(word());
    // 作った入力が、偏っていないこと（長さが奇数・偶数のどちらもある。用意した文字が、すべて出てくる。ほとんどが別々の値）
    expect(new Set(random).size).toBeGreaterThan(300);
    expect(random.filter((w) => w.length % 2 === 1).length).toBeGreaterThan(100);
    expect(random.filter((w) => w.length % 2 === 0).length).toBeGreaterThan(100);
    for (const c of chars) expect(random.some((w) => w.includes(c)), JSON.stringify(c)).toBe(true);
    expect(random.some((w) => isValidTeamId(w))).toBe(true);     // 使える形の値も、使えない形の値も、混ざっている
    expect(random.some((w) => w !== '' && !isValidTeamId(w))).toBe(true);
    teamIds.push(...random);
    const vercelEnvs: Array<string | undefined | null> = [undefined, null, '', 'production', 'preview', 'development', 'Production', ' production', 'production ', 'staging'];
    for (let i = 0; i < 20; i++) vercelEnvs.push(word());
    // つなぐ先の種類は、判定の結果ではなく、ここで決めたものを正とする
    const firebases: Array<[{ apiKey?: string; projectId?: string }, FirebaseKind]> = [
      [REAL, 'real'], [DEMO, 'demo'], [NONE, 'none'], [{ apiKey: 'k', projectId: 'demo' }, 'real'], [{ apiKey: '', projectId: 'some-real-project' }, 'none'],
    ];
    let n = 0;
    let stopped = 0;
    let usedDefault = 0;
    for (const teamId of teamIds) for (const vercelEnv of vercelEnvs) for (const [fb, kind] of firebases) {
      const input: TeamInput = { ...fb, teamId, vercelEnv };
      const d = decideTeam(input);
      const where = JSON.stringify(input);
      n++;
      expect(d.firebase, where).toBe(kind);
      if (!d.ok) {
        stopped++;
        expect(Object.keys(BLOCK_TEXT), where).toContain(d.reason);
        expect(buildReport(d, input).error, where).toBeTruthy();
        continue;
      }
      expect(buildReport(d, input).error, where).toBeNull();
      expect(isValidTeamId(d.teamId), where).toBe(true);
      expect(d.teamId, where).not.toBe(BLOCKED_TEAM_ID);
      expect(d.verify, where).toBe(d.teamId !== DEFAULT_TEAM_ID);
      if (d.teamId === DEFAULT_TEAM_ID) {
        usedDefault++;
        // 守ること
        expect(vercelEnv === 'production' || kind !== 'real', where).toBe(true);
      } else {
        // 通常とは別の場所は、書いてあった値そのもの（書き換えない）
        expect(d.teamId, where).toBe(teamId);
        expect(d.explicit, where).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(60000);
    expect(stopped).toBeGreaterThan(1000);   // 止める場合も、通常のチームになる場合も、十分に通っていること
    expect(usedDefault).toBeGreaterThan(100);
  });

  it('止めたときの値（__blocked__）は、チーム名として使えない形で、通常のチーム名でもない', () => {
    expect(isValidTeamId(BLOCKED_TEAM_ID)).toBe(false);
    expect(BLOCKED_TEAM_ID).not.toBe(DEFAULT_TEAM_ID);
    expect(/^__.*__$/.test(BLOCKED_TEAM_ID)).toBe(true);   // Firestore が、ID として受け付けない形
    expect(isValidTeamId(DEFAULT_TEAM_ID)).toBe(true);
    expect(isValidTeamId(undefined)).toBe(false);
    expect(isValidTeamId(123)).toBe(false);
  });
});

describe('開発サーバーは、本番のビルドではない', () => {
  it('ビルド（vite build）では、VERCEL_ENV を、そのまま使う', () => {
    for (const v of ['production', 'preview', 'development', '', 'staging']) expect(effectiveVercelEnv(v, 'build')).toBe(v);
    expect(effectiveVercelEnv(undefined, 'build')).toBe('');
    expect(effectiveVercelEnv(null, 'build')).toBe('');
  });
  it('開発サーバー（vite）では、VERCEL_ENV=production を、本番として扱わない（手元の localhost から、本番のデータにつながない）', () => {
    const v = effectiveVercelEnv('production', 'serve');
    expect(buildEnvOf(v)).not.toBe('production');
    expect(decideTeam({ ...REAL, vercelEnv: v })).toMatchObject({ ok: false, reason: 'unset' });
    expect(decideTeam({ ...REAL, vercelEnv: v, teamId: DEFAULT_TEAM_ID })).toMatchObject({ ok: false, reason: 'production-team' });
    expect(decideTeam({ ...REAL, vercelEnv: v, teamId: 'kkl-preview' })).toMatchObject({ ok: true, teamId: 'kkl-preview', verify: true });
    for (const other of ['preview', 'development', '']) expect(effectiveVercelEnv(other, 'serve')).toBe(other);
    expect(effectiveVercelEnv(undefined, 'serve')).toBe('');
  });
});

describe('ビルドの記録と、ビルドを止めるメッセージ', () => {
  const report = (input: TeamInput) => buildReport(decideTeam(input), input);

  it('検証用のビルド: これまでと同じ 1 行（[kkl] VITE_TEAM_ID=…）が出る。止めない', () => {
    const r = report({ ...REAL, vercelEnv: 'preview', teamId: 'kkl-preview' });
    expect(r.lines).toEqual(['[kkl] build: preview (VERCEL_ENV=preview), firebase: real', '[kkl] VITE_TEAM_ID=kkl-preview']);
    expect(r.error).toBeNull();
  });
  it('本番のビルド: これまでと同じ 1 行（default team）が出る。止めない', () => {
    const r = report({ ...REAL, vercelEnv: 'production' });
    expect(r.lines).toEqual(['[kkl] build: production (VERCEL_ENV=production), firebase: real', '[kkl] VITE_TEAM_ID is not set (default team)']);
    expect(r.error).toBeNull();
    expect(report({ ...REAL, vercelEnv: 'production', teamId: DEFAULT_TEAM_ID }).lines[1]).toBe(`[kkl] VITE_TEAM_ID=${DEFAULT_TEAM_ID} (default team)`);
  });
  it('Firebase の設定の無いビルド（手元の確認）: 止めない', () => {
    const r = report({ ...NONE });
    expect(r.lines).toEqual(['[kkl] build: local (VERCEL_ENV is not set), firebase: none', '[kkl] VITE_TEAM_ID is not set (default team)']);
    expect(r.error).toBeNull();
  });
  it('プレビューで、チーム名が無い: 止める。記録に「検証用のビルド」の行は出ない', () => {
    const r = report({ ...REAL, vercelEnv: 'preview' });
    expect(r.lines).toEqual(['[kkl] build: preview (VERCEL_ENV=preview), firebase: real', '[kkl] VITE_TEAM_ID is not set -> STOPPED (unset)']);
    expect(r.error).toContain('Build stopped for safety (unset)');
    expect(r.error).toContain(BLOCK_TEXT.unset);
    expect(r.lines.join('\n')).not.toMatch(/VITE_TEAM_ID=/);
    expect(r.lines.join('\n')).not.toContain('default team');
  });
  it('プレビューで、通常のチーム名・使えない形: 止める。書いてあった値を、そのまま示す', () => {
    const a = report({ ...REAL, vercelEnv: 'preview', teamId: DEFAULT_TEAM_ID });
    expect(a.lines[1]).toBe(`[kkl] VITE_TEAM_ID = "${DEFAULT_TEAM_ID}" -> STOPPED (production-team)`);
    expect(a.error).toContain(BLOCK_TEXT['production-team']);
    const b = report({ ...REAL, vercelEnv: 'preview', teamId: 'kkl preview' });
    expect(b.lines[1]).toBe('[kkl] VITE_TEAM_ID = "kkl preview" -> STOPPED (invalid)');
    expect(b.error).toContain(BLOCK_TEXT.invalid);
    // 長い値は、記録を埋めない長さに切る
    const c = report({ ...REAL, vercelEnv: 'preview', teamId: 'x'.repeat(500) });
    expect(c.lines[1].length).toBeLessThan(140);
  });

  // 止めたあとの案内は、ビルドの種類で変える。本番のビルドに、検証用のチーム名を入れさせない（入れると、ビルドは通るが、本番が検証用の場所を指す）
  const SET = 'VITE_TEAM_ID に、検証用のチーム名（例: kkl-preview）を設定してください';
  const FIX = 'VITE_TEAM_ID を、検証用のチーム名（例: kkl-preview）に直してください';
  const NOT_IN_PRODUCTION = '本番のビルド（Vercel の Production）でこの表示が出た場合は、VITE_TEAM_ID に、検証用のチーム名を入れないでください';
  const REMOVE = 'Production 環境の VITE_TEAM_ID を、消してください';
  it('案内: プレビュー（Vercel が、本番ではないと示したビルド）では、検証用のチーム名を設定する・直す', () => {
    const unset = report({ ...REAL, vercelEnv: 'preview' }).error!;
    expect(unset).toContain(SET);
    expect(unset).not.toContain(NOT_IN_PRODUCTION);
    expect(unset).not.toContain(REMOVE);
    const invalid = report({ ...REAL, vercelEnv: 'preview', teamId: 'kkl preview' }).error!;
    expect(invalid).toContain(FIX);
    expect(invalid).not.toContain(REMOVE);
  });
  it('案内: VERCEL_ENV が渡っていないビルドでは、「本番のビルドなら、検証用のチーム名を入れない（Vercel の設定を確かめる）」を添える', () => {
    for (const teamId of [undefined, DEFAULT_TEAM_ID]) {
      const e = report({ ...REAL, teamId }).error!;
      expect(e).toContain(SET);
      expect(e).toContain(NOT_IN_PRODUCTION);
      expect(e).toContain('Automatically expose System Environment Variables');
      expect(e).not.toContain(REMOVE);
    }
    const invalid = report({ ...REAL, teamId: 'kkl preview' }).error!;
    expect(invalid).toContain(FIX);
    expect(invalid).toContain(NOT_IN_PRODUCTION);
    expect(invalid).toContain(REMOVE);
  });
  it('案内: 本番のビルドで、値が使えない形のときは、「消す」だけを案内する（検証用のチーム名を勧めない）', () => {
    const e = report({ ...REAL, vercelEnv: 'production', teamId: 'KKL/preview' }).error!;
    expect(e).toContain(REMOVE);
    expect(e).toContain('検証用のチーム名は、入れないでください');
    expect(e).not.toContain(SET);
    expect(e).not.toContain(FIX);
    expect(e).not.toContain('kkl-preview');
  });
  it('開発サーバー: 「ビルドを止めた」とは言わず、アプリが Firebase を起動しないことを知らせる', () => {
    const input = { ...REAL, vercelEnv: 'preview' };
    const r = buildReport(decideTeam(input), input, 'serve');
    expect(r.lines).toEqual(['[kkl] dev server: preview (VERCEL_ENV=preview), firebase: real', '[kkl] VITE_TEAM_ID is not set -> STOPPED (unset)']);
    expect(r.error).toContain('Firebase is switched off in this dev server (unset)');
    expect(r.error).toContain('この開発サーバーのアプリは、Firebase を起動しません');
    expect(r.error).not.toContain('Build stopped');
    expect(r.error).not.toContain('ビルドを止めました');
    const fine = { ...REAL, vercelEnv: 'preview', teamId: 'kkl-preview' };
    expect(buildReport(decideTeam(fine), fine, 'serve')).toEqual({ lines: ['[kkl] dev server: preview (VERCEL_ENV=preview), firebase: real', '[kkl] VITE_TEAM_ID=kkl-preview'], error: null });
  });
});
