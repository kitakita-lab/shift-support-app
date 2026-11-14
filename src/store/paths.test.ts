import { describe, expect, it } from 'vitest';
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
  it('環境変数（VITE_TEAM_ID）を指定しないビルドは、通常のチームを使い、検証用のビルドではない', () => {
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
