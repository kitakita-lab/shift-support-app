// 案件一覧の「日報から案件を作成・更新」。
// 1 回押すと、認証 → 日報の必要な列だけを取得 → 開催（会場 × 連続した開催日）ごとに、案件と照らす。
//   - 既存の案件の更新は、そのまま反映する（案件の「日報を同期」と同じ処理・同じ決まり。report/syncJob.ts）
//   - 新しい案件は、候補を見せて、1 回の操作で作成する（会場マスタに無い会場は、一緒に登録する）
//   - 決められないもの（会期が重なる案件が複数・記号だけが違う会場名・既存の案件のすぐ近くの開催・読み取れない回答・会期の外の回答）だけ、確認を求める
//     （「同じ会場」と答えたら、その場で会場マスタに別名を登録する。以後は、登録済みの会場として扱われる）
// 決まりそのものは domain/reportImport.ts（純関数）。読んだ回答は、このタブのメモリにだけ置く（report/importJob.ts）。
//
// 守ること:
//   - 読んだ内容で書く（作成・反映・会場の登録）のは、取得から FRESH_MS 以内だけ。押したときの時刻で確かめる
//   - 読んだあとで、案件の画面・ほかの端末で同期された案件（同期の日時が、取得より新しい）は、読んだ内容で上書きしない
//     （読んだ内容で書くときの同期の日時は、日報を読んだ日時から、1 回ごとに 1 ミリ秒ずつ進めたもの。importJob.issueStamp）
//   - 共有データの最新の内容を確認できていない間（圏外・受信中）は、書かない（古い案件の一覧と照らして、同じ案件を二重に作らない）
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { isJcos, jcosEstimate } from '../domain/jcos';
import { latestReportSource, parseSheetUrl } from '../domain/report';
import { CreateItem, ImportItem, ImportPlan, ImportTotals, UpdateItem, dateRanges, importCreates, planReportImport, reportRuns, withSameVenue } from '../domain/reportImport';
import { shortDate } from '../domain/util';
import { isFirebaseConfigured } from '../firebase';
import { forgetSheetsToken, requestSheetsToken } from '../report/googleToken';
import {
  abandonFetch, claimAutoApply, clearFetched, fetchFailure, fetchKey, fetchRunningSince, fetchSession, fetchedReport, fetchesVersion, isFetchRunning,
  issueStamp, latestStamp, noteCreated, noteUpdated, rearmAutoApply, startFetch, subscribeFetches, wasUpdated,
} from '../report/importJob';
import { lastFailure, loadImportRecord, loadSourceRecord, recordFailure, recordSyncResult, saveImportRecord, saveSource } from '../report/records';
import { fetchReportRows } from '../report/sheets';
import { failureIsCurrent } from '../report/sync';
import { isSyncRunning, startSyncJob, subscribeSyncJobs, syncJobsVersion, syncKey } from '../report/syncJob';
import { AppData, Project, ReportSource, Venue } from '../types';

interface Props {
  data: AppData;
  /** 表示している置き場所（共有データか、この端末だけのデータか） */
  scope: 'shared' | 'local';
  /** 表示している内容が、置き場所の最新の内容か（共有データで、圏外・受信中のときは false。その間は、作成・反映をしない） */
  live: boolean;
  /** 同じ置き場所の、いまの案件（画面の描画を待たずに読む） */
  getProject: (id: string) => Project | undefined;
  updateProject: (id: string, fn: (p: Project) => Project) => void;
  addProject: (p: Project) => void;
  /** 会場マスタの置き換え（新しい会場の登録・別名の追加） */
  setVenues: (venues: Venue[]) => void;
  notify: (kind: 'info' | 'warn', text: string) => void;
  onOpen: (projectId: string) => void;
}

/** 取得してから、この時間を過ぎた日報では、作成・反映をしない（取り直してもらう。古い内容で案件を作らないため） */
const FRESH_MS = 10 * 60 * 1000;
/** 取得を始めてから、「取得をやめる」を出すまでの時間 */
const SLOW_MS = 4000;

/**
 * 画面での選択（内容を開いているか・「同じ案件にする」と選んだ開催・会場の選択・チェックの付け外し）。
 * 案件を開くと、この部品は画面から外れる。戻ってきたときに選び直さずに済むように、部品の外（このタブのメモリ）に置く。
 * 置き場所 ＋ アカウントごと。新しく取得を始めたとき・アカウントが変わったときに、捨てる。
 */
interface PanelState {
  open: boolean;
  /** 「前の開催と同じ案件にする」と選んだ開催 */
  joins: ReadonlySet<string>;
  /** 記号だけが違う会場があるときに、「別の会場（新しく登録）」を選んだ会場（会場を見分けるキー → そのときの選択の値） */
  choice: Readonly<Record<string, string>>;
  /** チェックを外した候補 */
  off: ReadonlySet<string>;
  /** 既存の案件のすぐ近くの開催のうち、「別の開催（新しい案件の候補にする）」を選んだもの */
  separate: ReadonlySet<string>;
}
const EMPTY_PANEL: PanelState = { open: false, joins: new Set(), choice: {}, off: new Set(), separate: new Set() };
const panels = new Map<string, PanelState>();

