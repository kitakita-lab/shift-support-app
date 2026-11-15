// 日報の同期（JCOS 案件の見出しの下に出す帯）。
// 「日報を同期」を 1 回押すと、認証 → 必要な列だけ取得 → 会場＋会期で照合 → 日別の実績を丸ごと置き換える。
// 失敗したときは、案件のデータに触れない（前回の実績が残る）。流れそのものは report/sync.ts。
// 日報に読み取れない回答があるときも、取り込まずに止めて、どの回答のどの項目かを示す。
// 「同期中か」は、この部品の外（report/syncJob.ts）に置く。案件の画面を閉じて開き直しても、同期中のままに見え、
// 同じ案件の同期が重なって、古い結果が新しい実績を上書きすることがない。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  checkAlias, classifyUnmatched, contestedReportDays, findReportSource, openOutside, parseSheetUrl, rivalClaimedDates, syncStaleness, unmatchedGaps, usableReportDays,
  venueKey, widenTarget,
} from '../domain/report';
import { dateRanges, totalsOf } from '../domain/reportImport';
import { shortDate } from '../domain/util';
import { firebaseOffReason, isFirebaseConfigured } from '../firebase';
import { forgetSheetsToken, requestSheetsToken } from '../report/googleToken';
import { lastFailure, loadSource, recordSyncResult } from '../report/records';
import { fetchReportRows } from '../report/sheets';
import { failureIsCurrent } from '../report/sync';
import { abandonSync, isSyncRunning, startSyncJob, subscribeSyncJobs, syncJobsVersion, syncKey, syncRunningSince } from '../report/syncJob';
import { AppData, Project, ReportSkipReason, ReportSource, ReportSync, ReportUnmatched, Venue } from '../types';

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
  /** 手入力の実績個数と、日報の個数が違う日（競合。domain/jcos.ts）。計算には日報を使っている */
  conflicts?: { date: string; manual: number; report: number }[];
}

// 最後に使った日報の場所・最後の失敗の内容は、この端末の中だけに置く（report/records.ts。共有データには入れない）
/** 同期を始めてから、「同期をやめる」を出すまでの時間（ふつうの同期は、数秒で終わる） */
const SLOW_MS = 4000;

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
/** 日付の一覧を、連続する範囲にまとめて書く（11/13(金)〜11/14(土)・11/16(月)） */
const ranges = (ds: string[]): string => dateRanges(ds).map(([a, b]) => (a === b ? shortDate(a) : `${shortDate(a)}〜${shortDate(b)}`)).join('・');
/**
 * 確認が必要なものの数（保留の日・読み取れない回答・この会場の別の書き方かもしれない回答・実績の無い日にある、未登録の会場名の回答・
 * 会期のすぐ外にある回答。outside … その日数）。ほかの会場として登録済みの会場名の回答は、数えない（別の会場の、ふつうの開催）。
 */
const attention = (s: ReportSync | undefined, outside: number, venues: Venue[], venueId?: string): number =>
  (s ? s.held.length + s.skipped.length + unmatchedGaps(s, venues, venueId).length + (outside > 0 ? 1 : 0) : 0);
/**
 * 取り込めていない回答がある日（保留の日・この会場の別の書き方かもしれない回答の日・この案件の実績が無い日にある、未登録の会場名の回答の日・
 * 会期のすぐ外の回答の日）。日数として数える（同じ日に、複数の理由が重なっても 1 日）。
 */
function pendingDates(s: ReportSync | undefined, outside: string[], venues: Venue[], venueId?: string): Set<string> {
  const out = new Set<string>(outside);
  if (!s) return out;
  for (const h of s.held) out.add(h.date);
  const have = new Set([...s.days.map((d) => d.date), ...s.held.map((h) => h.date)]);
  const { candidates, others } = classifyUnmatched(s, venues, venueId);
  // 別名の候補は、この会場の回答かもしれない（記号だけが違う名前は、この案件の実績のある日のものも、取り込めていない回答として数える）
  for (const u of candidates) for (const d of u.dates) out.add(d);
  for (const u of others) if (u.gap && !u.registered) for (const d of u.dates) if (!have.has(d)) out.add(d);
  return out;
}

