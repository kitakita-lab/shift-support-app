// 「日報を同期」の流れ（sync.ts）のテスト。認証と取得は差し替える。
// 重点: 失敗したときに、案件の実績（前回の同期結果）を消さない・書き換えない。
import { describe, expect, it } from 'vitest';
import { emptyLayout } from '../domain/layout';
import { jcosEstimate, defaultJcos, withJcosDay, withUnitCost } from '../domain/jcos';
import { RawReportRow, contentKey, venueKey } from '../domain/report';
import { mkContent, mkProject } from '../domain/testkit';
import { Project, ReportSource, Venue } from '../types';
import { ReportError, ReportErrorCode } from './sheets';
import { MAX_ISSUES_SHOWN, SyncDeps, SyncOutcome, applySync, clearMessage, clearedBySync, failureIsCurrent, failureOf, hydrateFailure, runReportSync } from './sync';

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

// ── Version 5.3: 前回の実績が、すべて外れることになる結果は、利用者が確かめるまで書かない ─────────────
describe('日報の同期: この案件の回答が、日報から 1 件も無くなったときは、書かずに止めて、確認を求める', () => {
  const OTHER = '北街モール（東口前）';
  /** この案件の回答が 1 件も無い日報（どれも、回答そのものは読み取れる） */
  const emptied: [string, RawReportRow[]][] = [
    ['回答が 1 件も無い日報', []],
    ['この案件の回答だけが、削除された（ほかの会場の回答は、残っている）', [row('2026/11/13', 33, OTHER), row('2026/11/14', 7, OTHER)]],
    ['会場名が、別の書き方に直された', [row('2026/11/13', 62, '北街モール'), row('2026/11/14', 58, '北街モール')]],
    ['開催日が、会期から離れた日に直された', [row('2026/12/20', 62), row('2026/12/21', 58)]],
    ['開催日が、会期のすぐ外の日に直された', [row('2026/11/16', 62), row('2026/11/17', 58)]],
  ];
  for (const [name, rows] of emptied) {
    it(`${name}: 前回の実績（2 日・120 個）と粗利は、そのまま。外れることになる実績を返す`, async () => {
      const store = { p: P };
      await syncInto(store, deps());
      const before = JSON.stringify(store.p);
      const profit = jcosEstimate(store.p).current.gross;
      const out = await syncInto(store, deps({ rows: async () => rows }));
      expect(out).toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
      if (!out.ok) expect(out.message).toBe(clearMessage({ days: 2, count: 120 }));
      expect(JSON.stringify(store.p)).toBe(before);
      expect(jcosEstimate(store.p).current.gross).toBe(profit);
      // もう一度押しても、同じ（何度押しても、確かめるまでは外れない）
      expect(await syncInto(store, deps({ rows: async () => rows }))).toMatchObject({ ok: false, code: 'confirm-clear' });
      expect(JSON.stringify(store.p)).toBe(before);
    });
  }
  it('確認の文は、外れることになる日数・個数と、起きる理由（回答の削除・会場名や開催日の修正・会場マスタや案件の変更）を示す。認証は捨てない', async () => {
    const d = deps({ rows: async () => [] });
    const out = await run(d, { ...P, reportSync: (await run(deps()) as Extract<SyncOutcome, { ok: true }>).sync });
    expect(d.log).toEqual(['token']);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      for (const part of ['1 件もありません', '2 日・キット 120 個', '外していません', '削除された', '会場マスタの会場名・別名', '「前回の実績を外す」']) expect(out.message).toContain(part);
    }
  });
  it('利用者が「前回の実績を外す」を押したとき（allowClear）だけ、日報のとおりに書く（実績 0 日・収支は予定に戻る）。そのあとの同期は、止まらない', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    const cleared = await runReportSync({ project: store.p, projects: [store.p], venues: [VENUE], source: SOURCE, allowClear: true }, deps({ rows: async () => [] }));
    expect(cleared.ok).toBe(true);
    if (cleared.ok) store.p = applySync(store.p, cleared);
    expect([store.p.reportSync!.days, jcosEstimate(store.p).basis, jcosEstimate(store.p).actualCount]).toEqual([[], 'planned', 0]);
    // 前回の実績が 0 日になったあとは、回答が無いままでも、確認は求めない（外れるものが無い）
    expect((await syncInto(store, deps({ rows: async () => [] }))).ok).toBe(true);
    // 回答が戻れば、ふつうに取り込む
    expect((await syncInto(store, deps())).ok).toBe(true);
    expect(jcosEstimate(store.p).actualCount).toBe(120);
  });
  it('allowClear は、「外してよい」というだけ。回答があれば、ふつうの同期と同じ結果になる（実績は外れない）', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    const out = await runReportSync({ project: store.p, projects: [store.p], venues: [VENUE], source: SOURCE, allowClear: true }, deps());
    expect(out.ok && out.sync.days.map((x) => [x.date, x.count])).toEqual([['2026-11-13', 62], ['2026-11-14', 58]]);
  });
  it('回答が一部だけ無くなった場合（残りの回答がある）は、止めない。日報のとおりに置き換える', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    expect((await syncInto(store, deps({ rows: async () => [row('2026/11/14', 58)] }))).ok).toBe(true);
    expect(store.p.reportSync!.days.map((x) => [x.date, x.count])).toEqual([['2026-11-14', 58]]);
  });
  it('まだ同期していない案件・前回の実績が 0 日の案件は、回答が無くても止めない（外れるものが無い）', async () => {
    const first = await run(deps({ rows: async () => [] }));
    expect(first.ok && first.sync.days).toEqual([]);
    const store = { p: P };
    await syncInto(store, deps({ rows: async () => [row('2026/11/13', 33, OTHER)] }));
    expect(store.p.reportSync!.days).toEqual([]);
    expect((await syncInto(store, deps({ rows: async () => [] }))).ok).toBe(true);
  });
  it('会場マスタの別名を消して、照合が切れたときも止まる（自動で外すと、気づかないうちに実績が消える）。別名を戻して同期すると、元どおり', async () => {
    const alias: Venue = { ...VENUE, reportNames: ['北街モール'] };
    const rows = [row('2026/11/13', 62, '北街モール'), row('2026/11/14', 58, '北街モール')];
    const sync = (project: Project, venues: Venue[]) => runReportSync({ project, projects: [project], venues, source: SOURCE }, deps({ rows: async () => rows }));
    const a = await sync(P, [alias]);
    expect(a.ok).toBe(true);
    const synced = a.ok ? applySync(P, a) : P;
    expect(jcosEstimate(synced, { projects: [synced], venues: [alias] }).actualCount).toBe(120);
    expect(await sync(synced, [VENUE])).toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
    const b = await sync(synced, [alias]);
    expect(b.ok && b.sync.days.map((x) => [x.date, x.count])).toEqual([['2026-11-13', 62], ['2026-11-14', 58]]);
  });
  it('日報から決めた会期の案件でも止まる。会期も、案件名も、変えない', async () => {
    const AUTO: Project = { ...P, name: `${VENUE.name}（11/13〜11/14）`, startDate: '2026-11-13', endDate: '2026-11-14', reportPeriod: { startDate: '2026-11-13', endDate: '2026-11-14' } };
    const store = { p: AUTO };
    await syncInto(store, deps());
    const before = JSON.stringify(store.p);
    expect(await syncInto(store, deps({ rows: async () => [row('2026/11/13', 33, OTHER)] }))).toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
    expect(JSON.stringify(store.p)).toBe(before);
  });
  it('回答が日報に残っていて、行き先が決まっていない・相手の案件に決まった、というだけのときは、止めない（保留の日・相手の案件が決めた日）', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    // あとから、同じ会場・同じ会期の案件ができた → どちらの実績か決まらないので、保留になる（回答は、日報に残っている）
    const rival = mkProject({ id: 'p2', name: '相手の案件', venueId: 'v1', startDate: '2026-11-13', endDate: '2026-11-15', jcos: defaultJcos(), assignments: [] });
    const held = await runReportSync({ project: store.p, projects: [store.p, rival], venues: [VENUE], source: SOURCE }, deps());
    expect(held.ok && [held.sync.days.length, held.sync.held.map((h) => h.date)]).toEqual([0, ['2026-11-13', '2026-11-14']]);
    // 相手の案件が「自分の実績にする」と決めた → この案件の結果からは外れる（相手の案件のもの）
    const claimed = { ...rival, reportClaims: ['2026-11-13', '2026-11-14'] };
    const theirs = await runReportSync({ project: store.p, projects: [store.p, claimed], venues: [VENUE], source: SOURCE }, deps());
    expect(theirs.ok && [theirs.sync.days.length, theirs.sync.skipped.map((x) => x.reason)]).toEqual([0, ['other-project']]);
  });
  it('保留の日・相手の案件の日があっても、それとは関係の無い日の実績が、すべて外れるなら、止める（事前の点検の指摘）', async () => {
    // 前回の実績は 11/13・11/14。そのあと、11/15 だけ会期が重なる案件ができ、11/13・11/14 の回答は、日報から消えた（11/15 の回答は、保留になる）
    const store = { p: P };
    await syncInto(store, deps());
    const before = JSON.stringify(store.p);
    const rival = mkProject({ id: 'p2', name: '相手の案件', venueId: 'v1', startDate: '2026-11-15', endDate: '2026-11-16', jcos: defaultJcos(), assignments: [] });
    const rows = [row('2026/11/15', 40)];
    const out = await runReportSync({ project: store.p, projects: [store.p, rival], venues: [VENUE], source: SOURCE }, deps({ rows: async () => rows }));
    expect(out).toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
    expect(JSON.stringify(store.p)).toBe(before);
    // 相手の案件が、11/15 を自分の実績と決めている場合も、同じ（11/13・11/14 が外れる理由には、ならない）
    const claimed = { ...rival, reportClaims: ['2026-11-15'] };
    expect(await runReportSync({ project: store.p, projects: [store.p, claimed], venues: [VENUE], source: SOURCE }, deps({ rows: async () => rows })))
      .toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
    // 前回の実績の一部の日だけが、保留になった場合も、残りの日（11/13）の回答が消えていれば、止める
    const half = mkProject({ id: 'p3', name: '相手の案件 2', venueId: 'v1', startDate: '2026-11-14', endDate: '2026-11-14', jcos: defaultJcos(), assignments: [] });
    expect(await runReportSync({ project: store.p, projects: [store.p, half], venues: [VENUE], source: SOURCE }, deps({ rows: async () => [row('2026/11/14', 58)] })))
      .toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120 } });
  });
  it('確認を求めた同期が読んだ日報の場所を、記録に持つ（「前回の実績を外す」は、同じ日報を読み直す。開き直したあとでも）', async () => {
    const store = { p: P };
    await syncInto(store, deps());
    const other: ReportSource = { spreadsheetId: 'sheet-2', gid: 7 };
    const out = await run(deps({ rows: async () => [] }), store.p, other);
    expect(out).toMatchObject({ ok: false, code: 'confirm-clear', clear: { days: 2, count: 120, source: other } });
    if (!out.ok) {
      const f = failureOf(out, '2026-11-14T10:00:00.000Z', store.p.reportSync!.at);
      expect(f.clear).toEqual({ days: 2, count: 120, source: other });
      expect(hydrateFailure(JSON.parse(JSON.stringify(f)))).toEqual(f);
    }
    // 場所の形が合わない記録は、場所だけを捨てる（確認そのものは、出す）
    for (const junk of [null, 'x', {}, { spreadsheetId: '' }, { spreadsheetId: 5 }, []]) {
      expect(hydrateFailure({ at: 't', message: 'm', clear: { days: 2, count: 120, source: junk } })).toEqual({ at: 't', message: 'm', clear: { days: 2, count: 120 } });
    }
    expect(hydrateFailure({ at: 't', message: 'm', clear: { days: 2, count: 120, source: { spreadsheetId: 's', gid: 'x' } } })!.clear).toEqual({ days: 2, count: 120, source: { spreadsheetId: 's', gid: null } });
  });
  it('clearedBySync: 外れることになる日数・個数。前回の結果の形が壊れていても、落ちない', () => {
    const next = (over: Partial<Extract<SyncOutcome, { ok: true }>['sync']> = {}) => ({
      at: 't', venueId: 'v1', startDate: '2026-11-13', endDate: '2026-11-15', days: [], rowsRead: 0, rowsUsed: 0, tests: 0, skipped: [], held: [], unmatched: [], ...over,
    });
    const day = (date: string, count: number) => ({ date, count, rows: 1 });
    const stored = next({ days: [day('2026-11-13', 62), day('2026-11-14', 58)] });
    expect(clearedBySync(stored, next())).toEqual({ days: 2, count: 120 });
    expect(clearedBySync(stored, next({ days: [day('2026-11-13', 1)] }))).toBeNull();
    // 前回の実績のあった日が、どれも、保留の日か、相手の案件が決めた日 → 回答は日報に残っている。確認は求めない
    const held = (date: string) => ({ date, count: 60, rows: 1, others: ['相手'] });
    expect(clearedBySync(stored, next({ held: [held('2026-11-13'), held('2026-11-14')] }))).toBeNull();
    expect(clearedBySync(stored, next({ skipped: [{ reason: 'other-project', rows: 2, dates: ['2026-11-13', '2026-11-14'] }] }))).toBeNull();
    expect(clearedBySync(stored, next({ held: [held('2026-11-13')], skipped: [{ reason: 'other-project', rows: 1, dates: ['2026-11-14'] }] }))).toBeNull();
    // 1 日でも、説明のつかない日（保留でも、相手の案件の日でもない）が外れるなら、確認を求める
    expect(clearedBySync(stored, next({ held: [held('2026-11-13')] }))).toEqual({ days: 2, count: 120 });
    expect(clearedBySync(stored, next({ skipped: [{ reason: 'other-project', rows: 1, dates: ['2026-11-13'] }] }))).toEqual({ days: 2, count: 120 });
    expect(clearedBySync(stored, next({ held: [held('2026-11-16')] }))).toEqual({ days: 2, count: 120 });      // 関係の無い日の保留
    // 読み取れない回答の印（以前の版の結果にだけ残る）は、説明にならない
    expect(clearedBySync(stored, next({ skipped: [{ reason: 'bad-count', rows: 2, dates: ['2026-11-13', '2026-11-14'] }] }))).toEqual({ days: 2, count: 120 });
    // 会場名の違う回答・会期のすぐ外の回答が残っていても、この案件の実績になる回答は無い → 確認を求める
    expect(clearedBySync(stored, next({ unmatched: [{ venue: 'ほか', rows: 1, count: 3, dates: ['2026-11-13'] }], outside: [{ date: '2026-11-16', rows: 1, count: 5 }] }))).toEqual({ days: 2, count: 120 });
    expect(clearedBySync(undefined, next())).toBeNull();
    expect(clearedBySync(next(), next())).toBeNull();
    expect(clearedBySync({ ...stored, days: 'x' as unknown as typeof stored.days }, next())).toBeNull();
    expect(clearedBySync({ ...stored, days: [{ date: '2026-11-13', count: Number.NaN, rows: 1 }, day('2026-11-14', 58)] }, next())).toEqual({ days: 2, count: 58 });
    // 個数が整数でない・マイナスの記録は、合計に入れない（記録の「個数」が、0 以上の整数のままになる＝読み直しても、確認のボタンが出る）
    expect(clearedBySync({ ...stored, days: [day('2026-11-13', 1.5), day('2026-11-14', -3), day('2026-11-15', 7)] }, next())).toEqual({ days: 3, count: 7 });
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
  it('前回の実績が、すべて外れることになるので止めたときは、外れることになる実績を持つ（画面は、これを見て「前回の実績を外す」を出す）。読み直しても同じ', () => {
    const f = failureOf({ ok: false, code: 'confirm-clear', message: 'm', clear: { days: 2, count: 120 } }, AT, BASE);
    expect(f).toEqual({ at: AT, message: 'm', base: BASE, clear: { days: 2, count: 120 } });
    expect(hydrateFailure(JSON.parse(JSON.stringify(f)))).toEqual(f);
    // ふつうの失敗には、付かない
    expect('clear' in failureOf({ ok: false, code: 'network', message: 'x' }, AT, BASE)).toBe(false);
    // 形の合わないものは、捨てる（「前回の実績を外す」を、根拠なしに出さない）
    for (const junk of [null, 'x', 5, [], {}, { days: 0, count: 0 }, { days: -1, count: 3 }, { days: 1.5, count: 3 }, { days: 2 }, { days: '2', count: 120 }, { days: 2, count: -1 }]) {
      expect(hydrateFailure({ at: AT, message: 'm', clear: junk })).toEqual({ at: AT, message: 'm' });
    }
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
