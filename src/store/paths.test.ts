import { describe, expect, it } from 'vitest';
import colls from './collections.json';
import { APP_COLLS, BACKUP_COLL, LEGACY_DATA_COLL, LEGACY_PROJECT_COLL, MASTER_COLL, MASTER_KEYS, MEMBER_COLL, META_COLL, collPath, docPath } from './paths';

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
});