export default function ReportBar({ project: p, data, scope, current, onChange, onAddVenueAlias, conflicts = [] }: Props) {
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
  // 別名として登録する前の確認（確かめている名前）。押すと、すぐには登録せず、対象と影響を示す。登録するのは、確認のボタンを押したとき
  const [aliasAsk, setAliasAsk] = useState<string | null>(null);
  useEffect(() => { setAliasAsk(null); }, [p.id]);

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
  // 会場名と同じ書き方の別名（日報から登録した会場は、日報での書き方を別名にも持つ）は、表示しない
  const aliases = (venue?.reportNames ?? []).filter((n) => venueKey(n) !== venueKey(venue?.name));
  const known = findReportSource(p, data.projects) ?? loadSource(scope);
  const canSync = isFirebaseConfigured && !!user;
  const needsSource = !known?.spreadsheetId || editing;
  const total = sync ? sync.days.reduce((s, d) => s + d.count, 0) : 0;
  // 会場名が一致しなかった回答（会期内）を、「この会場の別の書き方かもしれないもの」と「別の会場の回答」に分ける
  // （同期のあとで、案件の会場を変えた場合は、どちらも出さない。もう一度同期してから）
  const unmatched = classifyUnmatched(sync, data.venues, p.venueId);
  // 同期した実績のうち、いまは使っていない日（同期のあとで、会期が重なる案件が増えた・決定が変わった）
  const contested = contestedReportDays(p, data);
  // この案件が「自分の実績にする」と決めている日。決めているのに使えていない日は、相手の案件も同じ日を決めている
  const claimed = new Set(p.reportClaims ?? []);
  const undecided = contested.filter((h) => h.state === 'held');
  const assigned = contested.filter((h) => h.state === 'theirs');
  // 会期のすぐ外にある、この会場の回答（同期のときの記録のうち、いまも、どの案件の会期にも入っていない日のもの）
  const outside = openOutside(p, data);
  const notes = attention(sync, outside.length, data.venues, p.venueId) + undecided.length + (stale.venue || stale.period || stale.names ? 1 : 0) + (failure ? 1 : 0) + (conflicts.length > 0 ? 1 : 0);
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
  const run = (opt: { project?: Project; venues?: Venue[]; source?: ReportSource | null; period?: { startDate: string; endDate: string }; allowClear?: boolean } = {}) => {
    const project = opt.project ?? p;
    const source = opt.source ?? known;
    // startSyncJob は、最初に（何も待たずに）認証を呼ぶ。ここはボタンのタップの中なので、Google の画面が止められない
    void startSyncJob(
      key,
      { project, projects: data.projects.map((x) => (x.id === project.id ? project : x)), venues: opt.venues ?? data.venues, source, period: opt.period, allowClear: opt.allowClear },
      { token: requestSheetsToken, rows: fetchReportRows, now: () => new Date().toISOString(), forget: forgetSheetsToken },
      {
        current,
        update: onChange,                              // 実績を丸ごと置き換える（成功して、結果を書けるときだけ呼ばれる）
        settled: (r) => {
          // 端末に置く記録（日報の場所・失敗の内容）。このあとに始めた同期がある・やめた、のときは、何も残さない
          recordSyncResult(key, r, source, scope);
          if (r.kind === 'dropped') return;
          if (r.kind === 'applied') {
            setEditing(false);
            setUrl('');
            setOpen(attention(r.outcome.sync, r.outcome.sync.outside?.length ?? 0, data.venues, r.outcome.sync.venueId) > 0);
          } else {
            setOpen(true);                             // 開き直した画面では、上の useEffect が開く
          }
        },
      },
    );
  };

  /**
   * allowClear … 前回の実績が、すべて外れることになる結果でも書く（「前回の実績を外す」を押したとき。押さない限り、そのような結果は書かない）。
   * そのときは、確認を求めた同期が読んだ日報を、読み直す（URL を入力し直している最中なら、入力してある URL）。
   */
  const start = (allowClear = false) => {
    // 「前回の実績を外す」: URL を入力し直している最中（入力がある）でなければ、確認を求めた同期が読んだ日報を、読み直す
    if (allowClear && failure?.clear?.source && !(editing && url.trim())) { run({ allowClear, source: failure.clear.source }); return; }
    if (!needsSource) { run({ allowClear }); return; }
    const src = parseSheetUrl(url);
    if (!src) { setUrlError('スプレッドシートの URL（https://docs.google.com/spreadsheets/d/… で始まるもの）を貼り付けてください。'); setOpen(true); return; }
    setUrlError('');
    run({ source: src, allowClear });
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
  // 別名の登録は、会場マスタを変える（この会場を使う、ほかの案件の照合にも効く）。別の会場を誤ってまとめないよう、
  // 1 回目のタップでは登録せず、対象と影響を示す（aliasAsk）。登録するのは、確認のボタンを押したとき。
  // 確認を、ブラウザのダイアログ（window.confirm）にしないのは、そのあとで Google の確認画面（ポップアップ）を開くことがあるため
  // （ポップアップは、タップの処理の中で、何も待たずに開く必要がある。ダイアログを読んでいる間に、ブラウザが「利用者の操作」とみなさなくなることがある）。
  const addAlias = (u: ReportUnmatched) => {
    setAliasAsk(null);
    if (!venue || isSyncRunning(key)) return;
    // 登録の直前にも確かめる（ほかの会場として登録済みの名前・根拠の無い名前・ほかの会場にも同じ根拠がある名前は、登録しない）
    if (!checkAlias(u.venue, venue.id, data.venues).ok) return;
    onAddVenueAlias(venue.id, u.venue);
    const names = [...new Set([...(venue.reportNames ?? []), u.venue])];
    run({ venues: data.venues.map((v) => (v.id === venue.id ? { ...v, reportNames: names } : v)) });
  };
  // 会期のすぐ外にある、この会場の回答を取り込むための、広げたあとの会期（回答の無い日を挟むときは、その日は「開催していない日」になる）
  const widenTo = !stale.venue && !stale.period ? widenTarget(p, outside.map((o) => o.date), data) : null;
  const widen = () => {
    if (!widenTo || isSyncRunning(key)) return;
    run({ period: widenTo });
  };

  // 同期した実績のうち、いまは使っていない日数（会場・会期・会場名を変えた／会期が重なる案件があって、この案件のものと決まっていない）
  const usable = usableReportDays(p, data);
  const unused = sync ? sync.days.filter((d) => !usable.has(d.date)).length : 0;
  // 参加組数・参加人数（入力のあった分の合計。未入力のある日数つき）
  const tot = sync ? totalsOf(sync) : null;
  const tally = (label: string, v: number | null, missing: number): string =>
    (v == null ? `${label} 未入力` : `${label} ${v}${missing > 0 ? `（未入力 ${missing} 日）` : ''}`);
  const people = tot && tot.days > 0 ? `${tally('組数', tot.groups, tot.groupsMissing)}・${tally('人数', tot.people, tot.peopleMissing)}` : '';
  const span = sync && sync.days.length > 0 ? ranges(sync.days.map((d) => d.date)) : '';
  // 取り込めていない回答がある日数と、手入力と日報が違う日数（どちらも 0 なら「なし」と出す）
  const waiting = pendingDates(sync, outside.map((o) => o.date), data.venues, p.venueId);
  for (const h of undecided) waiting.add(h.date);
  const nPending = waiting.size;
  // 「未反映・競合なし」と出すのは、最後の同期が成功していて、同期のあとで条件（会場・会期・会場名）も変わっていないときだけ
  const outcome = !sync ? ''
    : failure ? (failure.clear ? '最後の同期は、反映していません（確認が必要です。実績は、前回のまま）' : '最後の同期は失敗（実績は、前回のまま）')
      : stale.venue || stale.period || stale.names ? '同期のあとで、会場か会期が変わっています（もう一度同期してください）'
        : nPending + conflicts.length === 0 ? '未反映・競合なし'
          : [nPending > 0 ? `未反映 ${nPending} 日` : '', conflicts.length > 0 ? `競合 ${conflicts.length} 日` : ''].filter(Boolean).join('・');
  const summary = sync
    ? `最終同期 ${stamp(sync.at)}・${sync.days.length} 日分 ${total} 個（取り込み ${sync.rowsUsed} 件／読んだ回答 ${sync.rowsRead} 件）${unused > 0 ? `／うち ${unused} 日分は、いまは使っていません` : ''}／${outcome}`
    : 'まだ同期していません';

  // ログインしていなくて、同期の記録も無いときは、1 行の案内だけにする（画面を取らない）
  if (!canSync && !sync && !failure) {
    return (
      <div className="reportbar" data-testid="report-bar" data-busy="0">
        <p className="reportbar__hint" data-testid="report-login">
          日報の同期：{isFirebaseConfigured ? 'Google でログインすると使えます（画面右上）。' : `この環境では使えません（${firebaseOffReason}）。`}実績個数は、試算の「日別」の表に手入力もできます。
        </p>
      </div>
    );
  }

  return (
    <div className={`reportbar${failure && !failure.clear ? ' reportbar--error' : notes > 0 ? ' reportbar--warn' : ''}`} data-testid="report-bar" data-busy={busy ? '1' : '0'}>
      <div className="reportbar__main">
        <button className="primary" onClick={() => start()} disabled={busy || !canSync} data-testid="report-sync">{busy ? '同期中…' : '日報を同期'}</button>
        {busy && slow && <button onClick={() => abandonSync(key)} data-testid="report-stop">同期をやめる</button>}
        <span className="reportbar__status" data-testid="report-status">{summary}</span>
        <button className="reportbar__more" onClick={() => setOpen((v) => !v)} data-testid="report-toggle">
          {failure ? (failure.clear ? '⚠ 確認が必要です' : '✕ 同期できませんでした') : notes > 0 ? `⚠ 確認 ${notes} 件` : '詳細'} {open ? '▲' : '▼'}
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
          {isFirebaseConfigured ? '日報の同期には、Google でのログインが必要です（画面右上）。' : `日報の同期は、この環境では使えません（${firebaseOffReason}）。`}ログインしなくても、試算の「日別」の表に実績個数を手入力できます。
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
          {failure && !failure.clear && (
            <p className="neg" data-testid="report-error">
              ✕ {stamp(failure.at)} の同期は失敗しました：{failure.message}
              {sync ? `（前回 ${stamp(sync.at)} の実績 ${sync.days.length} 日分・${total} 個は、そのまま残しています）` : ''}
            </p>
          )}
          {failure?.clear && (
            <div className="reportbar__item" data-testid="report-clear">
              <p>⚠ {stamp(failure.at)} の同期は、<b>反映していません</b>：{failure.message}</p>
              <button onClick={() => start(true)} disabled={busy || !canSync} data-testid="report-clear-go">前回の実績を外す（日報の内容にする）</button>
            </div>
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
                照合の条件：会場「{venue?.name || '（未選択）'}」{aliases.length ? `（別名: ${aliases.join('、')}）` : ''}／
                会期 {shortDate(p.startDate)}〜{shortDate(p.endDate)}。{sync.tests > 0 ? `テスト回答 ${sync.tests} 件は除きました。` : ''}
              </p>
              {sync.days.length > 0 ? (
                <p data-testid="report-days">取り込んだ実績：{sync.days.map((d) => `${shortDate(d.date)} ${d.count} 個${d.rows > 1 ? `（${d.rows} 件の合計）` : ''}`).join('／')}</p>
              ) : (
                <p data-testid="report-days">この会場・会期に一致する回答は、まだありません（読んだ回答 {sync.rowsRead} 件）。</p>
              )}
              {sync.days.length > 0 && (
                <p data-testid="report-totals">
                  開催日：{span}（{sync.days.length} 日）／{people}
                  {sync.contents?.length ? `／内容：${sync.contents.map((c) => `${c.label}（${c.count} 個）`).join('、')}` : ''}
                </p>
              )}
              {outside.length > 0 && (
                <div className="reportbar__item" data-testid="report-outside">
                  <p>
                    ⚠ 会期のすぐ外に、この会場の日報があります（<b>取り込んでいません</b>）：
                    {outside.map((o) => `${shortDate(o.date)} ${o.count} 個${o.rows > 1 ? `（${o.rows} 件）` : ''}`).join('／')}
                  </p>
                  {widenTo && (
                    <button onClick={widen} disabled={busy || !canSync} data-testid="report-widen">
                      会期を {shortDate(widenTo.startDate)}〜{shortDate(widenTo.endDate)} に広げて取り込む
                    </button>
                  )}
                  <p className="reportbar__hint">広げた会期のうち、日報の無い日は「開催していない日」（請求しない・アルバイト 0 人）になります。別の開催なら、そのままで構いません（案件一覧の「日報から案件を作成・更新」で、別の案件として作れます）。</p>
                </div>
              )}
              {conflicts.length > 0 && (
                <div className="reportbar__item" data-testid="report-conflicts">
                  <p>⚠ 手入力の実績個数と、日報の個数が違う日があります（計算には<b>日報</b>を使っています。手入力の値は消していません）：</p>
                  <ul className="plain">
                    {conflicts.map((c) => <li key={c.date}>{shortDate(c.date)}：手入力 {c.manual} 個／日報 {c.report} 個</li>)}
                  </ul>
                  <p className="reportbar__hint">日報が違っている場合は、日報を直してから、もう一度同期してください。手入力の値は、試算の「日別」の表で消せます（日報の実績がある日は、表では日報の値を表示しています）。</p>
                </div>
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
              {unmatched.candidates.length > 0 && (
                <div className="reportbar__item" data-testid="report-unmatched">
                  <p>
                    会期内に、この会場の別の書き方かもしれない回答があります（<b>取り込んでいません</b>）。
                    同じ会場なら、別名として登録すると取り込めます。別の会場なら、そのままで構いません：
                  </p>
                  <ul className="plain">
                    {unmatched.candidates.map((u) => (
                      <li key={u.venue} data-evidence={u.evidence}>
                        ⚠ 「{u.venue}」{u.rows} 件・{u.count} 個（{dates(u.dates)}）：
                        {u.evidence === 'variant' ? '会場名と、記号・空白だけが違います ' : '会場名の一部が同じで、この案件の実績が無い日の回答です '}
                        {venue && aliasAsk !== u.venue && (
                          <button className="cellbtn cellbtn--wide" onClick={() => setAliasAsk(u.venue)} disabled={busy || !canSync}>「{venue.name}」の別名として登録して同期…</button>
                        )}
                        {venue && aliasAsk === u.venue && (
                          <div className="reportbar__confirm" data-testid="report-alias-confirm">
                            <p><b>「{u.venue}」を、会場「{venue.name}」の別名として登録します。まだ登録していません。</b></p>
                            <ul className="plain">
                              <li>登録すると、「{u.venue}」と書かれた回答（{dates(u.dates)}・{u.rows} 件・{u.count} 個）が、この案件の実績に入ります。</li>
                              <li>会場「{venue.name}」を使う、ほかの案件でも、この書き方の回答を取り込むようになります。</li>
                              <li><b>別の会場の回答の場合は、登録しないでください</b>（別の会場の実績が混ざります）。</li>
                              <li>取り消すには、「会場」タブで、この別名を消してから、もう一度同期します。</li>
                            </ul>
                            <button className="primary" onClick={() => addAlias(u)} disabled={busy || !canSync} data-testid="report-alias-go">同じ会場なので、登録して同期する</button>{' '}
                            <button onClick={() => setAliasAsk(null)} data-testid="report-alias-cancel">やめる</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {unmatched.others.length > 0 && (
                <div className="reportbar__item" data-testid="report-others">
                  <p>
                    同じ期間に、ほかの会場の回答があります（別の会場の開催として扱い、<b>この案件には取り込みません</b>）：
                  </p>
                  <ul className="plain">
                    {unmatched.others.map((u) => (
                      <li key={u.venue} data-registered={u.registered ? '1' : '0'} data-gap={u.gap ? '1' : '0'}>
                        {!u.registered && u.gap ? '⚠ ' : ''}「{u.venue}」{u.rows} 件・{u.count} 個（{dates(u.dates)}）
                        {u.registered ? '：登録済みの、別の会場です'
                          : u.similar ? `：会場「${u.similar}」にも似た名前です（どの会場の回答か、名前からは決められません）`
                            : u.gap ? '：未登録の会場名で、この案件の実績が無い日の回答です' : ''}
                      </li>
                    ))}
                  </ul>
                  {unmatched.others.some((u) => !u.registered && u.gap) && (
                    <p className="hint">
                      ⚠ の回答が、この会場の別の書き方の場合は、「会場」タブで、この会場の「日報での会場名（別名）」に登録してから、もう一度同期してください。
                      別の会場なら、そのままで構いません（案件一覧の「日報から案件を作成・更新」で、その会場の案件になります）。
                    </p>
                  )}
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
          <p className="reportbar__hint">同期は、この案件の実績を日報の内容で置き換えます（何度押しても二重には数えません）。日報に読み取れない回答があるとき・この案件の回答が 1 件も無くなったときは、取り込まずに止めます（前回の実績を残します）。日報そのものは変更しません。</p>
        </div>
      )}
    </div>
  );
}
