// 同じ案件の同期が重なったときの扱い（syncJob.ts）のテスト。認証と取得は差し替える。
// 重点: 古い同期の結果が、新しい実績を上書きしない
//   （完了の順序が逆転しても・最新の同期が失敗していても・ほかの端末の結果が先に届いていても）。
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyLayout } from '../domain/layout';
import { defaultJcos, jcosEstimate } from '../domain/jcos';
import { RawReportRow } from '../domain/report';
import { mkContent, mkProject } from '../domain/testkit';
import { Project, ReportSource, ReportSync, Venue } from '../types';
import { ReportError } from './sheets';
import { SyncDeps, failureIsCurrent } from './sync';
import {
  GONE_MESSAGE, SUPERSEDED_MESSAGE, SyncJobIo, SyncJobResult, abandonSync, isSyncRunning, resetSyncJobs, startSyncJob, subscribeSyncJobs,
  syncJobsVersion, syncKey, syncStamp,
} from './syncJob';

const VENUE: Venue = { id: 'v1', name: '北街モール（中央広場）', feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout() };
const SOURCE: ReportSource = { spreadsheetId: 'sheet-1', gid: null };
const P = mkProject({
  id: 'p1', venueId: 'v1', startDate: '2026-11-13', endDate: '2026-11-15', jcos: defaultJcos(),
  contents: [mkContent({ plannedCount: 150 })], assignments: [],
});
const KEY = syncKey('shared', 'p1');
const row = (date: string, count: unknown): RawReportRow => ({ date, venue: VENUE.name, venueOther: '', event: '', count });
/** 日報の内容（11/13 の個数だけを変える。11/14 は 58 個） */
const sheet = (first: unknown): RawReportRow[] => [row('2026/11/13', first), row('2026/11/14', 58)];
const total = (p: Project | undefined): number => (p?.reportSync?.days ?? []).reduce((s, d) => s + d.count, 0);

/** あとから結果を渡せる取得（通信が遅い場合の代わり） */
function slow() {
  let resolve!: (v: RawReportRow[]) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<RawReportRow[]>((res, rej) => { resolve = res; reject = rej; });
  return { rows: () => promise, resolve, reject };
}
const fast = (rows: RawReportRow[]) => async () => rows;

let tick = 0;
/** 呼ぶたびに進む時計（同期ごとに、結果の日時が変わる） */
const clock = (): string => `2026-11-14T09:00:${String(tick++).padStart(2, '0')}.000Z`;
let calls: string[] = [];
const deps = (rows: SyncDeps['rows']): SyncDeps => ({
  token: async () => { calls.push('token'); return 'tok'; },
  rows: (s, t) => { calls.push('rows'); return rows(s, t); },
  now: clock,
  forget: () => { calls.push('forget'); },
});

/** ほかの端末が保存した、同期の結果（中身は空。日時だけが違う） */
const OTHER_AT = '2026-11-14T09:30:00.000Z';
const otherSync = (count = 0): ReportSync => ({
  at: OTHER_AT, venueId: 'v1', startDate: P.startDate, endDate: P.endDate, rowsRead: count ? 1 : 0, rowsUsed: count ? 1 : 0, tests: 0, skipped: [], held: [], unmatched: [],
  days: count ? [{ date: '2026-11-13', count, rows: 1, keys: [] }] : [],
});

/** 案件を持つ「置き場所」の代わり。書き込みは、その場で行う（共有データと同じ） */
function place(p: Project = P) {
  const s = { p: p as Project | undefined, writes: 0, settled: [] as SyncJobResult[] };
  const io: SyncJobIo = {
    current: () => s.p,
    update: (fn) => {
      if (!s.p) return;
      const next = fn(s.p);
      if (next !== s.p) { s.p = next; s.writes += 1; }
    },
    settled: (r) => { s.settled.push(r); },
  };
  return { s, io };
}
type Place = ReturnType<typeof place>;
/** 同期を始める（画面と同じく、その時点の案件を渡す） */
const start = (pl: Place, rows: SyncDeps['rows'], key = KEY, source: ReportSource | null = SOURCE) =>
  startSyncJob(key, { project: pl.s.p!, projects: [pl.s.p!], venues: [VENUE], source }, deps(rows), pl.io);
