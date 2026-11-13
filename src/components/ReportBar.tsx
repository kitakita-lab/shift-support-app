// 日報の同期（JCOS 案件の見出しの下に出す帯）。
// 「日報を同期」を 1 回押すと、認証 → 必要な列だけ取得 → 会場＋会期で照合 → 日別の実績を丸ごと置き換える。
// 失敗したときは、案件のデータに触れない（前回の実績が残る）。流れそのものは report/sync.ts。
// 日報に読み取れない回答があるときも、取り込まずに止めて、どの回答のどの項目かを示す。
// 「同期中か」は、この部品の外（report/syncJob.ts）に置く。案件の画面を閉じて開き直しても、同期中のままに見え、
// 同じ案件の同期が重なって、古い結果が新しい実績を上書きすることがない。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { contestedReportDays, findReportSource, parseSheetUrl, rivalClaimedDates, syncStaleness, unmatchedGaps, usableReportDays } from '../domain/report';
import { shortDate } from '../domain/util';
import { isFirebaseConfigured } from '../firebase';
import { forgetSheetsToken, requestSheetsToken } from '../report/googleToken';
import { fetchReportRows } from '../report/sheets';
import { SyncFailure, failureIsCurrent, hydrateFailure } from '../report/sync';
import { abandonSync, isSyncRunning, startSyncJob, subscribeSyncJobs, syncJobsVersion, syncKey, syncRunningSince } from '../report/syncJob';
import { AppData, Project, ReportSkipReason, ReportSource, ReportSync, Venue } from '../types';

interface Props {
  project: Project;
  data: AppData;
  /** 案件の置き場所（共有データか、この端末だけのデータか） */
  scope: 'shared' | 'local';
  /** 同じ置き場所の、いまの案件（画面の描画を待たずに読む。あとから届いた同期の結果を書く前に、変わっていないかを確かめる） */
  current: () => Project | undefined;
  onChange: (fn: (p: Project) => Project) => void;
  /** 会場に「日報での会場名（別名）」を足す */
  onAddVenueAlias: (venueId: string, name: string) => void;
}

// この端末で最後に使った日報の場所と、最後の失敗の内容。どちらも端末の中だけに置く（共有データには入れない）
const SOURCE_KEY = 'kkl_report_source_v1';
const ERROR_KEY = 'kkl_report_error_v1';
function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
/** 案件ごとの記録（案件の ID → 記録）。形が壊れていたら、空として扱う */
function loadMap(key: string): Record<string, unknown> {
  const v = load<unknown>(key, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
// このタブで記録した失敗。端末にも置くが、置けなかったとき（保存領域がいっぱい・保存できない設定）でも、
// このタブでは表示できるように、メモリにも持つ（失敗したのに、何も表示されない、を防ぐ）
const recent = new Map<string, SyncFailure | null>();
/** この案件（key ＝ 置き場所 ＋ 案件の ID）の、最後の失敗の記録 */
const lastFailure = (key: string): SyncFailure | null => (recent.has(key) ? recent.get(key) ?? null : hydrateFailure(loadMap(ERROR_KEY)[key]));
/** 失敗の記録を、このタブのメモリと、端末に置く（null … 消す） */
function recordFailure(key: string, f: SyncFailure | null): void {
  recent.set(key, f);
  const all = loadMap(ERROR_KEY);
  if (f) all[key] = f; else delete all[key];
  save(ERROR_KEY, all);
}
/** 同期を始めてから、「同期をやめる」を出すまでの時間（ふつうの同期は、数秒で終わる） */
const SLOW_MS = 4000;
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても、同期そのものには影響しない */ }
}

// 取り込まなかった回答の説明。読み取れない回答の 3 つは、以前の版が保存した結果のために残している（いまの同期は、読み取れない回答があると止まる）
const SKIP_TEXT: Record<ReportSkipReason, string> = {
  'bad-date': '開催日を読み取れない回答',
  'bad-count': 'キットの使用数を読み取れない（空欄を含む）回答',
  'no-venue': '会場名が空欄の回答',
  'other-project': '別の案件の実績として割り当て済みの回答',
};
const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-14T09:02:00.000Z" → "11/14 18:02"（端末の時刻） */
function stamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const dates = (ds: string[]): string => ds.map(shortDate).join('・');
/** 確認が必要なものの数（保留の日・読み取れない回答・実績の無い日にある、別の会場名の回答） */
const attention = (s: ReportSync | undefined): number => (s ? s.held.length + s.skipped.length + unmatchedGaps(s).length : 0);

