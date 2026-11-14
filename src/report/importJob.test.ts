// 案件一覧の「日報から案件を作成・更新」の、取得の状態（importJob.ts）のテスト。認証と取得は差し替える。
import { beforeEach, describe, expect, it } from 'vitest';
import { RawReportRow } from '../domain/report';
import {
  abandonFetch, claimAutoApply, clearFetched, fetchFailure, fetchKey, fetchSession, fetchedReport, isFetchRunning, issueStamp, latestStamp, noteCreated, noteUpdated,
  rearmAutoApply, resetFetches, startFetch, wasUpdated,
} from './importJob';
import { ReportError } from './sheets';
import { SyncDeps } from './sync';

const SOURCE = { spreadsheetId: 'sheet-1', gid: null };
const KEY = fetchKey('shared', 'u1');
const row = (date: string): RawReportRow => ({ date, venue: '北街モール（中央広場）', venueOther: '', event: '', count: 1 });

/** 取得を、テストの側で終わらせられるようにする */
function gate() {
  let done!: (rows: RawReportRow[]) => void;
  let fail!: (e: unknown) => void;
  const rows = new Promise<RawReportRow[]>((res, rej) => { done = res; fail = rej; });
  return { rows, done, fail };
}
function deps(over: Partial<SyncDeps> = {}): SyncDeps & { forgot: string[] } {
  const forgot: string[] = [];
  let clock = 0;
  return { forgot, token: async () => 'tok', rows: async () => [row('2026/11/13')], now: () => `2026-11-14T09:00:0${clock++}.000Z`, forget: (t) => { forgot.push(t ?? ''); }, ...over };
}

beforeEach(() => resetFetches());

describe('取得: 1 つずつ・最後に始めたものだけが結果を置く', () => {
  it('読めたら、回答（必要な列だけ）と、読んだ日時・場所を、メモリに置く', async () => {
    const r = await startFetch(KEY, SOURCE, deps());
    expect(r).toMatchObject({ kind: 'fetched', report: { source: SOURCE, at: '2026-11-14T09:00:00.000Z' } });
    expect([fetchedReport(KEY)?.rows.length, fetchFailure(KEY), isFetchRunning(KEY)]).toEqual([1, null, false]);
  });
  it('動いている間は、次を始めない（null を返す）。置き場所・アカウントが違えば、別々に動く', async () => {
    const g = gate();
    const first = startFetch(KEY, SOURCE, deps({ rows: () => g.rows }));
    expect([isFetchRunning(KEY), startFetch(KEY, SOURCE, deps())]).toEqual([true, null]);
    const other = fetchKey('local', 'u1');
    expect((await startFetch(other, SOURCE, deps()))?.kind).toBe('fetched');
    g.done([row('2026/11/13'), row('2026/11/14')]);
    expect((await first)?.kind).toBe('fetched');
    expect([fetchedReport(KEY)?.rows.length, fetchedReport(other)?.rows.length]).toEqual([2, 1]);
  });
  it('取得を始めたら、前に読んだ内容は捨てる。取り直しが失敗したら、前の内容は残らず、失敗だけが残る', async () => {
    await startFetch(KEY, SOURCE, deps());
    noteCreated(KEY, 2);
    const g = gate();
    const second = startFetch(KEY, SOURCE, deps({ rows: () => g.rows }));
    expect([fetchedReport(KEY), fetchSession(KEY)]).toEqual([null, { created: 0, updated: 0 }]);     // 取得中は、前の内容を見せない
    g.fail(new ReportError('no-access', 'この日報を閲覧する権限がありません。'));
    expect(await second).toMatchObject({ kind: 'failed', code: 'no-access' });
    expect([fetchedReport(KEY), fetchFailure(KEY)?.message]).toEqual([null, 'この日報を閲覧する権限がありません。']);
  });
  it('やめた取得の結果は、あとから届いても使わない。やめたあとは、次を始められる', async () => {
    const g = gate();
    const first = startFetch(KEY, SOURCE, deps({ rows: () => g.rows }));
    abandonFetch(KEY);
    expect(isFetchRunning(KEY)).toBe(false);
    const second = await startFetch(KEY, SOURCE, deps({ rows: async () => [row('2026/11/20')] }));
    g.done([row('2026/11/13'), row('2026/11/14')]);
    expect((await first)?.kind).toBe('dropped');
    expect([second?.kind, fetchedReport(KEY)?.rows.map((r) => r.date)]).toEqual(['fetched', ['2026/11/20']]);
  });
  it('取得の途中で、読んだ内容をすべて捨てたら（ログアウト・アカウントの切り替え）、届いた結果は置かない', async () => {
    const g = gate();
    const first = startFetch(KEY, SOURCE, deps({ rows: () => g.rows }));
    clearFetched();
    g.done([row('2026/11/13')]);
    expect((await first)?.kind).toBe('dropped');
    expect([fetchedReport(KEY), isFetchRunning(KEY)]).toEqual([null, false]);
  });
  it('認証が無効だったときは、その認証を捨てる。予期しない失敗は、決まった文で残す（中身を出さない）', async () => {
    const d = deps({ rows: async () => { throw new ReportError('auth-expired', '認証の有効期限が切れました。'); } });
    expect(await startFetch(KEY, SOURCE, d)).toMatchObject({ kind: 'failed', code: 'auth-expired' });
    expect(d.forgot).toEqual(['tok']);
    const odd = await startFetch(KEY, SOURCE, deps({ rows: async () => { throw new Error('SECRET internal detail'); } }));
    expect(odd).toMatchObject({ kind: 'failed', code: 'unknown' });
    expect(JSON.stringify(fetchFailure(KEY))).not.toContain('SECRET');
  });
  it('認証は、最初の待ちより前に呼ぶ（タップの中で、Google の画面を開けるように）', () => {
    let called = false;
    void startFetch(KEY, SOURCE, deps({ token: () => { called = true; return new Promise(() => {}); } }));
    expect(called).toBe(true);
  });
});