/** 同期を 1 回、最後まで行う */
async function syncOnce(pl: Place, rows: RawReportRow[]): Promise<SyncJobResult> {
  const job = start(pl, fast(rows));
  if (!job) throw new Error('同期を始められなかった');
  return job;
}

beforeEach(() => { resetSyncJobs(); tick = 0; calls = []; });

describe('同じ案件の同期は、1 つずつ（案件の画面を閉じて開き直しても、同期中のまま）', () => {
  it('動いている間は「同期中」。その間は、次の同期を始めない（認証も取得も呼ばない）', async () => {
    const pl = place();
    const first = slow();
    const job = start(pl, first.rows);
    expect(job).not.toBeNull();
    expect(isSyncRunning(KEY)).toBe(true);
    await Promise.resolve();
    // 画面を開き直した側が、もう一度始めようとする（部品の中の状態は消えているが、同期中の印は、部品の外に残っている）
    const before = [...calls];
    expect(start(pl, fast(sheet(99)))).toBeNull();
    expect(calls).toEqual(before);
    expect(isSyncRunning(KEY)).toBe(true);
    first.resolve(sheet(70));
    expect(await job).toMatchObject({ kind: 'applied' });
    expect(isSyncRunning(KEY)).toBe(false);
    expect(total(pl.s.p)).toBe(128);
    expect(pl.s.writes).toBe(1);
    expect(calls.filter((c) => c === 'rows')).toHaveLength(1);
  });
  it('終わったあとは、次の同期を始められる。何度同期しても、実績は置き換わるだけ（二重に数えない）', async () => {
    const pl = place();
    expect(await syncOnce(pl, sheet(62))).toMatchObject({ kind: 'applied' });
    expect(await syncOnce(pl, sheet(62))).toMatchObject({ kind: 'applied' });
    expect(total(pl.s.p)).toBe(120);
    expect(jcosEstimate(pl.s.p!).actualCount).toBe(120);
    expect(await syncOnce(pl, sheet(70))).toMatchObject({ kind: 'applied' });
    expect(total(pl.s.p)).toBe(128);
  });
  it('別の案件・別の置き場所（共有と端末に、同じ ID の案件がある）の同期は、互いに止めない', async () => {
    const shared = place();
    const local = place();
    const other = place({ ...P, id: 'p2' });
    const a = slow();
    const jobA = start(shared, a.rows, syncKey('shared', 'p1'));
    const jobB = start(local, fast(sheet(99)), syncKey('local', 'p1'));
    const jobC = start(other, fast(sheet(10)), syncKey('shared', 'p2'));
    expect(jobB).not.toBeNull();
    expect(jobC).not.toBeNull();
    expect(await jobB).toMatchObject({ kind: 'applied' });
    expect(await jobC).toMatchObject({ kind: 'applied' });
    expect(isSyncRunning(syncKey('shared', 'p1'))).toBe(true);
    expect(isSyncRunning(syncKey('local', 'p1'))).toBe(false);
    a.resolve(sheet(70));
    expect(await jobA).toMatchObject({ kind: 'applied' });     // 端末側の同期が先に終わっていても、共有側の結果は捨てない
    expect([total(shared.s.p), total(local.s.p), total(other.s.p)]).toEqual([128, 157, 68]);
  });
  it('始まり・終わりが、画面に伝わる。結果の記録（settled）は 1 回だけ、同期中の印が消える前に呼ばれる', async () => {
    const pl = place();
    const seen: boolean[] = [];
    const off = subscribeSyncJobs(() => seen.push(isSyncRunning(KEY)));
    const v0 = syncJobsVersion();
    let runningAtSettled: boolean | null = null;
    const io: SyncJobIo = { ...pl.io, settled: (r) => { pl.io.settled!(r); runningAtSettled = isSyncRunning(KEY); } };
    const job = startSyncJob(KEY, { project: P, projects: [P], venues: [VENUE], source: SOURCE }, deps(fast(sheet(62))), io);
    await job;
    off();
    expect(seen).toEqual([true, false]);
    expect(syncJobsVersion()).toBe(v0 + 2);
    expect(runningAtSettled).toBe(true);
    expect(pl.s.settled).toHaveLength(1);
  });
  it('やめると、同期中ではなくなる。動いていない案件を「やめる」は、何もしない', async () => {
    const pl = place();
    const first = slow();
    const job = start(pl, first.rows);
    abandonSync(syncKey('shared', 'p2'));
    expect(isSyncRunning(KEY)).toBe(true);
    abandonSync(KEY);
    expect(isSyncRunning(KEY)).toBe(false);
    first.resolve(sheet(70));
    expect(await job).toEqual({ kind: 'dropped' });
    // やめたあとで何も始めていなくても、あとから届いた結果は使わない
    expect(pl.s.p).toBe(P);
    expect(pl.s.writes).toBe(0);
    // 動いていないときの「やめる」が、次の同期の結果を捨てさせることはない
    abandonSync(KEY);
    expect(await syncOnce(pl, sheet(62))).toMatchObject({ kind: 'applied' });
    expect(total(pl.s.p)).toBe(120);
  });
});