export default function ReportBar({ project: p, data, scope, current, onChange, onAddVenueAlias }: Props) {
  const { user } = useAuth();
  const key = syncKey(scope, p.id);
  // 同期の状態は、この部品の外にある。同期が始まった・終わった・やめたときに、読み直す
  const jobs = useSyncExternalStore(subscribeSyncJobs, syncJobsVersion);
  // この案件の同期が動いているか。この画面を開く前に始めた同期（案件を閉じて、開き直した）も含む
  const busy = isSyncRunning(key);
  // 最後の失敗の記録（端末に置いてある）。同期が終わるたびに読み直すので、開き直した画面にも、同期の結果が出る
  const recorded = useMemo(() => lastFailure(key), [key, jobs]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [slow, setSlow] = useState(false);

  const sync = p.reportSync;
  // 失敗の記録は、そのあとで同期の結果が新しくなっていたら（ほかの端末で同期が成功した）、出さない
  const failure = recorded && failureIsCurrent(recorded, sync?.at) ? recorded : null;
  // 同期が失敗で終わったら、内容を開いて見せる（この画面を開く前に始めた同期を含む）。
  // 同期の前から出ていた失敗のままなら、開かない（同期をやめたときに、前の失敗を、いまの同期の結果のように見せない）
  const wasBusy = useRef(false);
  const shownBefore = useRef<string | undefined>(undefined);
  const failedAt = failure?.at;
  useEffect(() => {
    if (busy && !wasBusy.current) shownBefore.current = failedAt;
    if (!busy && wasBusy.current && failedAt && failedAt !== shownBefore.current) setOpen(true);
    wasBusy.current = busy;
  }, [busy, failedAt]);
  // 同期が長引いているときだけ、「同期をやめる」を出す。時間は、同期を始めたときから数える（画面を開き直しても、数え直さない）
  useEffect(() => {
    if (!busy) { setSlow(false); return undefined; }
    const wait = SLOW_MS - (Date.now() - (syncRunningSince(key) ?? Date.now()));
    if (wait <= 0) { setSlow(true); return undefined; }
    const t = setTimeout(() => setSlow(true), wait);
    return () => clearTimeout(t);
  }, [busy, key]);
  const stale = syncStaleness(p, data);
  const venue = data.venues.find((v) => v.id === p.venueId);
  const known = findReportSource(p, data.projects) ?? load<ReportSource | null>(SOURCE_KEY, null);
  const canSync = isFirebaseConfigured && !!user;
  const needsSource = !known?.spreadsheetId || editing;
  const total = sync ? sync.days.reduce((s, d) => s + d.count, 0) : 0;
  const gaps = unmatchedGaps(sync);
  // 同期した実績のうち、いまは使っていない日（同期のあとで、会期が重なる案件が増えた・決定が変わった）
  const contested = contestedReportDays(p, data);
  // この案件が「自分の実績にする」と決めている日。決めているのに使えていない日は、相手の案件も同じ日を決めている
  const claimed = new Set(p.reportClaims ?? []);
  const undecided = contested.filter((h) => h.state === 'held');
  const assigned = contested.filter((h) => h.state === 'theirs');
  const notes = attention(sync) + undecided.length + (stale.venue || stale.period || stale.names ? 1 : 0) + (failure ? 1 : 0);
  // 相手の案件が「自分の実績にする」と決めている日／中止の案件か（中止の案件は、重なる日の実績を自分のものにできない）
  const theirClaims = rivalClaimedDates(p, data);
  const cancelled = p.status === '中止';
  /**
   * 保留の日に添える説明。保存してある同期の結果は、そのあとの決定（この案件が決めた・相手が決めた・取り消した）を、
   * まだ映していないことがある（続く同期が失敗した、など）。いまの決定に合わせて説明する。
   */
  const claimNote = (date: string): string => {
    if (cancelled) return '（中止の案件は、会期が重なる日の実績を取り込みません）';
    const mine = claimed.has(date);
    const theirs = theirClaims.has(date);
    if (mine && theirs) return '（この案件も相手の案件も、この日を自分の実績と決めています。どちらかの案件で、決定を取り消してください）';
    if (mine) return '（この案件の実績にすると決めています。次に同期が成功したときに、取り込みます）';
    if (theirs) return '（相手の案件が、この日を自分の実績と決めています。この案件では取り込みません）';
    return '';
  };
  /** 保留の日の一覧（note: 上の説明を添えるか） */
  const heldList = (hs: { date: string; count: number; rows: number; others: string[] }[], note = true) => (
    <ul className="plain">
      {hs.map((h) => (
        <li key={h.date}>
          {shortDate(h.date)}：{h.count} 個（{h.rows} 件）／重なっている案件：{h.others.map((n) => `「${n}」`).join('')}
          {note ? claimNote(h.date) : ''}
        </li>
      ))}
    </ul>
  );
  /**
   * 「この案件の実績にする」を押せる日。この案件も相手の案件も、まだ決めていない日だけ
   * （相手が決めている日に押すと、両方が決めた状態になって、どちらにも取り込めなくなる。中止の案件は、決めても取り込めない）。
   */
  const claimable = (hs: { date: string }[]) => (cancelled ? [] : hs.map((h) => h.date).filter((d) => !claimed.has(d) && !theirClaims.has(d)));

  /**
   * 同期する。project・venues・source は、直前の操作（別名の登録・割り当ての決定）を反映したものを渡せる。
   * この案件の同期が動いている間は、始めない。結果を書くのは、最後に始めた同期だけ（report/syncJob.ts）。
   * 同期の完了は、あとから届く。そのとき、この画面が閉じられていても、端末に置く記録と案件への書き込みは行う
   * （画面の状態を変える setOpen などは、閉じた画面には効かない。開き直した画面は、記録を読み直す）。
   */
  const run = (opt: { project?: Project; venues?: Venue[]; source?: ReportSource | null } = {}) => {
    const project = opt.project ?? p;
    const source = opt.source ?? known;
    // startSyncJob は、最初に（何も待たずに）認証を呼ぶ。ここはボタンのタップの中なので、Google の画面が止められない
    void startSyncJob(
      key,
      { project, projects: data.projects.map((x) => (x.id === project.id ? project : x)), venues: opt.venues ?? data.venues, source },
      { token: requestSheetsToken, rows: fetchReportRows, now: () => new Date().toISOString(), forget: forgetSheetsToken },
      {
        current,
        update: onChange,                              // 実績を丸ごと置き換える（成功して、結果を書けるときだけ呼ばれる）
        settled: (r) => {
          if (r.kind === 'dropped') return;            // このあとに始めた同期がある・やめた … 何も残さない
          if (r.kind === 'applied') {
            save(SOURCE_KEY, r.outcome.source);
            recordFailure(key, null);
            setEditing(false);
            setUrl('');
            setOpen(attention(r.outcome.sync) > 0);
          } else {
            // 案件のデータには触れていない（読み取れない回答があるときも、何も取り込まない）
            recordFailure(key, r.failure);
            // 読み取れない回答で止めたときは、日報そのものは読めている。場所だけは、この端末に覚えておく（直したあとで、URL を貼り直さずに同期できるように）
            if (r.code === 'bad-rows' && source?.spreadsheetId) save(SOURCE_KEY, source);
            setOpen(true);                             // 開き直した画面では、上の useEffect が開く
          }
        },
      },
    );
  };

  const start = () => {
    if (!needsSource) { run(); return; }
    const src = parseSheetUrl(url);
    if (!src) { setUrlError('スプレッドシートの URL（https://docs.google.com/spreadsheets/d/… で始まるもの）を貼り付けてください。'); setOpen(true); return; }
    setUrlError('');
    run({ source: src });
  };
  const claim = (ds: string[]) => {
    if (isSyncRunning(key)) return;                    // 同期中は、決定を変えない（決定だけが保存されて、同期が始まらないのを防ぐ）
    const next = [...new Set([...(p.reportClaims ?? []), ...ds])].sort();
    onChange((cur) => ({ ...cur, reportClaims: next }));
    run({ project: { ...p, reportClaims: next } });
  };
  // 決定を取り消す。取り消した日の実績は、その場で使わなくなる（保存してある実績は、使うたびに、いまの決定と照らすため。
  // このあとの同期が失敗しても、同じ回答が相手の案件と二重に数えられることはない）。続けて同期し直して、表示を最新にする
  const unclaim = (d: string) => {
    if (isSyncRunning(key)) return;
    const next = (p.reportClaims ?? []).filter((x) => x !== d);
    onChange((cur) => ({ ...cur, reportClaims: next }));
    run({ project: { ...p, reportClaims: next } });
  };
  const addAlias = (name: string) => {
    if (!venue || isSyncRunning(key)) return;
    onAddVenueAlias(venue.id, name);
    const names = [...new Set([...(venue.reportNames ?? []), name])];
    run({ venues: data.venues.map((v) => (v.id === venue.id ? { ...v, reportNames: names } : v)) });
  };

  // 同期した実績のうち、いまは使っていない日数（会場・会期・会場名を変えた／会期が重なる案件があって、この案件のものと決まっていない）
  const usable = usableReportDays(p, data);
  const unused = sync ? sync.days.filter((d) => !usable.has(d.date)).length : 0;
  const summary = sync
    ? `最終同期 ${stamp(sync.at)}・${sync.days.length} 日分 ${total} 個（取り込み ${sync.rowsUsed} 件／読んだ回答 ${sync.rowsRead} 件）${unused > 0 ? `／うち ${unused} 日分は、いまは使っていません` : ''}`
    : 'まだ同期していません';

  // ログインしていなくて、同期の記録も無いときは、1 行の案内だけにする（画面を取らない）
  if (!canSync && !sync && !failure) {
    return (
      <div className="reportbar" data-testid="report-bar" data-busy="0">
        <p className="reportbar__hint" data-testid="report-login">
          日報の同期：{isFirebaseConfigured ? 'Google でログインすると使えます（画面右上）。' : 'この環境では使えません（Firebase が未設定）。'}実績個数は、試算の「日別」の表に手入力もできます。
        </p>
      </div>
    );
  }

  return (
    <div className={`reportbar${failure ? ' reportbar--error' : notes > 0 ? ' reportbar--warn' : ''}`} data-testid="report-bar" data-busy={busy ? '1' : '0'}>
      <div className="reportbar__main">
        <button className="primary" onClick={start} disabled={busy || !canSync} data-testid="report-sync">{busy ? '同期中…' : '日報を同期'}</button>
        {busy && slow && <button onClick={() => abandonSync(key)} data-testid="report-stop">同期をやめる</button>}
        <span className="reportbar__status" data-testid="report-status">{summary}</span>
        <button className="reportbar__more" onClick={() => setOpen((v) => !v)} data-testid="report-toggle">
          {failure ? '✕ 同期できませんでした' : notes > 0 ? `⚠ 確認 ${notes} 件` : '詳細'} {open ? '▲' : '▼'}
        </button>
      </div>

      {busy && slow && (
        <p className="reportbar__hint" data-testid="report-slow">
          同期に時間がかかっています。Google の確認画面が開いたままのときは、そちらを先に済ませてください。
          「同期をやめる」を押すと、この同期の結果は、あとから届いても使いません（実績は前回のままです）。
        </p>
      )}
      {!canSync && (
        <p className="reportbar__hint" data-testid="report-login">
          日報の同期には、Google でのログインが必要です（画面右上）。ログインしなくても、試算の「日別」の表に実績個数を手入力できます。
        </p>
      )}
      {canSync && needsSource && (
        <div className="reportbar__source" data-testid="report-source">
          <label>日報のスプレッドシートの URL{known?.spreadsheetId ? '（変更）' : '（最初の 1 回だけ）'}
            <input value={url} onChange={(e) => { setUrl(e.target.value); setUrlError(''); }} placeholder="https://docs.google.com/spreadsheets/d/…" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} data-testid="report-url" />
          </label>
          {editing && <button onClick={() => { setEditing(false); setUrl(''); setUrlError(''); }}>やめる</button>}
          {urlError && <p className="neg" data-testid="report-url-error">{urlError}</p>}
          <p className="reportbar__hint">貼り付けてから「日報を同期」を押してください。場所は案件のデータに記録され、ほかの案件・ほかの端末では入れ直さずに同期できます。読むのは、開催日・会場・キットの使用数など必要な列だけです（読み取り専用）。</p>
        </div>
      )}

      {open && (
        <div className="reportbar__detail" data-testid="report-detail">
          {failure && (
            <p className="neg" data-testid="report-error">
              ✕ {stamp(failure.at)} の同期は失敗しました：{failure.message}
              {sync ? `（前回 ${stamp(sync.at)} の実績 ${sync.days.length} 日分・${total} 個は、そのまま残しています）` : ''}
            </p>
          )}
          {failure?.issues && failure.issues.length > 0 && (
            <ul className="plain neg" data-testid="report-issues">
              {failure.issues.map((x, i) => (
                <li key={`${x.row}-${i}`}>
                  日報の {x.row} 行目（開催日：{x.date ? shortDate(x.date) : '読み取れません'}）… {x.items.map((it) => it.reason).join('／')}
                </li>
              ))}
              {failure.more ? <li>ほか {failure.more} 件</li> : null}
            </ul>
          )}
          {(stale.venue || stale.period || stale.names) && (
            <p data-testid="report-stale">
              ⚠ 同期のあとで、{stale.venue ? '案件の会場' : stale.names ? '会場名または別名' : '案件の会期'}が変わっています。
              {stale.venue ? '同期した実績は使っていません。' : stale.names ? '変わった名前で取り込んだ日の実績は使っていません。' : '会期内の日の実績だけを使っています。'}
              もう一度「日報を同期」を押してください。
            </p>
          )}
          {sync && (
            <>
              <p>
                照合の条件：会場「{venue?.name || '（未選択）'}」{venue?.reportNames?.length ? `（別名: ${venue.reportNames.join('、')}）` : ''}／
                会期 {shortDate(p.startDate)}〜{shortDate(p.endDate)}。{sync.tests > 0 ? `テスト回答 ${sync.tests} 件は除きました。` : ''}
              </p>
              {sync.days.length > 0 ? (
                <p data-testid="report-days">取り込んだ実績：{sync.days.map((d) => `${shortDate(d.date)} ${d.count} 個${d.rows > 1 ? `（${d.rows} 件の合計）` : ''}`).join('／')}</p>
              ) : (
                <p data-testid="report-days">この会場・会期に一致する回答は、まだありません（読んだ回答 {sync.rowsRead} 件）。</p>
              )}
              {undecided.length > 0 && (
                <div className="reportbar__item" data-testid="report-contested">
                  <p>⚠ 同期した実績のうち、次の日は、同じ会場で会期が重なる別の案件があり、どちらの実績か決まっていないため、<b>いまは使っていません</b>：</p>
                  {heldList(undecided)}
                  {claimable(undecided).length > 0 && (
                    <button onClick={() => claim(claimable(undecided))} disabled={busy || !canSync} data-testid="report-claim-contested">この {claimable(undecided).length} 日を、この案件の実績にする</button>
                  )}
                </div>
              )}
              {assigned.length > 0 && (
                <div className="reportbar__item" data-testid="report-assigned">
                  <p>同期した実績のうち、次の日は、<b>別の案件の実績として割り当て済み</b>のため、いまは使っていません（もう一度同期すると、同期の結果からも外れます）：</p>
                  {heldList(assigned, false)}
                </div>
              )}
              {sync.held.length > 0 && (
                <div className="reportbar__item" data-testid="report-held">
                  <p>⚠ 次の日は、同じ会場で会期が重なる別の案件があり、どちらの実績か決められないため、<b>取り込んでいません</b>：</p>
                  {heldList(sync.held)}
                  {claimable(sync.held).length > 0 && (
                    <button onClick={() => claim(claimable(sync.held))} disabled={busy || !canSync} data-testid="report-claim">この {claimable(sync.held).length} 日を、この案件の実績として取り込む</button>
                  )}
                </div>
              )}
              {sync.unmatched.length > 0 && (
                <div className="reportbar__item" data-testid="report-unmatched">
                  <p>
                    会期内に、別の会場名の日報があります（<b>取り込んでいません</b>）。別の会場のイベントなら、そのままで構いません。
                    この案件の会場の別の書き方なら、別名として登録すると取り込めます：
                  </p>
                  <ul className="plain">
                    {sync.unmatched.map((u) => (
                      <li key={u.venue}>
                        {gaps.includes(u) ? '⚠ ' : ''}「{u.venue}」{u.rows} 件・{u.count} 個（{dates(u.dates)}）
                        {gaps.includes(u) ? '：この案件の実績が無い日の回答です ' : ' '}
                        {venue && <button className="cellbtn cellbtn--wide" onClick={() => addAlias(u.venue)} disabled={busy || !canSync}>「{venue.name}」の別名として登録して同期</button>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {sync.skipped.map((s) => (
                <p key={s.reason} data-testid={`report-skip-${s.reason}`}>⚠ {SKIP_TEXT[s.reason]}が {s.rows} 件あります{s.dates.length ? `（${dates(s.dates)}）` : ''}。実績には入っていません。</p>
              ))}
            </>
          )}
          {(p.reportClaims?.length ?? 0) > 0 && (
            <p data-testid="report-claims">この案件の実績にすると決めた日：
              {p.reportClaims!.map((d) => (
                <span key={d} className="tag">{shortDate(d)}
                  {canSync && <button className="cellbtn" title="取り消して、同期し直す" aria-label={`${shortDate(d)} の決定を取り消す`} onClick={() => unclaim(d)} disabled={busy}>×</button>}
                </span>
              ))}
            </p>
          )}
          {canSync && known?.spreadsheetId && !editing && (
            <p className="reportbar__hint">日報の場所：設定済み <button className="cellbtn cellbtn--wide" onClick={() => setEditing(true)} data-testid="report-change">変更</button></p>
          )}
          <p className="reportbar__hint">同期は、この案件の実績を日報の内容で置き換えます（何度押しても二重には数えません）。日報に読み取れない回答があるときは、取り込みを中止します（前回の実績を残します）。日報そのものは変更しません。</p>
        </div>
      )}
    </div>
  );
}