/**
 * 読んだ日報と、画面での選択を、すべて捨てる（ログアウト・アカウントの切り替えのとき。前のアカウントの権限で読んだ内容を、残さない）。
 * 一覧が画面に出ていないとき（ほかのタブ・案件の画面）にも効くように、アプリの側（App）から呼ぶ。
 */
export function forgetReportImports(): void {
  clearFetched();
  panels.clear();
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 開催日の書き方（11/13(金)〜11/14(土)・11/16(月)） */
const ranges = (ds: string[]): string => dateRanges(ds).map(([a, b]) => (a === b ? shortDate(a) : `${shortDate(a)}〜${shortDate(b)}`)).join('・');
const span = (a: string, b: string): string => (a === b ? shortDate(a) : `${shortDate(a)}〜${shortDate(b)}`);
const tally = (label: string, v: number | null, missing: number): string =>
  (v == null ? `${label} 未入力` : `${label} ${v}${missing > 0 ? `（未入力 ${missing} 日）` : ''}`);
const totalsText = (t: ImportTotals): string => `${t.days} 日・キット ${t.count} 個・${tally('組数', t.groups, t.groupsMissing)}・${tally('人数', t.people, t.peopleMissing)}`;

/** 既存の案件の行の状態。newer … この取得のあとで、案件の画面・ほかの端末で同期されている（読んだ内容では上書きしない） */
type RowState = 'running' | 'failed' | 'pending' | 'done' | 'newer';

export default function ReportImport({ data, scope, live, getProject, updateProject, addProject, setVenues, notify, onOpen }: Props) {
  const { user } = useAuth();
  const canSync = isFirebaseConfigured && !!user;
  const key = fetchKey(scope, user?.uid ?? '');
  // 取得の状態・案件の同期の状態は、この部品の外にある。変わったら読み直す
  useSyncExternalStore(subscribeFetches, fetchesVersion);
  useSyncExternalStore(subscribeSyncJobs, syncJobsVersion);
  const busy = isFetchRunning(key);
  const report = fetchedReport(key);
  const failure = fetchFailure(key);
  const session = fetchSession(key);

  // 画面での選択は、部品の外に置く（案件を開いて戻ってきても、残る）
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const { open, joins, choice, off, separate } = panels.get(key) ?? EMPTY_PANEL;
  const setPanel = (patch: Partial<PanelState>): void => { panels.set(key, { ...(panels.get(key) ?? EMPTY_PANEL), ...patch }); redraw(); };
  const setOpen = (v: boolean): void => setPanel({ open: v });
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [slow, setSlow] = useState(false);
  /** 取得してからの時間を見るための時刻（表示用。1 分ごとに進める。書く操作は、押したときの時刻で確かめる＝isFresh） */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 60000); return () => clearInterval(t); }, []);

  // 取得が長引いているときだけ、「取得をやめる」を出す
  useEffect(() => {
    if (!busy) { setSlow(false); return undefined; }
    const wait = SLOW_MS - (Date.now() - (fetchRunningSince(key) ?? Date.now()));
    if (wait <= 0) { setSlow(true); return undefined; }
    const t = setTimeout(() => setSlow(true), wait);
    return () => clearTimeout(t);
  }, [busy, key]);

  // 日報の場所: この端末で最後に使った場所と、案件に記録されている場所（ほかの端末が使った場所）の、新しいほう。
  // 描画のたびに読み直す（端末の記録は、取得のあとの処理で書き換わる。覚えておくと、書き換わる前の内容を使い続けてしまう）
  const known = ((): ReportSource | null => {
    const mine = loadSourceRecord(scope);
    const theirs = latestReportSource(data.projects);
    if (mine && (!theirs || mine.at >= theirs.at)) return mine.source;
    return theirs?.source ?? mine?.source ?? null;
  })();
  const needsSource = !known?.spreadsheetId || editing;
  const record = useMemo(() => loadImportRecord(key), [key, report]);
  const fresh = !!report && clock - Date.parse(report.at) < FRESH_MS;
  /** 読んだ内容で、いま書いてよいか（押したときの時刻で確かめる。画面の表示は 1 分ごとにしか進まない） */
  const isFresh = (): boolean => !!report && Date.now() - Date.parse(report.at) < FRESH_MS;
  /** ボタンを押したときに確かめる。古くなっていたら、画面の表示も進める（「取得から時間がたっています」を出して、ボタンを押せなくする） */
  const freshNow = (): boolean => { if (isFresh()) return true; setClock(Date.now()); return false; };
  /** 書く操作のボタンを押せるか（表示用） */
  const usable = fresh && live;

  const plan = useMemo(() => (report
    ? planReportImport({ rows: report.rows, projects: data.projects, venues: data.venues, source: report.source, now: report.at, joins, venueChoice: choice })
    : null), [report, data.projects, data.venues, joins, choice]);

  /** この取得のあとで、同期されている案件か（案件の画面・ほかの端末で。読んだ内容は、その同期より古いので、上書きしない） */
  const isNewer = (p: Project | undefined): boolean => !!report && !!p?.reportSync && p.reportSync.at > (latestStamp(key) ?? report.at);
  /** 別の日報（スプレッドシート）で同期している案件か（自動では置き換えない。利用者が「反映する」を押したときだけ） */
  const otherSheet = (p: Project | undefined): boolean => !!report && !!p?.reportSource?.spreadsheetId && p.reportSource.spreadsheetId !== report.source.spreadsheetId;

  /**
   * 案件 1 件を、読んである日報で同期する（案件の「日報を同期」と同じ処理。period … 会期を広げて取り込むとき）。
   * 同期の日時は、日報を読んだ日時にする（読んだあとで行われた、新しい同期と見分けるため）。
   */
  const runUpdate = (projectId: string, period?: { startDate: string; endDate: string }): void => {
    const project = data.projects.find((p) => p.id === projectId);
    if (!project || !report || !plan || !isFresh() || !live || isNewer(getProject(projectId) ?? project)) return;
    const k = syncKey(scope, projectId);
    if (isSyncRunning(k)) return;
    const { rows, source } = report;
    const at = issueStamp(key) ?? report.at;
    // ほかの案件は、この取得で会期を合わせたあとの見込み（plan.projected）で見る（一覧の見込みと、書く内容を、同じにする）
    const projects = plan.projected.map((q) => (q.id === projectId ? project : q));
    void startSyncJob(
      k,
      { project, projects, venues: data.venues, source, period },
      // 回答は、読んであるものを使う（もう一度は読まない。認証も要らない）
      { token: async () => '', rows: async () => rows, now: () => at, forget: () => {} },
      {
        current: () => getProject(projectId),
        update: (fn) => updateProject(projectId, fn),
        settled: (r) => {
          recordSyncResult(k, r, source, scope);
          if (r.kind !== 'applied') return;
          noteUpdated(key, projectId);
          // 会期が変わると、ほかの案件の「会期のすぐ外にある回答」が変わることがある。もう一度だけ、自動で合わせ直す
          if (r.outcome.period) rearmAutoApply(key);
        },
      },
    );
  };

  // 新しく読んだ日報について、既存の案件の更新を、1 回だけ自動で始める（変わるものだけ。同じ内容なら、何も書かない）。
  // 古くなった内容・最新の内容を確認できていない共有データでは、始めない（確認できてから始める）
  useEffect(() => {
    if (!report || !plan || !live || !isFresh() || !claimAutoApply(key)) return;
    for (const item of plan.items) {
      if (item.kind !== 'update') continue;
      const p = data.projects.find((x) => x.id === item.projectId);
      if (!p || isNewer(p) || otherSheet(p)) continue;
      // 止まる見込みのものも、同期にかける（案件のデータは変えずに、止まった理由を、その案件に記録する）
      if (!item.preview.ok || item.preview.changed) { runUpdate(item.projectId); continue; }
      // 読めて、日報と同じ内容と確かめた案件に残っている、この取得より前の失敗の記録は、消す（案件の画面に、古い失敗を出し続けない）。
      // この取得のあとの失敗（この一覧での「会期を広げて取り込む」の失敗・案件の画面での同期の失敗）は、消さない
      const k = syncKey(scope, item.projectId);
      const f = lastFailure(k);
      if (f && f.at < report.at) recordFailure(k, null);
    }
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, plan, key, scope, live]);

  const start = (): void => {
    if (!canSync || busy) return;
    let source: ReportSource | null = known;
    if (needsSource) {
      source = parseSheetUrl(url);
      if (!source) { setUrlError('スプレッドシートの URL（https://docs.google.com/spreadsheets/d/… で始まるもの）を貼り付けてください。'); setOpen(true); return; }
      setUrlError('');
    }
    if (!source) return;
    // 取得を始めたら、前に読んだ内容（importJob）も、前の選択も、捨てる
    panels.set(key, { ...EMPTY_PANEL, open: true });
    redraw();
    // startFetch は、最初に（何も待たずに）認証を呼ぶ。ここはボタンのタップの中なので、Google の画面が止められない
    const job = startFetch(key, source, { token: requestSheetsToken, rows: fetchReportRows, now: () => new Date().toISOString(), forget: forgetSheetsToken });
    void job?.then((r) => {
      if (r.kind !== 'fetched') return;
      // 読めた時点で、日報の場所と、取得のまとめ（日時・回答の数）を、この端末に覚える（この画面を離れていても、覚える）
      saveSource(scope, r.report.source);
      const read = reportRuns(r.report.rows);
      saveImportRecord(key, { at: r.report.at, rows: read.rowsRead - read.tests });
      setClock(Date.now());
      setEditing(false);
      setUrl('');
    });
  };

  const items: ImportItem[] = plan?.items ?? [];
  const creates = items.filter((i): i is CreateItem => i.kind === 'create');
  const blocked = creates.filter((c) => c.blocked);
  // 既存の案件のすぐ近くの開催は、利用者が「別の開催」と選ぶまで、候補にしない（同じ開催なら、その案件の会期を広げる）
  const nearby = creates.filter((c) => !c.blocked && c.near.length > 0 && !separate.has(c.id));
  const ready = creates.filter((c) => !c.blocked && !nearby.includes(c));
  const chosen = ready.filter((c) => !off.has(c.id));
  const updates = items.filter((i): i is UpdateItem => i.kind === 'update');
  const ambiguous = items.filter((i) => i.kind === 'ambiguous');
  const projectOf = (id: string): Project | undefined => data.projects.find((x) => x.id === id);
  /**
   * いまの日報での、この案件の同期の失敗（無ければ null）。この取得より前の失敗（案件の画面で、以前に失敗した同期）は、数えない
   * （いまの日報で確かめた結果を出す。以前の失敗は、案件の画面に出ている）。
   */
  const failureOf = (u: UpdateItem) => {
    const f = lastFailure(syncKey(scope, u.projectId));
    return f && report && f.at >= report.at && failureIsCurrent(f, projectOf(u.projectId)?.reportSync?.at) ? f : null;
  };
  /** 更新の行の状態 */
  const stateOf = (u: UpdateItem): RowState => {
    if (isSyncRunning(syncKey(scope, u.projectId))) return 'running';
    if (isNewer(projectOf(u.projectId))) return 'newer';
    if (!u.preview.ok || failureOf(u)) return 'failed';
    return u.preview.changed ? 'pending' : 'done';
  };
  // 手入力の実績個数と、日報の個数が違う日（競合）のある案件。計算には日報を使い、手入力の値は残している（案件の画面で確かめる）
  const conflicts = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of plan?.items ?? []) {
      if (i.kind !== 'update') continue;
      const p = data.projects.find((x) => x.id === i.projectId);
      const n = p && isJcos(p) ? jcosEstimate(p, data).conflicts.length : 0;
      if (n > 0) out.set(i.projectId, n);
    }
    return out;
  }, [plan, data]);
  const states = new Map(updates.map((u) => [u.projectId, stateOf(u)]));
  const inState = (...ss: RowState[]) => updates.filter((u) => ss.includes(states.get(u.projectId)!));
  const outside = updates.filter((u) => u.outside.length > 0 && states.get(u.projectId) !== 'newer');
  // 見せておく行（反映中・失敗・未反映・この取得で更新した・確認が要る）と、たたんでおく行（日報と同じ内容で、変わっていない）
  const shown = updates.filter((u) => states.get(u.projectId) !== 'done' || wasUpdated(key, u.projectId) || u.outside.length > 0 || conflicts.has(u.projectId));
  const quiet = updates.filter((u) => !shown.includes(u));
  // 確認が必要なものの数（1 つの案件に、失敗・未反映・会期の外の回答・競合が重なっていても、1 件と数える）
  const flagged = new Set([...inState('failed', 'pending'), ...outside].map((u) => u.projectId).concat([...conflicts.keys()]));
  const attention = blocked.length + nearby.length + ambiguous.length + flagged.size + (plan && plan.loose.length > 0 ? 1 : 0);

  /** 同じ計画から、2 回は作らない（計画は、案件・会場が変わるたびに作り直される） */
  const created = useRef<ImportPlan | null>(null);
  const createNow = (): void => {
    if (!plan || !report || !freshNow() || !live || chosen.length === 0 || created.current === plan) return;
    const r = importCreates(plan, new Set(chosen.map((c) => c.id)), { rows: report.rows, projects: data.projects, venues: data.venues, now: issueStamp(key) ?? report.at });
    if (r.projects.length === 0) return;
    created.current = plan;
    // 新しい案件ができると、前からある案件の「会期のすぐ外にある回答」が変わることがある。このあと、もう一度だけ合わせ直す
    rearmAutoApply(key);
    if (r.addedVenues.length > 0) setVenues(r.venues);
    for (const p of r.projects) addProject(p);
    noteCreated(key, r.projects.length);
    notify('info', [
      `日報から、案件 ${r.projects.length} 件を作成しました（実績つき）。`,
      r.addedVenues.length > 0 ? `会場マスタに無かった会場 ${r.addedVenues.length} 件（${r.addedVenues.map((v) => `「${v.name}」`).join('')}）を、新しく登録しました。` : '',
      '請求・支払いの金額は、標準の初期値です。案件ごとに確認してください。',
    ].filter(Boolean).join(' '));
  };

  /** 「同じ会場」… その場で会場マスタに反映する。その会場に、開催日を会期に含む案件があれば、その案件の更新になるので、もう一度だけ自動で反映する */
  const sameVenue = (target: { venueId: string } | { name: string }, alias: string): void => {
    if (!freshNow() || !live) return;
    const next = withSameVenue(data.venues, target, alias);
    if (next === data.venues) return;
    rearmAutoApply(key);
    setVenues(next);
  };

  const join = (runId: string, on: boolean): void => {
    const next = new Set(joins);
    if (on) next.add(runId); else next.delete(runId);
    setPanel({ joins: next });
  };

  const summary = ((): string => {
    if (busy) return '日報を取得しています…';
    if (!report || !plan) {
      if (failure) return `取得できませんでした（${stamp(failure.at)}）`;
      return record ? `前回の取得 ${stamp(record.at)}・回答 ${record.rows} 件（もう一度押すと、最新の日報で確かめます）` : 'まだ取得していません';
    }
    const nPending = inState('pending').length;
    const notes = [nPending > 0 ? `未反映 ${nPending} 件` : '', conflicts.size > 0 ? `手入力との競合 ${conflicts.size} 件` : ''].filter(Boolean).join('・');
    const parts = [
      `取得 ${stamp(report.at)}・回答 ${plan.rowsRead - plan.tests} 件${plan.tests > 0 ? `（テスト回答 ${plan.tests} 件を除く）` : ''}`,
      plan.span ? `対象期間 ${span(plan.span.startDate, plan.span.endDate)}` : '',
      `新しい案件の候補 ${ready.length} 件`,
      `既存の案件 ${updates.length} 件${session.updated > 0 ? `（更新 ${session.updated} 件）` : ''}`,
      session.created > 0 ? `作成 ${session.created} 件` : '',
      // 「未反映・競合なし」と出すのは、確認が要るものも、まだ作っていない候補も、無いときだけ
      attention > 0 ? `確認が必要 ${attention} 件${notes ? `（うち、${notes}）` : ''}` : ready.length > 0 ? '' : '未反映・競合なし',
    ];
    return parts.filter(Boolean).join('／');
  })();

  const tone = failure ? ' rimport--error' : attention > 0 ? ' rimport--warn' : '';
  const joinNote = (item: CreateItem) => {
    const prev = item.joinPrev ? plan?.items.find((i) => i.kind === 'create' && i.runs.some((r) => r.id === item.joinPrev!.prevId)) : undefined;
    return (
      <>
        {item.joinPrev && prev && (
          <p className="rimport__sub">
            同じ会場の、前の開催（{span(prev.startDate, prev.endDate)}）から {item.joinPrev.gap} 日あいています。同じ開催なら：{' '}
            <button className="cellbtn cellbtn--wide" onClick={() => join(item.joinPrev!.runId, true)} data-testid="import-join">
              前の開催と同じ案件にする
            </button>
          </p>
        )}
        {item.runs.filter((r) => r.joined).map((r) => (
          <p className="rimport__sub" key={r.id}>
            {span(r.startDate, r.endDate)} を、同じ案件にまとめています（間の {ranges(item.gaps)} は、開催していない日として扱います）。{' '}
            <button className="cellbtn cellbtn--wide" onClick={() => join(r.id, false)} data-testid="import-split">分ける</button>
          </p>
        ))}
      </>
    );
  };

  const updateRow = (u: UpdateItem) => {
    const st = states.get(u.projectId)!;
    const f = failureOf(u);
    const nConflict = conflicts.get(u.projectId) ?? 0;
    const target = projectOf(u.projectId);
    const label = {
      running: '反映中…', failed: '✕ 反映できませんでした', pending: '未反映', newer: 'この取得のあとに同期済み',
      done: wasUpdated(key, u.projectId) ? '✓ 日報の内容に更新しました' : '✓ 日報と同じ内容です',
    }[st];
    return (
      <li key={u.projectId} data-testid="import-update" data-project={u.projectId} data-state={st}>
        <p className="rimport__row">
          <button className="rimport__open" onClick={() => onOpen(u.projectId)}>{u.projectName}</button>
          <span className={`tag${st === 'done' ? ' tag--on' : ''}`}>{label}</span>
        </p>
        {st === 'newer' ? (
          <p className="rimport__sub" data-testid="import-newer">
            会場：{u.venueName}／この取得（{stamp(report!.at)}）のあとで、案件の画面か、ほかの端末で同期されています。ここで読んだ内容では、上書きしません（もう一度取得すると、最新の日報で確かめます）。
          </p>
        ) : (
          <p className="rimport__sub">会場：{u.venueName}／{u.preview.ok ? totalsText(u.preview.totals) : `開催日：${ranges(u.dates)}`}</p>
        )}
        {st === 'failed' && <p className="rimport__sub neg">{u.preview.ok ? f?.message : u.preview.message}</p>}
        {st === 'failed' && !u.preview.ok && u.preview.issues.length > 0 && (
          <ul className="plain neg">
            {u.preview.issues.slice(0, 5).map((x, i) => <li key={`${x.row}-${i}`}>日報の {x.row} 行目 … {x.items.map((it) => it.reason).join('／')}</li>)}
            {u.preview.issues.length > 5 && <li>ほか {u.preview.issues.length - 5} 件（案件を開くと、すべて見られます）</li>}
          </ul>
        )}
        {st === 'pending' && otherSheet(target) && (
          <p className="rimport__sub" data-testid="import-other-sheet">※ この案件は、別の日報（スプレッドシート）で同期しています。この日報の内容で置き換えるときだけ、「反映する」を押してください。</p>
        )}
        {st === 'pending' && <button className="cellbtn cellbtn--wide" onClick={() => { if (freshNow()) runUpdate(u.projectId); }} disabled={!usable} data-testid="import-apply">反映する</button>}
        {u.outside.length > 0 && st !== 'newer' && (
          <p className="rimport__sub" data-testid="import-outside">
            ⚠ 会期の外に、この開催の回答があります（{ranges(u.outside)}。取り込んでいません）。{' '}
            {u.widenTo && (
              <button className="cellbtn cellbtn--wide" onClick={() => { if (freshNow()) runUpdate(u.projectId, u.widenTo!); }} disabled={!usable || st === 'running'} data-testid="import-widen">
                会期を {span(u.widenTo.startDate, u.widenTo.endDate)} に広げて取り込む
              </button>
            )}
          </p>
        )}
        {target && !isJcos(target) && (
          <p className="rimport__sub" data-testid="import-generic">
            ※ この案件の収支の計算方法は「汎用」です。日報の実績は案件に記録しますが、収支には使いません（基本情報で「JCOS案件」に切り替えると、実績個数で計算します）。
          </p>
        )}
        {nConflict > 0 && (
          <p className="rimport__sub" data-testid="import-conflict">
            ⚠ 手入力の実績個数と、日報の個数が違う日が {nConflict} 日あります（計算には日報を使っています。手入力の値は消していません）。{' '}
            <button className="cellbtn cellbtn--wide" onClick={() => onOpen(u.projectId)}>案件を開いて確かめる</button>
          </p>
        )}
      </li>
    );
  };

  const venueLine = (c: CreateItem) => (
    <p className="rimport__sub">
      会場：{c.venuePlan?.use.name ?? c.venueName}
      {c.venuePlan?.isNew ? <span className="tag tag--on">会場マスタに新しく登録</span> : <span className="tag">登録済み</span>}
      ／開催日：{ranges(c.dates)}
    </p>
  );

  return (
    <div className={`rimport${tone}`} data-testid="import" data-busy={busy ? '1' : '0'}>
      <div className="rimport__main">
        <button className="primary" onClick={start} disabled={busy || !canSync} data-testid="import-start">{busy ? '取得中…' : '日報から案件を作成・更新'}</button>
        {busy && slow && <button onClick={() => abandonFetch(key)} data-testid="import-stop">取得をやめる</button>}
        <span className="rimport__status" role="status" aria-live="polite" data-testid="import-status">{summary}</span>
        {(report || failure || needsSource) && (
          <button className="rimport__more" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="import-toggle">
            {failure ? '✕ 取得できませんでした' : attention > 0 ? `⚠ 確認 ${attention} 件` : '内容'} {open ? '▲' : '▼'}
          </button>
        )}
      </div>

      {!canSync && (
        <p className="rimport__hint" data-testid="import-login">
          {isFirebaseConfigured ? '日報から案件を作るには、Google でのログインが必要です（画面右上）。' : 'この環境では、日報の取得は使えません（Firebase が未設定）。'}
          ログインしなくても、「＋ 新しい案件」で手で作れます。
        </p>
      )}
      {busy && slow && (
        <p className="rimport__hint" data-testid="import-slow">
          取得に時間がかかっています。Google の確認画面が開いたままのときは、そちらを先に済ませてください。「取得をやめる」を押すと、この取得の結果は使いません。
        </p>
      )}
      {canSync && needsSource && (
        <div className="reportbar__source" data-testid="import-source">
          <label>日報のスプレッドシートの URL{known?.spreadsheetId ? '（変更）' : '（最初の 1 回だけ）'}
            <input value={url} onChange={(e) => { setUrl(e.target.value); setUrlError(''); }} placeholder="https://docs.google.com/spreadsheets/d/…" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} data-testid="import-url" />
          </label>
          {editing && <button onClick={() => { setEditing(false); setUrl(''); setUrlError(''); }}>やめる</button>}
          {urlError && <p className="neg" role="alert" data-testid="import-url-error">{urlError}</p>}
          <p className="rimport__hint">貼り付けてから「日報から案件を作成・更新」を押してください。読むのは、開催日・会場・イベント名・イベント内容・参加組数・参加人数・キットの使用数の列だけです（読み取り専用。日報は変更しません）。</p>
        </div>
      )}

      {open && (
        <div className="rimport__detail" data-testid="import-detail">
          {failure && (
            <p className="neg" role="alert" data-testid="import-error">
              ✕ {stamp(failure.at)} の取得は失敗しました：{failure.message}（案件・会場のデータは、何も変えていません）
            </p>
          )}
          {report && plan && !fresh && (
            <p className="neg" data-testid="import-stale">⚠ 取得から時間がたっています。作成・反映の前に、もう一度「日報から案件を作成・更新」を押して、最新の日報を取得してください。</p>
          )}
          {report && plan && fresh && !live && (
            <p className="neg" data-testid="import-offline">⚠ 共有データの最新の内容を確認できていないため、いまは作成・反映できません（接続を確認して、少し待ってください。確認できたら、既存の案件の更新は自動で始まります）。</p>
          )}

          {plan && plan.rowsRead - plan.tests === 0 && <p data-testid="import-empty">日報に、取り込める回答がありません（読んだ回答 {plan.rowsRead} 件）。</p>}

          {ready.length > 0 && (
            <div className="rimport__block" data-testid="import-creates">
              <div className="rimport__head">
                <b>新しい案件の候補 {ready.length} 件</b>
                <button className="primary" onClick={createNow} disabled={!usable || chosen.length === 0} data-testid="import-create-go">
                  {chosen.length === ready.length ? `この ${chosen.length} 件を作成` : `選んだ ${chosen.length} 件を作成`}
                </button>
              </div>
              <p className="rimport__hint">会場・開催日・実績（キットの使用数・参加組数・参加人数）は、日報から入ります。JCOS 案件として作り、請求・支払いの金額は標準の初期値にします（あとから変えられます）。</p>
              <ul className="rimport__list">
                {ready.map((c) => (
                  <li key={c.id} data-testid="import-create" data-id={c.id}>
                    <label className="rimport__pick">
                      <input type="checkbox" checked={!off.has(c.id)} aria-label={`「${c.name}」を作成する`}
                        onChange={(e) => { const n = new Set(off); if (e.target.checked) n.delete(c.id); else n.add(c.id); setPanel({ off: n }); }} />
                      <span className="rimport__name">{c.name}</span>
                    </label>
                    {venueLine(c)}
                    {c.totals && <p className="rimport__sub">{totalsText(c.totals)}</p>}
                    {c.venue.state === 'known' && c.venue.others > 0 && <p className="rimport__sub">※ 同じ名前の会場が、ほかに {c.venue.others} 件登録されています（会場タブで整理できます）。</p>}
                    {c.cancelled.length > 0 && <p className="rimport__sub">※ 中止の案件{c.cancelled.map((n) => `「${n}」`).join('')}と会期が重なっています。別の開催でなければ、チェックを外してください。</p>}
                    {c.near.length > 0 && (
                      <p className="rimport__sub">
                        ※ 案件{c.near.map((n) => `「${n.projectName}」`).join('')}とは別の開催として作成します。{' '}
                        <button className="cellbtn cellbtn--wide" onClick={() => { const n = new Set(separate); n.delete(c.id); setPanel({ separate: n }); }}>選び直す</button>
                      </p>
                    )}
                    {joinNote(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {updates.length > 0 && (
            <div className="rimport__block" data-testid="import-updates">
              <div className="rimport__head"><b>既存の案件 {updates.length} 件</b></div>
              {shown.length > 0 && <ul className="rimport__list">{shown.map(updateRow)}</ul>}
              {quiet.length > 0 && (
                <details className="rimport__quiet" data-testid="import-quiet">
                  <summary>✓ 日報と同じ内容の案件 {quiet.length} 件（変更なし）</summary>
                  <ul className="rimport__list">{quiet.map(updateRow)}</ul>
                </details>
              )}
            </div>
          )}

          {(blocked.length > 0 || nearby.length > 0 || ambiguous.length > 0 || (plan && plan.loose.length > 0)) && (
            <div className="rimport__block" data-testid="import-attention">
              <div className="rimport__head"><b>⚠ 確認が必要</b></div>
              <ul className="rimport__list">
                {nearby.map((c) => (
                  <li key={c.id} data-testid="import-near" data-id={c.id}>
                    <p className="rimport__row"><span className="rimport__name">{c.name}</span></p>
                    {venueLine(c)}
                    {c.totals && <p className="rimport__sub">{totalsText(c.totals)}</p>}
                    <p className="rimport__sub">
                      同じ会場の案件{c.near.map((n) => `「${n.projectName}」（会期 ${span(n.startDate, n.endDate)}）`).join('')}の、会期のすぐ近くの開催です。
                      同じ開催（予定より早く始まった・延びた）ですか？（取り込んでいません）
                    </p>
                    {c.near.some((n) => isNewer(projectOf(n.projectId))) && (
                      <p className="rimport__sub" data-testid="import-near-newer">※ この取得のあとで同期された案件の会期は、ここで読んだ内容では広げられません。もう一度取得してから、選んでください。</p>
                    )}
                    <p className="rimport__btns">
                      {c.near.map((n) => (
                        <button key={n.projectId} onClick={() => { if (freshNow()) runUpdate(n.projectId, n.widenTo); }}
                          disabled={!usable || isSyncRunning(syncKey(scope, n.projectId)) || isNewer(projectOf(n.projectId))} data-testid="import-near-widen">
                          同じ開催（「{n.projectName}」の会期を {span(n.widenTo.startDate, n.widenTo.endDate)} に広げて取り込む）
                        </button>
                      ))}
                      <button onClick={() => setPanel({ separate: new Set([...separate, c.id]), off: new Set([...off].filter((x) => x !== c.id)) })} data-testid="import-near-separate">別の開催（新しい案件の候補にする）</button>
                    </p>
                  </li>
                ))}
                {blocked.map((c) => (
                  <li key={c.id} data-testid="import-blocked" data-id={c.id} data-reason={c.blocked!.reason}>
                    <p className="rimport__row"><span className="rimport__name">{c.name}</span></p>
                    <p className="rimport__sub">会場：{c.venueName}／開催日：{ranges(c.dates)}</p>
                    {c.blocked!.reason === 'venue' && c.venue.state === 'similar' && (() => {
                      const v = c.venue;
                      const names = [...v.candidates.map((x) => x.name || '（名称未設定）'), ...v.pending.map((x) => x.name)].map((n) => `「${n}」`).join('');
                      const where = [v.candidates.length > 0 ? '会場マスタに登録済み' : '', v.pending.length > 0 ? 'この日報の中の、まだ登録していない書き方' : ''].filter(Boolean).join('・');
                      return (
                        <>
                          <p className="rimport__sub">{`記号・空白だけが違う会場名${names}があります（${where}）。同じ会場ですか？`}</p>
                          <p className="rimport__btns">
                            {v.candidates.map((x) => (
                              <button key={x.id} onClick={() => sameVenue({ venueId: x.id }, c.venueName)} disabled={!usable} data-testid="import-venue-same">
                                同じ会場（「{x.name || '（名称未設定）'}」に、別名として登録）
                              </button>
                            ))}
                            {v.pending.map((x) => (
                              <button key={x.key} onClick={() => sameVenue({ name: x.name }, c.venueName)} disabled={!usable} data-testid="import-venue-same">
                                同じ会場（「{x.name}」で登録し、この書き方は別名にする）
                              </button>
                            ))}
                            <button onClick={() => setPanel({ choice: { ...choice, [c.key]: v.choiceNew } })} data-testid="import-venue-new">別の会場（新しく登録）</button>
                          </p>
                        </>
                      );
                    })()}
                    {c.blocked!.reason !== 'venue' && <p className="rimport__sub neg">{c.blocked!.message}</p>}
                    {c.blocked!.reason === 'rows' && (
                      <ul className="plain neg" data-testid="import-issues">
                        {c.blocked!.issues.slice(0, 10).map((x, i) => (
                          <li key={`${x.row}-${i}`}>日報の {x.row} 行目（開催日：{x.date ? shortDate(x.date) : '読み取れません'}）… {x.items.map((it) => it.reason).join('／')}</li>
                        ))}
                        {c.blocked!.issues.length > 10 && <li>ほか {c.blocked!.issues.length - 10} 件</li>}
                      </ul>
                    )}
                    {joinNote(c)}
                  </li>
                ))}
                {ambiguous.map((a) => a.kind === 'ambiguous' && (
                  <li key={`${a.id}:${a.dates[0]}`} data-testid="import-ambiguous">
                    <p className="rimport__row"><span className="rimport__name">{a.venueName}（{ranges(a.dates)}）</span></p>
                    <p className="rimport__sub">
                      同じ会場で、この開催日を会期に含む案件が {a.projects.length} 件あるため、どの案件の実績か決められません（取り込んでいません）。
                      どちらかの案件を開いて、「この案件の実績として取り込む」を選ぶか、会期を直してください：{' '}
                      {a.projects.map((p) => <button key={p.id} className="cellbtn cellbtn--wide" onClick={() => onOpen(p.id)}>「{p.name}」を開く</button>)}
                    </p>
                  </li>
                ))}
                {plan && plan.loose.length > 0 && (
                  <li data-testid="import-loose">
                    <p className="rimport__sub neg">開催日か会場名を読み取れない回答が {plan.loose.length} 件あります（どの開催のものか、決められません）。日報を直してから、もう一度取得してください：</p>
                    <ul className="plain neg">
                      {plan.loose.slice(0, 10).map((x, i) => (
                        <li key={`${x.row}-${i}`}>日報の {x.row} 行目（開催日：{x.date ? shortDate(x.date) : '読み取れません'}）… {x.items.map((it) => it.reason).join('／')}</li>
                      ))}
                      {plan.loose.length > 10 && <li>ほか {plan.loose.length - 10} 件</li>}
                    </ul>
                  </li>
                )}
              </ul>
            </div>
          )}

          {canSync && known?.spreadsheetId && !editing && (
            <p className="rimport__hint">日報の場所：設定済み <button className="cellbtn cellbtn--wide" onClick={() => { setEditing(true); setOpen(true); }} data-testid="import-change">変更</button></p>
          )}
          <p className="rimport__hint">照合は、会場と開催日で行います（イベント名は使いません）。何度押しても、実績が二重に入ることはありません。読み取れない回答がある開催は、取り込まずに止めます。日報そのものは変更しません。</p>
        </div>
      )}
    </div>
  );
}
