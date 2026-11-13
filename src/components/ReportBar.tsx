// 日報の同期（JCOS 案件の見出しの下に出す帯）。
// 「日報を同期」を 1 回押すと、認証 → 必要な列だけ取得 → 会場＋会期で照合 → 日別の実績を丸ごと置き換える。
// 失敗したときは、案件のデータに触れない（前回の実績が残る）。流れそのものは report/sync.ts。
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { contestedReportDays, findReportSource, parseSheetUrl, syncStaleness, unmatchedGaps, usableReportDays } from '../domain/report';
import { shortDate } from '../domain/util';
import { isFirebaseConfigured } from '../firebase';
import { forgetSheetsToken, requestSheetsToken } from '../report/googleToken';
import { fetchReportRows } from '../report/sheets';
import { applySync, runReportSync } from '../report/sync';
import { AppData, Project, ReportSkipReason, ReportSource, ReportSync, Venue } from '../types';

interface Props {
  project: Project;
  data: AppData;
  onChange: (fn: (p: Project) => Project) => void;
  /** 会場に「日報での会場名（別名）」を足す */
  onAddVenueAlias: (venueId: string, name: string) => void;
}

// この端末で最後に使った日報の場所と、最後の失敗の内容。どちらも端末の中だけに置く（共有データには入れない）
const SOURCE_KEY = 'kkl_report_source_v1';
const ERROR_KEY = 'kkl_report_error_v1';
interface Failure { at: string; message: string }
function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても、同期そのものには影響しない */ }
}

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

export default function ReportBar({ project: p, data, onChange, onAddVenueAlias }: Props) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(() => load<Record<string, Failure>>(ERROR_KEY, {})[p.id] ?? null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  useEffect(() => { setFailure(load<Record<string, Failure>>(ERROR_KEY, {})[p.id] ?? null); }, [p.id]);

  const sync = p.reportSync;
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
  /** 保留の日の一覧（両方の案件が決めている日には、その旨を添える） */
  const heldList = (hs: { date: string; count: number; rows: number; others: string[] }[]) => (
    <ul className="plain">
      {hs.map((h) => (
        <li key={h.date}>
          {shortDate(h.date)}：{h.count} 個（{h.rows} 件）／重なっている案件：{h.others.map((n) => `「${n}」`).join('')}
          {claimed.has(h.date) && '（この案件も相手の案件も、この日を自分の実績と決めています。どちらかの案件で、決定を取り消してください）'}
        </li>
      ))}
    </ul>
  );
  /** まだこの案件が決めていない日（＝「この案件の実績にする」を押せる日） */
  const claimable = (hs: { date: string }[]) => hs.map((h) => h.date).filter((d) => !claimed.has(d));

  const remember = (f: Failure | null) => {
    setFailure(f);
    const all = load<Record<string, Failure>>(ERROR_KEY, {});
    if (f) all[p.id] = f; else delete all[p.id];
    save(ERROR_KEY, all);
  };

  /** 同期する。project・venues・source は、直前の操作（別名の登録・割り当ての決定）を反映したものを渡せる */
  const run = (opt: { project?: Project; venues?: Venue[]; source?: ReportSource | null } = {}) => {
    if (busy) return;
    const project = opt.project ?? p;
    setBusy(true);
    // runReportSync は、最初に（何も待たずに）認証を呼ぶ。ここはボタンのタップの中なので、Google の画面が止められない
    void runReportSync(
      { project, projects: data.projects.map((x) => (x.id === project.id ? project : x)), venues: opt.venues ?? data.venues, source: opt.source ?? known },
      { token: requestSheetsToken, rows: fetchReportRows, now: () => new Date().toISOString(), forget: forgetSheetsToken },
    ).then((out) => {
      if (out.ok) {
        onChange((cur) => applySync(cur, out));        // 実績を丸ごと置き換える（成功したときだけ）
        save(SOURCE_KEY, out.source);
        remember(null);
        setEditing(false);
        setUrl('');
        setOpen(attention(out.sync) > 0);
      } else {
        remember({ at: new Date().toISOString(), message: out.message });   // 案件のデータには触れない
        setOpen(true);
      }
    }).finally(() => setBusy(false));
  };

  const start = () => {
    if (!needsSource) { run(); return; }
    const src = parseSheetUrl(url);
    if (!src) { setUrlError('スプレッドシートの URL（https://docs.google.com/spreadsheets/d/… で始まるもの）を貼り付けてください。'); setOpen(true); return; }
    setUrlError('');
    run({ source: src });
  };
  const claim = (ds: string[]) => {
    const next = [...new Set([...(p.reportClaims ?? []), ...ds])].sort();
    onChange((cur) => ({ ...cur, reportClaims: next }));
    run({ project: { ...p, reportClaims: next } });
  };
  // 決定を取り消す。取り消した日の実績は、その場で使わなくなる（保存してある実績は、使うたびに、いまの決定と照らすため。
  // このあとの同期が失敗しても、同じ回答が相手の案件と二重に数えられることはない）。続けて同期し直して、表示を最新にする
  const unclaim = (d: string) => {
    const next = (p.reportClaims ?? []).filter((x) => x !== d);
    onChange((cur) => ({ ...cur, reportClaims: next }));
    run({ project: { ...p, reportClaims: next } });
  };
  const addAlias = (name: string) => {
    if (!venue) return;
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
        <span className="reportbar__status" data-testid="report-status">{summary}</span>
        <button className="reportbar__more" onClick={() => setOpen((v) => !v)} data-testid="report-toggle">
          {failure ? '✕ 同期できませんでした' : notes > 0 ? `⚠ 確認 ${notes} 件` : '詳細'} {open ? '▲' : '▼'}
        </button>
      </div>

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
                  {heldList(assigned)}
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
          <p className="reportbar__hint">同期は、この案件の実績を日報の内容で置き換えます（何度押しても二重には数えません）。日報そのものは変更しません。</p>
        </div>
      )}
    </div>
  );
}
