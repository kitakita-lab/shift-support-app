import { afterEach, describe, expect, it, vi } from 'vitest';
import colls from './collections.json';
import {
  APP_COLLS, BACKUP_COLL, DEFAULT_TEAM_ID, IS_VERIFY_BUILD, LEGACY_DATA_COLL, LEGACY_PROJECT_COLL, MASTER_COLL, MASTER_KEYS, MEMBER_COLL, META_COLL,
  PROBE_COLL, PROBE_DOC, TEAM_ID, collPath, docPath,
} from './paths';

describe('共有データの置き場所', () => {
  it('アプリが使う場所は、一覧（collections.json）と一致する', () => {
    expect([...APP_COLLS].sort()).toEqual([...colls.app].sort());
    expect([LEGACY_DATA_COLL, LEGACY_PROJECT_COLL].sort()).toEqual([...colls.legacy].sort());
    expect([META_COLL, BACKUP_COLL, MEMBER_COLL]).toEqual([colls.meta, colls.backups, colls.members]);
    expect(Object.keys(MASTER_COLL).sort()).toEqual([...MASTER_KEYS].sort());
  });
  it('新しい形式の場所は、古いアプリ（V1・V2・旧シフトアプリ）が使う名前と重ならない', () => {
    const old = new Set([...colls.legacy, ...colls.oldApp]);
    for (const c of [...APP_COLLS, META_COLL, BACKUP_COLL]) expect(old.has(c), c).toBe(false);
    for (const c of [...APP_COLLS, META_COLL, BACKUP_COLL]) expect(c.startsWith('ws'), c).toBe(true);
  });
  it('場所はチームの直下の 2 階層だけ（それより深い場所は作らない）', () => {
    expect(collPath('wsStaff')).toEqual(['teams', 'intention-dev', 'wsStaff']);
    expect(docPath('wsStaff', 'abc')).toEqual(['teams', 'intention-dev', 'wsStaff', 'abc']);
  });
  it('Firebase の設定の無い実行（この単体テスト）は、通常のチーム名のままで、検証用のビルドではない', () => {
    expect(TEAM_ID).toBe(DEFAULT_TEAM_ID);
    expect(IS_VERIFY_BUILD).toBe(false);
  });
  it('どの場所も、チームの名前（TEAM_ID）から組み立てる（別のチーム名でビルドすると、通常のチームの場所は出てこない）', () => {
    const all = [...APP_COLLS, META_COLL, BACKUP_COLL, MEMBER_COLL, PROBE_COLL, LEGACY_DATA_COLL, LEGACY_PROJECT_COLL];
    for (const c of all) {
      expect(collPath(c).slice(0, 2), c).toEqual(['teams', TEAM_ID]);
      expect(docPath(c, 'x').slice(0, 2), c).toEqual(['teams', TEAM_ID]);
    }
    expect(docPath(PROBE_COLL, PROBE_DOC)).toEqual(['teams', TEAM_ID, PROBE_COLL, PROBE_DOC]);
  });
});

// paths.ts は、読み込まれたときに、ビルドの条件（環境変数と、vite.config.ts が埋め込む VERCEL_ENV）から場所を決める。
// 条件を差し替えて読み込み直し、アプリが実際に使う値（TEAM_ID・場所の組み立て）を確かめる。
describe('ビルドの条件ごとの、共有データの場所（paths.ts を読み込み直して確かめる）', () => {
  const REAL = { VITE_FIREBASE_API_KEY: 'key-for-test', VITE_FIREBASE_PROJECT_ID: 'some-real-project' };
  const DEMO = { VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_PROJECT_ID: 'demo-kkl' };
  async function load(env: Record<string, string>, vercelEnv?: string) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    if (vercelEnv !== undefined) vi.stubGlobal('__KKL_VERCEL_ENV__', vercelEnv);
    return import('./paths');
  }
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
  const everyPath = (m: typeof import('./paths')) =>
    [...m.APP_COLLS, m.META_COLL, m.BACKUP_COLL, m.MEMBER_COLL, m.PROBE_COLL, m.LEGACY_DATA_COLL, m.LEGACY_PROJECT_COLL]
      .flatMap((c) => [m.collPath(c).join('/'), m.docPath(c, 'x').join('/')]);

  for (const vercelEnv of ['preview', 'development', '']) {
    const name = vercelEnv || '（Vercel の外）';
    it(`${name} × 実際の Firebase × チーム名なし: 止まる。どの場所にも、通常のチーム名が出てこない`, async () => {
      const m = await load(REAL, vercelEnv);
      expect(m.TEAM_GUARD).toMatchObject({ ok: false, reason: 'unset' });
      expect(m.TEAM_ID).toBe('__blocked__');
      expect(m.IS_VERIFY_BUILD).toBe(false);
      for (const p of everyPath(m)) expect(p).not.toContain(DEFAULT_TEAM_ID);
    });
    it(`${name} × 実際の Firebase × 通常のチーム名・使えない形: 止まる`, async () => {
      for (const [teamId, reason] of [[DEFAULT_TEAM_ID, 'production-team'], ['kkl preview', 'invalid'], [`${DEFAULT_TEAM_ID} `, 'invalid']]) {
        const m = await load({ ...REAL, VITE_TEAM_ID: teamId }, vercelEnv);
        expect(m.TEAM_GUARD, teamId).toMatchObject({ ok: false, reason });
        expect(m.TEAM_ID, teamId).toBe('__blocked__');
        for (const p of everyPath(m)) expect(p, teamId).not.toContain(DEFAULT_TEAM_ID);
        vi.unstubAllEnvs();
      }
    });
    it(`${name} × 実際の Firebase × 検証用のチーム名: その場所だけを使う（検証用のビルド）`, async () => {
      const m = await load({ ...REAL, VITE_TEAM_ID: 'kkl-preview' }, vercelEnv);
      expect(m.TEAM_GUARD).toMatchObject({ ok: true, teamId: 'kkl-preview', verify: true });
      expect(m.TEAM_ID).toBe('kkl-preview');
      expect(m.IS_VERIFY_BUILD).toBe(true);
      for (const p of everyPath(m)) { expect(p.startsWith('teams/kkl-preview/')).toBe(true); expect(p).not.toContain(DEFAULT_TEAM_ID); }
    });
  }
  it('本番のビルド × 実際の Firebase × チーム名なし: 通常のチーム（これまでどおり）', async () => {
    const m = await load(REAL, 'production');
    expect(m.TEAM_GUARD).toMatchObject({ ok: true, env: 'production', teamId: DEFAULT_TEAM_ID, verify: false });
    expect(m.TEAM_ID).toBe(DEFAULT_TEAM_ID);
    expect(m.IS_VERIFY_BUILD).toBe(false);
    expect(m.collPath('wsStaff')).toEqual(['teams', DEFAULT_TEAM_ID, 'wsStaff']);
  });
  it('自動テストの構成（架空のプロジェクト）× チーム名なし: 通常のチーム名のまま動く', async () => {
    const m = await load(DEMO, '');
    expect(m.TEAM_GUARD).toMatchObject({ ok: true, firebase: 'demo', teamId: DEFAULT_TEAM_ID });
    expect(m.TEAM_ID).toBe(DEFAULT_TEAM_ID);
  });
  it('VERCEL_ENV の埋め込みが無い実行でも、実際の Firebase の設定があれば、本番として扱わない（止まる）', async () => {
    const m = await load(REAL);
    expect(m.TEAM_GUARD).toMatchObject({ ok: false, env: 'local', reason: 'unset' });
    expect(m.TEAM_ID).toBe('__blocked__');
  });
});
