import { useEffect, useMemo, useRef, useState } from 'react';
import AuthButton from './components/AuthButton';
import Grid, { Col } from './components/Grid';
import { ContentMaster, PartMaster, StaffMaster, VenueMaster } from './components/Masters';
import ProjectView from './components/ProjectView';
import { MembersPanel, NoticeList, ReportTable, SharedPhasePanel, SpaceBar } from './components/Shared';
import { PHONE, useMediaQuery } from './components/useMedia';
import { useAuth } from './contexts/AuthContext';
import { estimate } from './domain/calc';
import { projectMoney } from './domain/jcos';
import { duplicateProject, newProject, sampleData } from './domain/seed';
import { genId, listDates, localDate, shortDate, yen } from './domain/util';
import { projectWarnings } from './domain/warnings';
import { isFirebaseConfigured } from './firebase';
import { isEmptyData } from './store/localData';
import { MigrationReport } from './store/sharedLogic';
import { downloadJson, hydrateData, useAppData } from './store/useAppData';
import { Project } from './types';
import './styles/app.css';

type Tab = 'projects' | 'staff' | 'venues' | 'contents' | 'parts' | 'data' | 'members';
const TABS: { id: Tab; label: string }[] = [
  { id: 'projects', label: '案件' },
  { id: 'staff', label: 'スタッフ' },
  { id: 'venues', label: '会場' },
  { id: 'contents', label: 'コンテンツ' },
  { id: 'parts', label: 'パーツ' },
  { id: 'data', label: 'データ' },
];

