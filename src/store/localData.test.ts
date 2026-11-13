// 保存されていたデータを読むときの整え方（hydrateProject）のうち、Version 4 で足した項目の確認。
// 手で直したバックアップ・ほかの版のアプリ・ほかの人が書いたデータを読んでも、画面が落ちないこと。
import { describe, expect, it } from 'vitest';
import { defaultJcos, jcosEstimate, withJcosDay } from '../domain/jcos';
import { unmatchedGaps, usableReportDays } from '../domain/report';
import { mkContent, mkData, mkProject } from '../domain/testkit';
import { projectWarnings } from '../domain/warnings';
import { Project, ReportSync } from '../types';
import { hydrateData, hydrateProject } from './localData';

const SYNC: ReportSync = {
  at: '2026-11-14T09:00:00.000Z', venueId: 'v1', startDate: '2026-12-05', endDate: '2026-12-06',
  days: [{ date: '2026-12-05', count: 62, rows: 1 }],
  rowsRead: 6, rowsUsed: 1, tests: 1,
  skipped: [{ reason: 'bad-count', rows: 1, dates: ['2026-12-06'] }],
  held: [{ date: '2026-12-06', count: 5, rows: 1, others: ['別の案件'] }],
  unmatched: [{ venue: '別の書き方', rows: 1, count: 9, dates: ['2026-12-06'] }],
};
/** 壊れた値を入れる（型は無視する） */
const broken = (patch: Record<string, unknown>): Project => ({ ...mkProject(), ...patch } as unknown as Project);
/** 読み込んだあと、画面が使う計算がどれも落ちないこと */
function usable(p: Project): void {
  jcosEstimate(p);
  projectWarnings(p, mkData({ projects: [p] }));
  unmatchedGaps(p.reportSync);
  usableReportDays(p);
}

describe('Version 4 の項目を持たない案件', () => {
  it('項目を足さない（以前のデータは、これまでと同じ形のまま）', () => {
    const p = mkProject();
    const h = hydrateProject(p);
    expect(h).toEqual(p);
    for (const k of ['jcos', 'reportSync', 'actualsManual', 'reportClaims', 'reportSource']) expect(k in h, k).toBe(false);
  });
});

describe('アプリが書いた Version 4 の項目', () => {
  it('そのまま読める（内容は変わらない）', () => {
    const p = mkProject({
      jcos: withJcosDay({ ...defaultJcos(), unitCost: 250, extraBillings: [{ id: 'x1', name: '予備費', amount: 20000 }] }, '2026-12-06', { billed: false, partTimers: 2 }),
      actualsManual: { '2026-12-05': 40, '2026-12-06': 0 },
      reportSync: SYNC,
      reportClaims: ['2026-12-06'],
      reportSource: { spreadsheetId: 'sheet-1', gid: 1622532141 },
    });
    expect(hydrateProject(p)).toEqual(p);
    expect(hydrateProject(hydrateProject(p))).toEqual(p);
    expect(hydrateData({ projects: [p] }).projects[0]).toEqual(p);
    expect(hydrateProject({ ...p, reportSource: { spreadsheetId: 'sheet-1' } }).reportSource).toEqual({ spreadsheetId: 'sheet-1', gid: null });
  });
});

describe('形の崩れた Version 4 の項目（画面が落ちない形にそろえる）', () => {
  it('JCOS の条件: 欠けた金額は標準の値、欠けた一覧は空にする。オブジェクトでなければ外す', () => {
    expect(hydrateProject(broken({ jcos: { enabled: true } })).jcos).toEqual(defaultJcos());
    expect(hydrateProject(broken({ jcos: { enabled: 'yes', unitCost: '220', extraBillings: 'x', days: [] } })).jcos).toEqual({ ...defaultJcos(), enabled: false });
    const h = hydrateProject(broken({ jcos: {
      enabled: true, unitCost: 250, extraBillings: [null, { name: '予備費', amount: '3000' }, 5],
      days: { '2026-12-05': { billed: false, partTimers: -2 }, '2026-12-06': 'x', '2026-12-07': { billed: true } },
    } }));
    expect(h.jcos).toEqual({
      ...defaultJcos(), unitCost: 250, extraBillings: [{ id: 'extra-0', name: '予備費', amount: 3000 }],
      days: { '2026-12-05': { billed: false, partTimers: 0 } },
    });
    for (const v of ['x', 5, null, []]) expect('jcos' in hydrateProject(broken({ jcos: v })), String(v)).toBe(false);
  });
  it('同期の結果: 欠けた一覧は空・数でないものは 0 にし、形の合わない要素は落とす。オブジェクトでなければ外す', () => {
    const h = hydrateProject(broken({ reportSync: {
      at: 5, venueId: 'v1', days: [{ date: '2026-12-05', count: '62' }, { count: 3 }, null, 'x'],
      skipped: [{ reason: 'bad-count', rows: 1 }, { reason: 'unknown', rows: 9 }], held: 'x',
      unmatched: [{ venue: '別の書き方', dates: ['2026-12-06', 7] }, { rows: 1 }],
    } }));
    expect(h.reportSync).toEqual({
      at: '', venueId: 'v1', startDate: '', endDate: '',
      days: [{ date: '2026-12-05', count: 0, rows: 0 }], rowsRead: 0, rowsUsed: 0, tests: 0,
      skipped: [{ reason: 'bad-count', rows: 1, dates: [] }], held: [],
      unmatched: [{ venue: '別の書き方', rows: 0, count: 0, dates: ['2026-12-06'] }],
    });
    expect(hydrateProject(broken({ reportSync: {} })).reportSync).toMatchObject({ days: [], skipped: [], held: [], unmatched: [] });
    for (const v of ['x', 5, null, []]) expect('reportSync' in hydrateProject(broken({ reportSync: v })), String(v)).toBe(false);
  });
  it('手入力の実績・決めた日・日報の場所', () => {
    expect(hydrateProject(broken({ actualsManual: { a: 'x', '2026-12-05': 3, '2026-12-06': -1, c: null } })).actualsManual).toEqual({ '2026-12-05': 3 });
    expect('actualsManual' in hydrateProject(broken({ actualsManual: [1, 2] }))).toBe(false);
    expect(hydrateProject(broken({ reportClaims: ['2026-12-05', 5, null] })).reportClaims).toEqual(['2026-12-05']);
    expect('reportClaims' in hydrateProject(broken({ reportClaims: '2026-12-05' }))).toBe(false);
    expect(hydrateProject(broken({ reportSource: { spreadsheetId: 'abc', gid: '7' } })).reportSource).toEqual({ spreadsheetId: 'abc', gid: null });
    for (const v of [{ spreadsheetId: 5 }, { spreadsheetId: '' }, 'abc', null]) expect('reportSource' in hydrateProject(broken({ reportSource: v })), JSON.stringify(v)).toBe(false);
  });
  it('どんな形でも、読み込んだあとの計算は落ちない', () => {
    const junk: unknown[] = ['x', 5, null, [], {}, { days: 'x' }, { enabled: true, days: null, extraBillings: {} }, { days: [{}], held: [{}], unmatched: [{}], skipped: [{}] }];
    for (const a of junk) for (const b of junk) {
      const p = hydrateProject(broken({ jcos: a, reportSync: b, actualsManual: a, reportClaims: b, reportSource: a, contents: [mkContent()] }));
      expect(() => usable(p), JSON.stringify([a, b])).not.toThrow();
    }
  });
});
