// 「日報を同期」の流れ（sync.ts）のテスト。認証と取得は差し替える。
// 重点: 失敗したときに、案件の実績（前回の同期結果）を消さない・書き換えない。
import { describe, expect, it } from 'vitest';
import { emptyLayout } from '../domain/layout';
import { jcosEstimate, defaultJcos, withJcosDay, withUnitCost } from '../domain/jcos';
import { RawReportRow, contentKey, venueKey } from '../domain/report';
import { mkContent, mkProject } from '../domain/testkit';
import { Project, ReportSource, Venue } from '../types';
import { ReportError, ReportErrorCode } from './sheets';
import { MAX_ISSUES_SHOWN, SyncDeps, SyncOutcome, applySync, failureIsCurrent, failureOf, hydrateFailure, runReportSync } from './sync';

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
    const keys = [venueKey(VENUE.name)];
    if (out.ok) expect(out.sync.days).toEqual([{ date: '2026-11-13', count: 62, rows: 1, keys }, { date: '2026-11-14', count: 58, rows: 1, keys }]);
  });
  it('同期は、実績だけを置き換える。請求・支払いの条件（日ごとの請求・配置したアルバイトの人数・材料原価の標準・内容ごとの原価・追加の請求）は、変えない', async () => {
    const BAG = 'フラワーバッグ';
    let t = withUnitCost({ ...defaultJcos(), unitCost: 200, extraBillings: [{ id: 'x1', name: '予備費', amount: 5000 }] }, contentKey(BAG), 350);
    t = withJcosDay(t, '2026-11-13', { partTimers: 2 });
    t = withJcosDay(t, '2026-11-15', { billed: false });
    const store = { p: { ...P, jcos: t, actualsManual: { '2026-11-15': 7 } } };
    const withContent = (date: string, count: number, content: string): RawReportRow => ({ ...row(date, count), content });
    await syncInto(store, deps({ rows: async () => [withContent('2026/11/13', 62, BAG), withContent('2026/11/14', 58, 'フラワーボトル')] }));
    expect(store.p.jcos).toEqual(t);
    expect(store.p.actualsManual).toEqual({ '2026-11-15': 7 });
    // 日別に、内容ごとの個数が入り、内容ごとの原価で計算される（バッグ 62 個 × 350 ＋ ボトル 58 個 × 200 ＋ 手入力 7 個 × 200）
    expect(store.p.reportSync!.days.map((d) => d.contents)).toEqual([[{ label: BAG, count: 62 }], [{ label: 'フラワーボトル', count: 58 }]]);
    const j = jcosEstimate(store.p);
    expect([j.current.materialCost, j.partTimerDays, j.billDays, j.current.extraBilling]).toEqual([62 * 350 + 58 * 200 + 7 * 200, 2, 2, 5000]);
    // もう一度同期しても、同じ（条件も、金額も）
    const before = jcosEstimate(store.p).current;
    await syncInto(store, deps({ rows: async () => [withContent('2026/11/13', 62, BAG), withContent('2026/11/14', 58, 'フラワーボトル')] }));
    expect([store.p.jcos, jcosEstimate(store.p).current]).toEqual([t, before]);
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
    expect(store.p.reportSync!.days).toEqual([{ date: '2026-11-13', count: 70, rows: 1, keys: [venueKey(VENUE.name)] }]);
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
    // 日報に、読み取れない回答がある（この案件の回答か、この案件のものかどうかを決められない回答）
    ['読み取れない回答（個数が文字）', { rows: async () => [...ROWS, row('2026/11/15', '80個')] }, 'bad-rows'],
    ['読み取れない回答（個数が空欄）', { rows: async () => [...ROWS, row('2026/11/15', '')] }, 'bad-rows'],
    ['読み取れない回答（個数がマイナス）', { rows: async () => [row('2026/11/13', -1), ...ROWS] }, 'bad-rows'],
    ['読み取れない回答（個数が小数）', { rows: async () => [row('2026/11/13', 62), row('2026/11/14', 58.5)] }, 'bad-rows'],
    ['読み取れない回答（開催日）', { rows: async () => [...ROWS, row('きのう', 30)] }, 'bad-rows'],
    ['読み取れない回答（会場名が空欄）', { rows: async () => [...ROWS, row('2026/11/15', 30, '')] }, 'bad-rows'],
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
  it('捨てるのは、その同期が使った認証（あとから届いた古い同期の失敗で、新しく得た認証を捨てないよう、どの認証かを渡す）', async () => {
    const forgotten: string[] = [];
    const d = deps({ token: async () => 'tok-old', rows: async () => { throw new ReportError('auth-expired', 'x'); }, forget: (t) => { forgotten.push(t); } });
    await run(d);
    expect(forgotten).toEqual(['tok-old']);
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

describe('日報の同期: 日報に読み取れない回答があるときは、取り込みを中止する', () => {
  const bad = [...ROWS, row('2026/11/15', '80個')];               // 日報の 4 行目
  it('どの回答の、どの項目が、なぜ読み取れないかを返す。認証は捨てない（認証の問題ではない）', async () => {
    const d = deps({ rows: async () => bad });
    const out = await run(d);
    expect(out).toMatchObject({ ok: false, code: 'bad-rows' });
    expect(d.log).toEqual(['token']);                             // 認証は 1 回。覚えている認証を捨てて（forget）いない
    if (!out.ok) {
      expect(out.issues).toEqual([{ row: 4, date: '2026-11-15', items: [{ field: 'キットの使用数', reason: expect.stringContaining('数字以外の文字') }] }]);
      expect(out.message).toContain('取り込みを中止');
    }
  });
  it('止まったあとも、前回の実績と粗利はそのまま。日報を直して同期すると、取り込める（そのあとは、何度同期しても同じ）', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    const before = jcosEstimate(store.p);
    expect((await syncInto(store, deps({ rows: async () => bad }))).ok).toBe(false);
    expect((await syncInto(store, deps({ rows: async () => bad }))).ok).toBe(false);    // もう一度押しても同じ
    expect(jcosEstimate(store.p)).toEqual(before);
    expect(store.p.reportSync!.days.map((x) => [x.date, x.count])).toEqual([['2026-11-13', 62], ['2026-11-14', 58]]);
    const fixed = [...ROWS, row('2026/11/15', 80)];
    expect((await syncInto(store, deps({ rows: async () => fixed }))).ok).toBe(true);
    expect(jcosEstimate(store.p).actualCount).toBe(200);
    await syncInto(store, deps({ rows: async () => fixed }));
    expect(jcosEstimate(store.p).actualCount).toBe(200);
  });
  it('最初の同期で止まったときは、実績を作らない（予定のまま）', async () => {
    const store = { p: P };
    expect((await syncInto(store, deps({ rows: async () => bad }))).ok).toBe(false);
    expect(store.p).toBe(P);
    expect(jcosEstimate(store.p).basis).toBe('planned');
  });
  it('この案件のものでない回答（会期の外・別の会場名・テスト回答）に読み取れない項目があっても、止めない', async () => {
    const rows = [...ROWS, row('2026/11/20', 'たくさん'), row('きのう', 5, '別の会場'), row('2026/11/14', '', '別の会場'), { ...row('', 'x'), event: '【テスト】' }];
    const out = await run(deps({ rows: async () => rows }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sync.days.map((x) => [x.date, x.count])).toEqual([['2026-11-13', 62], ['2026-11-14', 58]]);
  });
});

describe('同期できなかったときの記録（この端末に置いて、画面に出す）', () => {
  const issue = (n: number) => ({ row: n, date: '2026-11-15', items: [{ field: 'キットの使用数', reason: '「キットの使用数」が空欄です' }] });
  const AT = '2026-11-14T09:00:00.000Z';
  const BASE = '2026-11-14T08:00:00.000Z';                        // 失敗したときに案件が持っていた、最後に成功した同期の日時
  it('読み取れない回答は、先頭の 20 件までを持ち、残りは件数だけにする', () => {
    const many = Array.from({ length: MAX_ISSUES_SHOWN + 7 }, (_, i) => issue(i + 2));
    const f = failureOf({ ok: false, code: 'bad-rows', message: 'm', issues: many }, AT, BASE);
    expect([f.at, f.message, f.base, f.issues!.length, f.more]).toEqual([AT, 'm', BASE, MAX_ISSUES_SHOWN, 7]);
    expect(f.issues![0]).toEqual(issue(2));
    const few = failureOf({ ok: false, code: 'bad-rows', message: 'm', issues: [issue(2)] }, AT, '');
    expect(few).toEqual({ at: AT, message: 'm', base: '', issues: [issue(2)] });
    expect(failureOf({ ok: false, code: 'network', message: '通信できません' }, AT, BASE)).toEqual({ at: AT, message: '通信できません', base: BASE });
  });
  it('保存した記録は、読み直しても同じ', () => {
    const f = failureOf({ ok: false, code: 'bad-rows', message: 'm', issues: [issue(2), { row: 5, date: null, items: [{ field: '開催日', reason: '「開催日」が空欄です' }] }] }, AT, BASE);
    expect(hydrateFailure(JSON.parse(JSON.stringify(f)))).toEqual(f);
    const plain = failureOf({ ok: false, code: 'network', message: 'x' }, AT, '');
    expect(hydrateFailure(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
  });
  it('形の合わない記録を読んでも、画面が前提にしている形になる（扱えないものは捨てる）', () => {
    for (const junk of [null, undefined, 'x', 5, [], { at: 5, message: 'm' }, { at: 't' }]) expect(hydrateFailure(junk)).toBeNull();
    expect(hydrateFailure({ at: 't', message: 'm', issues: 'x', more: 3, base: 7 })).toEqual({ at: 't', message: 'm' });
    expect(hydrateFailure({
      at: 't', message: 'm', more: -1, extra: 1,
      issues: [null, 'x', { row: '4', items: [] }, { row: 4, items: 'x' }, { row: 4, date: 'きのう', items: [null, { field: 'f' }, { field: 'f', reason: 'r' }] }, { row: 6, date: '2026-11-15', items: [] }],
    })).toEqual({ at: 't', message: 'm', issues: [{ row: 4, date: null, items: [{ field: 'f', reason: 'r' }] }] });
    const long = hydrateFailure({ at: 't', message: 'm', more: 2, issues: Array.from({ length: 30 }, (_, i) => issue(i + 2)) });
    expect([long!.issues!.length, long!.more]).toEqual([MAX_ISSUES_SHOWN, 2]);
  });
  it('失敗のあとで、同期の結果が新しくなっていたら（ほかの端末で同期が成功した）、古い失敗は出さない。時刻の前後ではなく、同じ結果のままかどうかで見る', () => {
    const f = failureOf({ ok: false, code: 'bad-rows', message: 'm', issues: [issue(2)] }, AT, BASE);
    expect(failureIsCurrent(f, BASE)).toBe(true);                              // 失敗したときと同じ結果のまま → 出す
    expect(failureIsCurrent(f, '2026-11-14T15:00:00.000Z')).toBe(false);       // そのあとで、新しい結果が届いた → 出さない
    expect(failureIsCurrent(f, '2026-11-14T07:00:00.000Z')).toBe(false);       // 時計が遅れている端末の同期でも、結果が変わっていれば出さない
    expect(failureIsCurrent(f, undefined)).toBe(false);
    // まだ 1 度も同期していない案件での失敗
    const first = failureOf({ ok: false, code: 'bad-rows', message: 'm', issues: [issue(2)] }, AT, '');
    expect(failureIsCurrent(first, undefined)).toBe(true);
    expect(failureIsCurrent(first, AT)).toBe(false);
    // 以前の版が書いた記録（基準が無い）は、これまでどおり、次に成功するまで出す
    expect(failureIsCurrent({ at: AT, message: 'm' }, BASE)).toBe(true);
    expect(failureIsCurrent({ at: AT, message: 'm' }, undefined)).toBe(true);
  });
});

// ── Version 5: 会期の変更をともなう同期 ─────────────────────────────
describe('日報の同期: 日報から決めた会期の案件は、連続する日が増えたら、会期を伸ばす', () => {
  const AUTO: Project = { ...P, startDate: '2026-11-13', endDate: '2026-11-13', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-13' } };
  it('伸ばした会期で照合し、結果を書くときに、会期と、会期の控えも書く', async () => {
    const store = { p: AUTO };
    const out = await syncInto(store, deps());
    expect(out).toMatchObject({ ok: true, period: { from: { startDate: '2026-11-13', endDate: '2026-11-13' }, to: { startDate: '2026-11-13', endDate: '2026-11-14' }, notHeld: [] } });
    expect([store.p.startDate, store.p.endDate, store.p.reportPeriod]).toEqual(['2026-11-13', '2026-11-14', { startDate: '2026-11-13', endDate: '2026-11-14' }]);
    expect(store.p.reportSync!.days.map((d) => [d.date, d.count])).toEqual([['2026-11-13', 62], ['2026-11-14', 58]]);
    expect(jcosEstimate(store.p).basis).toBe('actual');
    // もう一度同期しても、同じ（会期も実績も、増えない）
    const again = await syncInto(store, deps());
    expect(again.ok && again.period).toBeUndefined();
    expect([store.p.endDate, jcosEstimate(store.p).actualCount]).toEqual(['2026-11-14', 120]);
  });
  it('案件名の末尾が、前の会期の書き方（日報から作った案件の名前）のままなら、会期に合わせて書き換える。利用者が付けた名前は、変えない', async () => {
    const auto = { p: { ...AUTO, name: `${VENUE.name}（11/13）` } };
    await syncInto(auto, deps());
    expect([auto.p.name, auto.p.endDate]).toEqual([`${VENUE.name}（11/13〜11/14）`, '2026-11-14']);
    const named = { p: { ...AUTO, name: '冬の花あそび' } };
    await syncInto(named, deps());
    expect([named.p.name, named.p.endDate]).toEqual(['冬の花あそび', '2026-11-14']);
    // 会期が変わらない同期では、名前も変えない
    const again = { p: { ...auto.p } };
    await syncInto(again, deps());
    expect(again.p.name).toBe(`${VENUE.name}（11/13〜11/14）`);
  });
  it('会期の端の日の回答が、日報から無くなったら（消された・開催日が直された）、その分だけ会期を縮める。案件名も合わせる', async () => {
    const store = { p: { ...AUTO, name: `${VENUE.name}（11/13〜11/15）`, endDate: '2026-11-15', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-15' } } };
    const out = await syncInto(store, deps());                                          // 日報にあるのは、11/13・11/14 だけ
    expect(out).toMatchObject({ ok: true, period: { to: { startDate: '2026-11-13', endDate: '2026-11-14' }, notHeld: [] } });
    expect([store.p.endDate, store.p.reportPeriod, store.p.name, jcosEstimate(store.p).billDays]).toEqual(['2026-11-14', { startDate: '2026-11-13', endDate: '2026-11-14' }, `${VENUE.name}（11/13〜11/14）`, 2]);
  });
  it('会期を手で決めた案件は、伸ばさない（会期の外の回答は、取り込まずに示す）', async () => {
    const store = { p: { ...AUTO, reportPeriod: undefined } };
    const out = await syncInto(store, deps());
    expect(out.ok && out.period).toBeUndefined();
    expect([store.p.endDate, store.p.reportSync!.days.length, store.p.reportSync!.outside]).toEqual(['2026-11-13', 1, [{ date: '2026-11-14', rows: 1, count: 58 }]]);
  });
  it('同期の途中で、利用者が会期を変えていたら、会期は書き換えない（実績だけを書く）', async () => {
    const out = await run(deps(), AUTO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const edited = { ...AUTO, endDate: '2026-11-20' };                                  // 同期の途中で、終了日を手で変えた
    const next = applySync(edited, out);
    expect([next.startDate, next.endDate, next.reportPeriod]).toEqual(['2026-11-13', '2026-11-20', AUTO.reportPeriod]);
    expect(next.reportSync).toBe(out.sync);
  });
  it('失敗した同期（読み取れない回答）は、会期も実績も変えない', async () => {
    const store = { p: AUTO };
    const out = await syncInto(store, deps({ rows: async () => [row('2026/11/13', 62), row('2026/11/14', '58個')] }));
    expect(out).toMatchObject({ ok: false, code: 'bad-rows' });
    expect(store.p).toBe(AUTO);
  });
});

describe('日報の同期: 利用者が選んだ会期へ広げて取り込む', () => {
  const MANUAL: Project = { ...P, startDate: '2026-11-13', endDate: '2026-11-13' };
  const far = [row('2026/11/13', 62), row('2026/11/14', 58), row('2026/11/16', 40)];
  const widen = (d: SyncDeps, project: Project, period: { startDate: string; endDate: string }) =>
    runReportSync({ project, projects: [project], venues: [VENUE], source: SOURCE, period }, d);
  it('広げた会期で取り込み、回答の無い日（間の日）は、開催していない日（請求しない・アルバイト 0 人）にする', async () => {
    const out = await widen(deps({ rows: async () => far }), MANUAL, { startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(out).toMatchObject({ ok: true, period: { to: { startDate: '2026-11-13', endDate: '2026-11-16' }, notHeld: ['2026-11-15'] } });
    if (!out.ok) return;
    const next = applySync(MANUAL, out);
    // 会期を手で決めた案件は、広げたあとも、手で決めた会期の案件のまま（控えを付けない＝このあとも、自動では変えない）
    expect([next.startDate, next.endDate, next.reportPeriod]).toEqual(['2026-11-13', '2026-11-16', undefined]);
    expect(next.jcos!.days).toEqual({ '2026-11-15': { billed: false, partTimers: 0, notHeld: true } });
    const j = jcosEstimate(next);
    expect([j.periodDays, j.heldDays, j.billDays, j.partTimerDays, j.actualDays, j.actualCount, j.basis]).toEqual([4, 3, 3, 0, 3, 160, 'actual']);
    // 次の日の回答が増えても、自動では伸びない（会期のすぐ外の回答として示す）
    const store = { p: next };
    const again = await syncInto(store, deps({ rows: async () => [...far, row('2026/11/17', 9)] }));
    expect(again.ok && again.period).toBeUndefined();
    expect([store.p.endDate, store.p.reportSync!.outside]).toEqual(['2026-11-16', [{ date: '2026-11-17', rows: 1, count: 9 }]]);
  });
  it('日報から決めた会期の案件を、利用者が選んで広げたときは、日報から決めた会期の案件のまま（控えも合わせる）', async () => {
    const auto: Project = { ...MANUAL, reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-13' } };
    // 11/14 は連続しているので自動で伸びる。11/16 は、利用者が選んで広げる
    const out = await widen(deps({ rows: async () => far }), auto, { startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(out.ok && applySync(auto, out).reportPeriod).toEqual({ startDate: '2026-11-13', endDate: '2026-11-16' });
  });
  it('「開催していない日」としてあった日に、あとから回答が入ったら、同期のときに印を外す（請求する日に戻る。アルバイトは、配置を入れるまで 0 人）', async () => {
    const out = await widen(deps({ rows: async () => far }), MANUAL, { startDate: '2026-11-13', endDate: '2026-11-16' });
    if (!out.ok) throw new Error('unexpected');
    const store = { p: applySync(MANUAL, out) };
    expect(jcosEstimate(store.p).current.gross).toBe(3 * 40000 - 160 * 220);
    // 11/15 の回答が、あとから日報に入った
    await syncInto(store, deps({ rows: async () => [...far, row('2026/11/15', 20)] }));
    expect(store.p.jcos!.days).toEqual({});
    const j = jcosEstimate(store.p);
    expect([j.billDays, j.partTimerDays, j.actualCount, j.current.gross]).toEqual([4, 0, 180, 4 * 40000 - 180 * 220]);
    // 利用者が決めた「請求しない」の日（印の無い日）は、回答が入っても変えない
    const manualDay: Project = { ...MANUAL, endDate: '2026-11-14', jcos: { ...defaultJcos(), days: { '2026-11-14': { billed: false } } } };
    const kept = { p: manualDay };
    await syncInto(kept, deps({ rows: async () => far }));
    expect(kept.p.jcos!.days).toEqual({ '2026-11-14': { billed: false } });
  });
  it('利用者が、間の日をすでに設定していたら、その設定は変えない', async () => {
    const set: Project = { ...MANUAL, jcos: { ...defaultJcos(), days: { '2026-11-15': { partTimers: 2 } } } };
    const out = await widen(deps({ rows: async () => far }), set, { startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(out.ok && applySync(set, out).jcos!.days).toEqual({ '2026-11-15': { partTimers: 2 } });
  });
  it('JCOS 案件でない案件は、会期だけを広げる（日ごとの設定は作らない）', async () => {
    const generic: Project = { ...MANUAL, jcos: undefined };
    const out = await widen(deps({ rows: async () => far }), generic, { startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(out.ok && [applySync(generic, out).endDate, applySync(generic, out).jcos]).toEqual(['2026-11-16', undefined]);
  });
});