export default function App() {
  const store = useAppData();
  const { data, setMaster, space, shared, usable } = store;
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('projects');
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const open = data.projects.find((p) => p.id === openId);
  const signedIn = store.canShare;
  const onShared = space === 'shared';
  // 名簿を扱えるのは、管理者と、メンバー制がまだ適用されていない間（準備のため）のログイン中の人
  const canManageMembers = signedIn && !['off', 'checking', 'unregistered', 'error'].includes(shared.phase)
    && (shared.role === 'owner' || shared.role === 'open' || (!shared.enforced && shared.role !== 'none'));
  const tabs = canManageMembers ? [...TABS, { id: 'members' as Tab, label: 'メンバー' }] : TABS;

  // 置き場所を切り替えたら、開いている案件を閉じる（別の入れ物の案件なので）
  const changeSpace = (s: typeof space) => { setOpenId(null); store.setSpace(s); };
  // 開いていた案件が無くなった（ほかの端末で削除された）ときは、一覧に戻して知らせる
  const lastOpen = useRef<{ id: string; name: string } | null>(null);
  // 置き場所が変わった（ログイン・ログアウトによる自動の切り替えを含む）ら、開いていた案件を黙って閉じる
  // （別の入れ物の案件なので。同じ ID の案件がもう一方にあっても、気付かないまま別の入れ物を編集しないようにする）
  const shownSpace = useRef(space);
  useEffect(() => {
    if (shownSpace.current === space) return;
    shownSpace.current = space;
    lastOpen.current = null;
    setOpenId(null);
  }, [space]);
  useEffect(() => {
    if (open) { lastOpen.current = { id: open.id, name: open.name }; return; }
    if (!openId) { lastOpen.current = null; return; }
    if (!usable) return;                          // 共有データの確認中。戻ったときにまだあれば、そのまま開く
    if (lastOpen.current?.id === openId && onShared) {
      store.notify('info', `開いていた案件「${lastOpen.current.name || '名称未設定'}」は、共有データから無くなりました（ほかの端末で削除された可能性があります）。`);
    }
    lastOpen.current = null;
    setOpenId(null);
  }, [open, openId, usable, onShared, store]);
  useEffect(() => { if (tab === 'members' && !canManageMembers) setTab('projects'); }, [tab, canManageMembers]);

  // 一覧の金額: JCOS 案件は 請求・実費・粗利、それ以外は従来の 売上・費用・利益
  const rows = useMemo(
    () => data.projects.map((p) => {
      const est = estimate(p, data);
      return { p, est, money: projectMoney(p, data, est), warn: projectWarnings(p, data).filter((w) => w.severity === 'warn').length };
    }),
    [data],
  );
  // スマホ幅では、表の代わりにカードで並べる（カード全体を押して開く。表は右端の「開く」まで横スクロールが要るため）
  const phone = useMediaQuery(PHONE);
  type Row = (typeof rows)[number];
  const venueName = (id: string) => data.venues.find((v) => v.id === id)?.name ?? '';
  const period = (p: Project) => {
    const d = listDates(p.startDate, p.endDate);
    return d.length ? `${shortDate(d[0])}〜${shortDate(d[d.length - 1])}（${d.length}日）` : '';
  };
  const cols: Col<Row>[] = [
    { key: 'name', title: '案件名', width: 200, get: (r) => r.p.name || '（名称未設定）', onOpen: (r) => setOpenId(r.p.id) },
    { key: 'venue', title: '会場', width: 140, get: (r) => venueName(r.p.venueId) },
    { key: 'period', title: '期間', width: 200, get: (r) => period(r.p) },
    { key: 'contents', title: 'コンテンツ', width: 150, get: (r) => r.est.contentLines.map((l) => l.name).join('、') },
    { key: 'status', title: '状態', width: 70, get: (r) => r.p.status },
    { key: 'rev', title: '売上', width: 100, align: 'right', get: (r) => yen(r.money.revenue) },
    { key: 'cost', title: '費用', width: 100, align: 'right', get: (r) => yen(r.money.cost) },
    { key: 'profit', title: '利益', width: 110, align: 'right', get: (r) => `${yen(r.money.profit)}${r.money.jcos ? '（粗利）' : ''}`, warn: (r) => (r.money.profit < 0 ? '赤字の試算です' : undefined) },
    { key: 'warn', title: '警告', width: 60, align: 'right', get: (r) => (r.warn ? `⚠ ${r.warn}` : '') },
  ];

  const create = () => {
    const p = newProject(data.venues.length === 1 ? data.venues[0] : undefined);
    store.addProject(p);
    setOpenId(p.id);
  };
  // 複製は新しい案件として V1 から始める。コンテンツ・費用・レイアウトを複製し、スタッフ配置は引き継がない（作業ログ D-19）
  const duplicate = (p: Project) => {
    store.addProject(duplicateProject(p));
    if (p.assignments.length > 0) store.notify('info', `案件「${p.name || '名称未設定'}（コピー）」を作りました。コンテンツ・費用・レイアウトを複製しています（スタッフ配置 ${p.assignments.length} 件は引き継いでいません）。`);
  };
  const remove = (p: Project) => {
    if (window.confirm(`案件「${p.name || '名称未設定'}」を削除します。元に戻せません。よろしいですか？`)) store.removeProject(p.id);
  };

  // 表示中の置き場所のデータを、そのままファイルに保存する
  const exportJson = () => downloadJson(`workshop-planner-backup-${onShared ? '共有データ' : 'この端末'}-${localDate()}.json`, data);
  // サンプルの読み込み・バックアップからの復元は、必ず「この端末だけのデータ」に入れる。共有データには触れない
  // （共有データへ入れたいものは、案件一覧の「共有へコピー」で 1 件ずつ移す）
  const intoLocal = (what: string) =>
    isEmptyData(store.local)
    || window.confirm(`「この端末だけのデータ」を、${what}ですべて置き換えます。${signedIn ? '\n共有データは変わりません。' : ''}\n\nよろしいですか？`);
  const importJson = async (file: File) => {
    try {
      const d = hydrateData(JSON.parse(await file.text()));
      if (intoLocal(`バックアップ（案件 ${d.projects.length} 件）`)) {
        setOpenId(null);
        store.replaceLocal(d);
        setTab('projects');
        if (signedIn) store.notify('info', 'バックアップは「この端末だけのデータ」として読み込みました。共有データは変わっていません。');
      }
    } catch {
      alert('ファイルを読み込めませんでした（JSON 形式ではありません）。');
    }
  };
  const loadSample = () => {
    if (!intoLocal('サンプルデータ')) return;
    setOpenId(null);
    store.replaceLocal(sampleData());
    setTab('projects');
    if (signedIn) store.notify('info', 'サンプルは「この端末だけのデータ」に読み込みました。共有データは変わっていません。共有で使う案件は、案件一覧の「共有へコピー」で移せます。');
  };
  const copyTo = (p: Project) => {
    const to = onShared ? 'local' : 'shared';
    const dest = to === 'shared' ? '共有データ' : 'この端末だけのデータ';
    if (to === 'shared' && shared.phase !== 'ready') { alert('共有データを使える状態になっていません。画面上部の帯で「共有データ」を選び、状態を確認してください。'); return; }
    // 共有側の最新の内容を受け取れていない間は、コピーしない（「共有側に無い」と判断したものを、上書きしてしまうため）
    if (to === 'shared' && (!shared.online || shared.fromCache)) { alert('共有データの最新の内容を確認できていないため、いまはコピーできません。\n接続を確認して、少し待ってから、もう一度お試しください。'); return; }
    if (!window.confirm(`案件「${p.name || '名称未設定'}」を、${dest}へコピーします。\n案件が使っている会場・コンテンツ・スタッフ・パーツのうち、コピー先に無いものも一緒に追加します（既にあるものは上書きしません）。\n\nよろしいですか？`)) return;
    void store.copyProject(p.id, to);   // 結果は、画面上部のお知らせに出る
  };
  const logout = async () => {
    const unsent = await store.beforeSignOut();
    if (unsent > 0) {
      if (!window.confirm(`まだ共有データに送れていない変更が ${unsent} 件あります。\nログアウトすると、この変更は破棄されます（接続できる状態で少し待つと送信されます）。\n\nログアウトしますか？`)) return;
      store.discardUnsent();
    }
    await signOut();
  };

  const sharedLabel = (): string => {
    switch (shared.phase) {
      case 'ready':
        if (shared.unsent > 0) return !shared.online ? `オフライン（未送信 ${shared.unsent} 件）` : shared.stalled ? `送信待ち（未送信 ${shared.unsent} 件）` : '同期中…';
        return !shared.online ? 'オフライン（最後に受信した内容を表示）' : shared.fromCache ? '同期中…' : '保存済み';
      case 'checking': return '共有データを確認中…';
      case 'migrating': return '移行中…';
      case 'unregistered': return '未登録のアカウント';
      case 'error': return '共有データを確認できません';
      default: return '共有データは準備中';
    }
  };
  const syncLabel = !isFirebaseConfigured
    ? 'この端末に保存（Firebase 未設定）'
    : !user ? 'この端末に保存（未ログイン）'
    : onShared ? sharedLabel()
    : `この端末に保存${shared.unsent > 0 ? `／共有: 未送信 ${shared.unsent} 件` : ''}`;
  const syncTone = onShared && (shared.phase === 'error' || shared.phase === 'unregistered') ? 'error' : onShared ? 'shared' : 'local';
  const metaReport = (shared.report ?? (shared.meta?.report as MigrationReport | undefined)) || null;

  return (
    <div className="app">
      <header className="app__head">
        <h1>KitaKita Lab ワークショップ運営プランナー</h1>
        <span className={`sync sync--${syncTone}`}>{syncLabel}</span>
        <AuthButton onSignOut={logout} />
      </header>
      <SpaceBar store={{ ...store, setSpace: changeSpace }} signedIn={signedIn} configured={isFirebaseConfigured} />
      <nav className="app__tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => { setTab(t.id); setOpenId(null); }}>{t.label}</button>
        ))}
      </nav>

      <main className="app__main">
        <NoticeList notices={store.notices} onDismiss={store.dismissNotice} />
        {tab === 'members' && canManageMembers && <MembersPanel shared={shared} session={store.session} />}
        {tab !== 'members' && tab !== 'data' && !usable && (
          <SharedPhasePanel shared={shared} session={store.session} onUseLocal={() => changeSpace('local')} />
        )}
        {usable && <>
        {tab === 'projects' && open && (
          <ProjectView
            project={open} data={data} onBack={() => setOpenId(null)}
            onChange={(fn) => store.updateProject(open.id, fn)}
            onSaveVenueTemplate={(venueId, p) => setMaster('venues', data.venues.map((v) => (v.id === venueId
              ? { ...v, template: { ...v.template, width: p.layout.width, height: p.layout.height, env: p.layout.env.map((e) => ({ ...e, id: genId() })) } }
              : v)))}
            onAddVenueAlias={(venueId, name) => setMaster('venues', data.venues.map((v) => (v.id === venueId
              ? { ...v, reportNames: [...new Set([...(v.reportNames ?? []), name.trim()])].filter(Boolean) }
              : v)))}
          />
        )}
        {tab === 'projects' && !open && (
          <section>
            <h2>案件一覧<small>案件 ＝ 会場 × 期間 × 実施コンテンツ</small></h2>
            {phone ? (
              <div className="plist" data-testid="project-cards">
                {rows.length === 0 && <p className="hint">案件がありません。「＋ 新しい案件」か、データタブの「サンプルデータを読み込む」から始められます</p>}
                {rows.map((r) => (
                  <div key={r.p.id} className="pcard" data-testid="project-card">
                    {/* カード全体が「開く」ボタン。複製・コピー・削除は、下の小さいボタン（押し間違えにくいように分ける） */}
                    <button className="pcard__open" onClick={() => setOpenId(r.p.id)} aria-label={`案件「${r.p.name || '名称未設定'}」を開く`}>
                      <span className="pcard__name">{r.p.name || '（名称未設定）'}<span className="pcard__status">{r.p.status}</span>{r.warn > 0 && <span className="pcard__warn">⚠ {r.warn}</span>}</span>
                      <span className="pcard__sub">{venueName(r.p.venueId) || '会場未選択'}{period(r.p) ? `・${period(r.p)}` : ''}</span>
                      <span className="pcard__money">
                        <span>{r.money.jcos ? '請求' : '売上'} {yen(r.money.revenue)}</span>
                        <span>{r.money.jcos ? '実費' : '費用'} {yen(r.money.cost)}</span>
                        <b className={r.money.profit < 0 ? 'neg' : ''}>{r.money.jcos ? '粗利' : '利益'} {yen(r.money.profit)}</b>
                      </span>
                      <span className="pcard__go" aria-hidden="true">›</span>
                    </button>
                    <div className="pcard__actions">
                      <button onClick={() => duplicate(r.p)}>複製</button>
                      {signedIn && <button data-testid="copy-project" onClick={() => copyTo(r.p)}>{onShared ? '端末へコピー' : '共有へコピー'}</button>}
                      <button onClick={() => remove(r.p)} aria-label={`案件「${r.p.name || '名称未設定'}」を削除`}>削除</button>
                    </div>
                  </div>
                ))}
                <button className="grid__add" onClick={create}>＋ 新しい案件</button>
              </div>
            ) : (
            <Grid
              rows={rows} cols={cols} rowKey={(r) => r.p.id} onAdd={create} addLabel="＋ 新しい案件"
              rowActions={(r) => (
                <>
                  <button className="cellbtn cellbtn--wide primary" onClick={() => setOpenId(r.p.id)}>開く</button>
                  <button className="cellbtn cellbtn--wide" title="コンテンツ・費用・レイアウトを複製します（スタッフ配置は引き継ぎません）" onClick={() => duplicate(r.p)}>複製</button>
                  {signedIn && (
                    <button className="cellbtn cellbtn--wide" data-testid="copy-project" title={onShared ? 'この案件の写しを「この端末だけのデータ」に作ります' : 'この案件の写しを共有データに作ります'} onClick={() => copyTo(r.p)}>
                      {onShared ? '端末へコピー' : '共有へコピー'}
                    </button>
                  )}
                  <button className="cellbtn" title="削除" onClick={() => remove(r.p)}>×</button>
                </>
              )}
              emptyText="案件がありません。「＋ 新しい案件」か、データタブの「サンプルデータを読み込む」から始められます"
            />
            )}
          </section>
        )}
        {tab === 'staff' && <StaffMaster data={data} setMaster={setMaster} />}
        {tab === 'venues' && <VenueMaster data={data} setMaster={setMaster} />}
        {tab === 'contents' && <ContentMaster data={data} setMaster={setMaster} />}
        {tab === 'parts' && <PartMaster data={data} setMaster={setMaster} />}
        </>}
        {tab === 'data' && (
          <section>
            <h2>データ</h2>
            <div className="panel panel--wide">
              <div className="panel__title">サンプルデータ</div>
              <p className="hint">
                参考の配置図（ラソラ札幌）をなぞった会場雛形・レイアウト・試算のサンプルです。案件は 2 件入ります：
                デモ（12/5〜6）と、ラソラ札幌 11/13〜17・フラワーボトルの土台。<b>金額・個数・人員・時間・寸法はすべて仮置きの値</b>で、人名は架空です。
              </p>
              <p className="hint">
                サンプルは、必ず<b>「この端末だけのデータ」</b>に読み込みます{signedIn ? '（ログイン中でも、共有データは変わりません）' : ''}。
                共有データで使いたい案件は、案件一覧の「共有へコピー」で 1 件ずつ移せます。
              </p>
              <div className="panel__btns"><button onClick={loadSample}>サンプルデータを読み込む</button></div>
            </div>
            <div className="panel panel--wide">
              <div className="panel__title">バックアップ</div>
              <p className="hint">
                保存：いま表示しているデータ（<b>{onShared ? '共有データ' : 'この端末だけのデータ'}</b>）を JSON ファイルにします。
                復元：ファイルの内容を「この端末だけのデータ」として読み込みます（共有データを丸ごと置き換える操作はありません）。
              </p>
              <div className="panel__btns">
                <button onClick={exportJson} disabled={!usable}>バックアップを保存（JSON）</button>
                <button onClick={() => fileRef.current?.click()}>バックアップから復元…</button>
                <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
              </div>
            </div>
            {signedIn && (
              <div className="panel panel--wide" data-testid="shared-info">
                <div className="panel__title">共有データの状態</div>
                <p className="hint">
                  アカウント：{shared.email || '—'}（{{ owner: '管理者', member: 'メンバー', open: '名簿に未登録（メンバー制が未適用のため利用可）', none: '未登録' }[shared.role]}）
                  ／メンバー制：{shared.enforced ? '適用中' : '未適用'}
                  {shared.meta?.source ? `／データの始まり：${shared.meta.source === 'legacy' ? '以前の版から移行' : '新規'}` : ''}
                </p>
                {metaReport && Array.isArray(metaReport.rows) && (
                  <>
                    <p className="hint">以前の版の形式からの移行の記録（以前の形式のデータと移行前バックアップは、共有側に残してあります）：</p>
                    <ReportTable report={{ ok: !!metaReport.ok, rows: metaReport.rows, notes: metaReport.notes ?? [], mismatches: metaReport.mismatches ?? [] }} />
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