describe('完了の順序が逆転しても、先に始めた同期の結果は、新しい実績を上書きしない', () => {
  it('先の同期（遅い）をやめて始めた次の同期（速い）が、先に完了する。あとから届いた先の結果は捨てる', async () => {
    const pl = place();
    const first = slow();
    const job1 = start(pl, first.rows);           // 日報が直される前の内容（11/13 = 70）を、遅い通信で読んでいる
    abandonSync(KEY);
    const job2 = start(pl, fast(sheet(99)));       // 直されたあとの内容（11/13 = 99）
    expect(await job2).toMatchObject({ kind: 'applied' });
    const stored = pl.s.p;
    expect(total(stored)).toBe(157);
    first.resolve(sheet(70));                      // 先の同期の応答が、あとから届く
    expect(await job1).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(stored);                   // 案件は、1 項目も変わっていない（共有データへも、書き戻さない）
    expect(pl.s.writes).toBe(1);
    expect(jcosEstimate(pl.s.p!).actualCount).toBe(157);
    expect(pl.s.settled.map((r) => r.kind)).toEqual(['applied', 'dropped']);
  });
  it('次の同期がまだ終わっていない間に、先の結果が届いても、使わない（次の同期の結果だけが残る）', async () => {
    const pl = place();
    const first = slow();
    const second = slow();
    const job1 = start(pl, first.rows);
    abandonSync(KEY);
    const job2 = start(pl, second.rows);
    first.resolve(sheet(70));
    expect(await job1).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(P);
    expect(isSyncRunning(KEY)).toBe(true);         // 先の同期が終わっても、次の同期の「同期中」は消えない
    second.resolve(sheet(99));
    expect(await job2).toMatchObject({ kind: 'applied' });
    expect(total(pl.s.p)).toBe(157);
    expect(isSyncRunning(KEY)).toBe(false);
  });
  it('先の同期が「失敗」であとから届いても、新しい結果は変わらず、失敗の記録も残さない', async () => {
    const pl = place();
    const first = slow();
    const job1 = start(pl, first.rows);
    abandonSync(KEY);
    await syncOnce(pl, sheet(99));
    const stored = pl.s.p;
    first.reject(new ReportError('network', '日報に接続できませんでした。'));
    expect(await job1).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(stored);
    expect(pl.s.settled.map((r) => r.kind)).toEqual(['applied', 'dropped']);
  });
});