describe('読んだ日報についての記録', () => {
  it('既存の案件の更新を自動で始めるのは、読んだ日報 1 つにつき 1 回。作成のあとに、もう 1 回だけ始められる', async () => {
    expect(claimAutoApply(KEY)).toBe(false);                    // まだ読んでいない
    await startFetch(KEY, SOURCE, deps());
    expect([claimAutoApply(KEY), claimAutoApply(KEY)]).toEqual([true, false]);
    rearmAutoApply(KEY);
    expect([claimAutoApply(KEY), claimAutoApply(KEY)]).toEqual([true, false]);
    await startFetch(KEY, SOURCE, deps());                      // 読み直したら、また 1 回
    expect(claimAutoApply(KEY)).toBe(true);
  });
  it('作成した数・更新した案件を数える（同じ案件は、1 回だけ）', async () => {
    await startFetch(KEY, SOURCE, deps());
    noteCreated(KEY, 3);
    noteCreated(KEY, 0);
    noteUpdated(KEY, 'p1');
    noteUpdated(KEY, 'p1');
    noteUpdated(KEY, 'p2');
    expect([fetchSession(KEY), wasUpdated(KEY, 'p1'), wasUpdated(KEY, 'p9')]).toEqual([{ created: 3, updated: 2 }, true, false]);
  });
  it('やり直しは、読んだ日報 1 つにつき 8 回まで（やり直しが、やり直しを呼び続けない）', async () => {
    await startFetch(KEY, SOURCE, deps());
    let passes = 0;
    for (let i = 0; i < 20; i += 1) { if (claimAutoApply(KEY)) passes += 1; rearmAutoApply(KEY); }
    expect(passes).toBe(9);                                     // 最初の 1 回 ＋ やり直し 8 回
    await startFetch(KEY, SOURCE, deps());                      // 読み直したら、数え直す
    rearmAutoApply(KEY);
    expect(claimAutoApply(KEY)).toBe(true);
  });
  it('読んだ内容で書くときの同期の日時: 日報を読んだ日時から、書くたびに 1 ミリ秒ずつ進む（読んだあとの、新しい同期と見分けられる・書くたびに変わる）', async () => {
    expect([issueStamp(KEY), latestStamp(KEY)]).toEqual([null, null]);                       // まだ読んでいない
    await startFetch(KEY, SOURCE, deps());
    const at = fetchedReport(KEY)!.at;
    expect(latestStamp(KEY)).toBe(at);                                                       // まだ書いていない
    expect([issueStamp(KEY), issueStamp(KEY), issueStamp(KEY)]).toEqual(['2026-11-14T09:00:00.000Z', '2026-11-14T09:00:00.001Z', '2026-11-14T09:00:00.002Z']);
    expect(latestStamp(KEY)).toBe('2026-11-14T09:00:00.002Z');
    // 読んだあとで行われた同期（実際の時刻）は、これより新しい
    expect('2026-11-14T09:00:05.000Z' > latestStamp(KEY)!).toBe(true);
    await startFetch(KEY, SOURCE, deps({ now: () => '2026-11-14T09:30:00.000Z' }));        // 読み直したら、そこから数え直す
    expect(issueStamp(KEY)).toBe('2026-11-14T09:30:00.000Z');
  });
});
