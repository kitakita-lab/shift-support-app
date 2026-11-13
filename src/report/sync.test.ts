// 「日報を同期」の流れ（sync.ts）のテスト。認証と取得は差し替える。
// 重点: 失敗したときに、案件の実績（前回の同期結果）を消さない・書き換えない。
import { describe, expect, it } from 'vitest';
import { emptyLayout } from '../domain/layout';
import { jcosEstimate, defaultJcos } from '../domain/jcos';
import { RawReportRow } from '../domain/report';
import { mkContent, mkProject } from '../domain/testkit';
import { Project, ReportSource, Venue } from '../types';
import { ReportError, ReportErrorCode } from './sheets';
import { SyncDeps, SyncOutcome, applySync, runReportSync } from './sync';

const VENUE: Venue = { id: 'v1', name: '北街モール（中央広場）', feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout() };
const SOURCE: ReportSource = { spreadsheetId: 'sheet-1', gid: null };
const P = mkProject({
  id: 'p1', venueId: 'v1', startDate: '2026-11-13', endDate: '2026-11-15', jcos: defaultJcos(),
  contents: [mkContent({ plannedCount: 150 })], assignments: [],
});
const row = (date: string, count: unknown, venue = VENUE.name): RawReportRow => ({ date, venue, venueOther: '', event: '', count });
const ROWS = [row('2026/11/13', 62), row('2026/11/14', 58)];

interface Fake extends SyncDeps { log: string[] }
function deps(over: Partial<SyncDeps> = {}): Fake {
  const log: string[] = [];
  let clock = 0;
  return {
    log,
    token: async () => { log.push('token'); return 'tok'; },
    rows: async () => { log.push('rows'); return ROWS; },
    now: () => `2026-11-14T09:00:0${clock++}.000Z`,
    forget: () => { log.push('forget'); },
    ...over,
  };
}
const run = (d: SyncDeps, project: Project = P, source: ReportSource | null = SOURCE): Promise<SyncOutcome> =>
  runReportSync({ project, projects: [project], venues: [VENUE], source }, d);
/** 案件を持つ「置き場所」の代わり。成功したときだけ書く（画面と同じ使い方） */
async function syncInto(store: { p: Project }, d: SyncDeps): Promise<SyncOutcome> {
  const out = await run(d, store.p, store.p.reportSource ?? SOURCE);
  if (out.ok) store.p = applySync(store.p, out);
  return out;
}

describe('日報の同期: 成功したとき', () => {
  it('認証 → 取得 → 照合の順に進み、日別の実績と、使った日報の場所を返す', async () => {
    const d = deps();
    const out = await run(d);
    expect(d.log).toEqual(['token', 'rows']);
    expect(out).toMatchObject({ ok: true, source: SOURCE });
    if (out.ok) expect(out.sync.days).toEqual([{ date: '2026-11-13', count: 62, rows: 1 }, { date: '2026-11-14', count: 58, rows: 1 }]);
  });
  it('結果を案件に書くと、粗利が実績で計算される。もう一度同期しても同じ（二重計上しない）', async () => {
    const store = { p: P };
    expect(jcosEstimate(store.p).basis).toBe('planned');
    await syncInto(store, deps());
    const first = jcosEstimate(store.p);
    expect([first.basis, first.actualCount, first.actualDays]).toEqual(['mixed', 120, 2]);
    expect(store.p.reportSource).toEqual(SOURCE);
    await syncInto(store, deps());
    await syncInto(store, deps());
    const again = jcosEstimate(store.p);
    expect(again.actualCount).toBe(120);
    expect(again.current).toEqual(first.current);
  });
  it('日報が修正・削除されたあとの同期では、実績が置き換わる', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    await syncInto(store, deps({ rows: async () => [row('2026/11/13', 70)] }));        // 11/13 を修正・11/14 を削除
    expect(store.p.reportSync!.days).toEqual([{ date: '2026-11-13', count: 70, rows: 1 }]);
    expect(jcosEstimate(store.p).actualCount).toBe(70);
  });
});

describe('日報の同期: 失敗したときは、前回の実績をそのまま残す', () => {
  const failures: [string, Partial<SyncDeps>, ReportErrorCode][] = [
    ['通信エラー', { rows: async () => { throw new ReportError('network', '通信できません'); } }, 'network'],
    ['閲覧権限なし', { rows: async () => { throw new ReportError('no-access', '権限がありません'); } }, 'no-access'],
    ['API が無効', { rows: async () => { throw new ReportError('api-disabled', '無効です'); } }, 'api-disabled'],
    ['見出しの不一致', { rows: async () => { throw new ReportError('bad-header', '見出しがありません'); } }, 'bad-header'],
    ['認証の画面を閉じた', { token: async () => { throw new ReportError('popup-closed', '閉じました'); } }, 'popup-closed'],
    ['ポップアップが開けない', { token: async () => { throw new ReportError('popup-blocked', '開けません'); } }, 'popup-blocked'],
    ['予期しない例外', { rows: async () => { throw new TypeError('boom'); } }, 'unknown'],
  ];
  for (const [name, over, code] of failures) {
    it(`${name}: 何も書き換えない`, async () => {
      const store = { p: P };
      await syncInto(store, deps());
      const before = JSON.stringify(store.p);
      const profit = jcosEstimate(store.p).current.gross;
      const out = await syncInto(store, deps(over));
      expect(out).toMatchObject({ ok: false, code });
      expect(JSON.stringify(store.p)).toBe(before);
      expect(jcosEstimate(store.p).current.gross).toBe(profit);
      expect(store.p.reportSync!.days.length).toBe(2);
    });
  }
  it('認証の有効期限切れ・許可不足のときは、覚えている認証を捨てる（次は、認証からやり直す）', async () => {
    for (const code of ['auth-expired', 'no-scope'] as const) {
      const d = deps({ rows: async () => { throw new ReportError(code, 'x'); } });
      expect(await run(d)).toMatchObject({ ok: false, code });
      expect(d.log).toContain('forget');
    }
    const d = deps({ rows: async () => { throw new ReportError('network', 'x'); } });
    await run(d);
    expect(d.log).not.toContain('forget');
  });
});

describe('日報の同期: 通信する前に分かる問題', () => {
  it('会場・会期が決まっていない案件は、認証の画面を出さずに知らせる', async () => {
    for (const bad of [{ ...P, venueId: '' }, { ...P, startDate: '' }, { ...P, startDate: '2026-11-20' }]) {
      const d = deps();
      expect(await run(d, bad)).toMatchObject({ ok: false, code: 'setup' });
      expect(d.log).toEqual([]);
    }
  });
  it('日報の場所が決まっていないときも、認証の画面を出さずに知らせる', async () => {
    const d = deps();
    expect(await run(d, P, null)).toMatchObject({ ok: false, code: 'setup' });
    expect(d.log).toEqual([]);
  });
  it('認証は、最初の await より前に呼ばれる（利用者のタップの中でポップアップを開くため）', () => {
    const d = deps();
    void run(d);
    expect(d.log).toEqual(['token']);            // この時点で（何も待たずに）認証が呼ばれている
  });
});