describe('最新の同期が失敗したとき、先に始めた同期の結果を、あとから確定しない', () => {
  /** 1 回同期した状態（実績 120 個）から、先の同期（遅い・成功するはず）→ やめる → 次の同期（失敗）の順に進める */
  async function latestFails(failing: SyncDeps['rows'], source: ReportSource | null = SOURCE) {
    const pl = place();
    await syncOnce(pl, sheet(62));
    const baseline = pl.s.p!;
    const first = slow();
    const job1 = start(pl, first.rows);
    abandonSync(KEY);
    const second = await start(pl, failing, KEY, source)!;
    first.resolve(sheet(70));                      // 先の同期は、読み取りに成功している
    const late = await job1;
    return { pl, baseline, second, late };
  }
  it('通信の失敗', async () => {
    const { pl, baseline, second, late } = await latestFails(async () => { throw new ReportError('network', '日報に接続できませんでした。'); });
    expect(second).toMatchObject({ kind: 'failed', code: 'network' });
    expect(late).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(baseline);                 // 前回の実績（120 個）のまま。先の同期の 128 個は、確定されていない
    expect(total(pl.s.p)).toBe(120);
    expect(pl.s.writes).toBe(1);
    // 画面に出る失敗は、最新の同期のもの
    const shown = pl.s.settled.filter((r) => r.kind === 'failed');
    expect(shown).toHaveLength(1);
    if (second.kind === 'failed') expect(failureIsCurrent(second.failure, syncStamp(pl.s.p!))).toBe(true);
  });
  it('読み取れない回答で止まった', async () => {
    const { pl, baseline, second, late } = await latestFails(fast(sheet('たくさん')));
    expect(second).toMatchObject({ kind: 'failed', code: 'bad-rows' });
    if (second.kind === 'failed') expect(second.failure.issues).toHaveLength(1);
    expect(late).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(baseline);
  });
  it('権限が無い（認証をやり直す必要がある）', async () => {
    const { pl, baseline, second, late } = await latestFails(async () => { throw new ReportError('no-scope', '日報を読む許可がありません。'); });
    expect(second).toMatchObject({ kind: 'failed', code: 'no-scope' });
    expect(late).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(baseline);
  });
  it('通信の前に止まった（日報の場所が未設定）', async () => {
    const { pl, baseline, second, late } = await latestFails(fast(sheet(99)), null);
    expect(second).toMatchObject({ kind: 'failed', code: 'setup' });
    expect(late).toEqual({ kind: 'dropped' });
    expect(pl.s.p).toBe(baseline);
  });
});

describe('同期の途中で、案件の同期の結果が変わっていたら（ほかの端末・ほかのタブの同期）、あとから届いた結果を書かない', () => {
  /** ほかの端末の同期の結果が、この端末に届いた */
  const arrive = (pl: Place, count = 0): Project => {
    const other: Project = { ...pl.s.p!, reportSync: otherSync(count) };
    pl.s.p = other;
    return other;
  };
  it('ほかの端末の結果が先に届いていた … 書かずに、そのことを知らせる', async () => {
    const pl = place();
    await syncOnce(pl, sheet(62));
    const mine = slow();
    const job = start(pl, mine.rows);
    const other = arrive(pl, 99);
    mine.resolve(sheet(70));
    const r = await job!;
    expect(r).toMatchObject({ kind: 'failed', code: 'superseded', failure: { message: SUPERSEDED_MESSAGE, base: OTHER_AT } });
    expect(pl.s.p).toBe(other);                    // ほかの端末の結果のまま
    expect(pl.s.writes).toBe(1);                   // 最初の同期の 1 回だけ
    // 知らせは、いまの結果（ほかの端末のもの）が残っている間は出る。次に同期が成功すると消える
    if (r.kind === 'failed') {
      expect(failureIsCurrent(r.failure, syncStamp(pl.s.p!))).toBe(true);
      await syncOnce(pl, sheet(70));
      expect(failureIsCurrent(r.failure, syncStamp(pl.s.p!))).toBe(false);
    }
    expect(total(pl.s.p)).toBe(128);
  });
  it('まだ 1 回も同期していない案件に、ほかの端末の最初の結果が届いていたときも同じ', async () => {
    const pl = place();
    const mine = slow();
    const job = start(pl, mine.rows);
    const other = arrive(pl);
    mine.resolve(sheet(70));
    expect(await job).toMatchObject({ kind: 'failed', code: 'superseded' });
    expect(pl.s.p).toBe(other);
  });
  it('書き込みが、あとで行われる置き場所（この端末だけのデータ）でも、書く直前の案件で確かめる', async () => {
    const s = { p: P as Project, queue: [] as ((p: Project) => Project)[] };
    const io: SyncJobIo = { current: () => s.p, update: (fn) => { s.queue.push(fn); } };
    const job = startSyncJob(KEY, { project: P, projects: [P], venues: [VENUE], source: SOURCE }, deps(fast(sheet(70))), io);
    expect(await job).toMatchObject({ kind: 'applied' });
    expect(s.queue).toHaveLength(1);
    const write = s.queue[0];
    // 書く前に、案件の同期の結果が変わった（バックアップの復元など）… 書かない。何度呼んでも同じ
    const replaced: Project = { ...P, reportSync: otherSync() };
    expect(write(replaced)).toBe(replaced);
    expect(write(replaced)).toBe(replaced);
    // 変わっていなければ書く。2 回呼ばれても（React の開発時の確認）、同じ結果
    const once = write(P);
    expect(total(once)).toBe(128);
    expect(write(P)).toEqual(once);
  });
  it('同期の結果のほかの項目（名前・割り当ての決定）が変わっただけなら、いまの案件に書く（その変更は残る）', async () => {
    const pl = place();
    const mine = slow();
    const job = start(pl, mine.rows);
    pl.s.p = { ...pl.s.p!, name: '名前を変えた', reportClaims: ['2026-11-13'] };
    mine.resolve(sheet(70));
    expect(await job).toMatchObject({ kind: 'applied' });
    expect(pl.s.p).toMatchObject({ name: '名前を変えた', reportClaims: ['2026-11-13'] });
    expect(total(pl.s.p)).toBe(128);
  });
  it('案件が無くなっていた（削除された・共有データを読めない）… 書かずに、失敗として記録する', async () => {
    const pl = place();
    const mine = slow();
    const job = start(pl, mine.rows);
    pl.s.p = undefined;
    mine.resolve(sheet(70));
    expect(await job).toMatchObject({ kind: 'failed', code: 'gone', failure: { message: GONE_MESSAGE, base: '' } });
    expect(pl.s.writes).toBe(0);
  });
});

describe('失敗したときは、案件に触れない。同期中の印は、必ず消える', () => {
  it('失敗の記録には、そのとき案件が持っていた同期の結果の日時が入る（次に成功するまで、画面に出る）', async () => {
    const pl = place();
    await syncOnce(pl, sheet(62));
    const stored = pl.s.p!;
    const r = await start(pl, async () => { throw new ReportError('network', '日報に接続できませんでした。'); })!;
    expect(r).toMatchObject({ kind: 'failed', code: 'network', failure: { message: '日報に接続できませんでした。', base: syncStamp(stored) } });
    expect(pl.s.p).toBe(stored);
    expect(isSyncRunning(KEY)).toBe(false);
  });
  it('置き場所の読み書きが例外を投げても、同期中のまま残らない', async () => {
    const io: SyncJobIo = { current: () => { throw new Error('boom'); }, update: () => { throw new Error('boom'); }, settled: () => { throw new Error('boom'); } };
    const r = await startSyncJob(KEY, { project: P, projects: [P], venues: [VENUE], source: SOURCE }, deps(fast(sheet(62))), io)!;
    expect(r).toMatchObject({ kind: 'failed', code: 'unknown' });
    expect(isSyncRunning(KEY)).toBe(false);
  });
});
