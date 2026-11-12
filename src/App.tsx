import { useMemo, useRef, useState } from 'react';
import AuthButton from './components/AuthButton';
import Grid, { Col } from './components/Grid';
import { ContentMaster, PartMaster, StaffMaster, VenueMaster } from './components/Masters';
import ProjectView from './components/ProjectView';
import { useAuth } from './contexts/AuthContext';
import { estimate } from './domain/calc';
import { duplicateProject, newProject, sampleData } from './domain/seed';
import { genId, listDates, localDate, shortDate, yen } from './domain/util';
import { projectWarnings } from './domain/warnings';
import { isFirebaseConfigured } from './firebase';
import { hydrateData, useAppData } from './store/useAppData';
import { Project } from './types';
import './styles/app.css';

type Tab = 'projects' | 'staff' | 'venues' | 'contents' | 'parts' | 'data';
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
  const { data, setMaster } = store;
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('projects');
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const open = data.projects.find((p) => p.id === openId);

  const rows = useMemo(
    () => data.projects.map((p) => ({ p, est: estimate(p, data), warn: projectWarnings(p, data).filter((w) => w.severity === 'warn').length })),
    [data],
  );
  type Row = (typeof rows)[number];
  const venueName = (id: string) => data.venues.find((v) => v.id === id)?.name ?? '';
  const period = (p: Project) => {
    const d = listDates(p.startDate, p.endDate);
    return d.length ? `${shortDate(d[0])}〜${shortDate(d[d.length - 1])}（${d.length}日）` : '';
  };
  const cols: Col<Row>[] = [
    { key: 'name', title: '案件名', width: 200, get: (r) => r.p.name || '（名称未設定）' },
    { key: 'venue', title: '会場', width: 160, get: (r) => venueName(r.p.venueId) },
    { key: 'period', title: '期間', width: 210, get: (r) => period(r.p) },
    { key: 'contents', title: 'コンテンツ', width: 180, get: (r) => r.est.contentLines.map((l) => l.name).join('、') },
    { key: 'status', title: '状態', width: 70, get: (r) => r.p.status },
    { key: 'rev', title: '売上', width: 100, align: 'right', get: (r) => yen(r.est.revenue) },
    { key: 'cost', title: '費用', width: 100, align: 'right', get: (r) => yen(r.est.totalCost) },
    { key: 'profit', title: '利益', width: 100, align: 'right', get: (r) => yen(r.est.profit), warn: (r) => (r.est.profit < 0 ? '赤字の試算です' : undefined) },
    { key: 'warn', title: '警告', width: 60, align: 'right', get: (r) => (r.warn ? `⚠ ${r.warn}` : '') },
  ];

  const create = () => {
    const p = newProject(data.venues.length === 1 ? data.venues[0] : undefined);
    store.addProject(p);
    setOpenId(p.id);
  };
  // 複製は新しい案件として V1 から始める
  const duplicate = (p: Project) => store.addProject(duplicateProject(p));
  const remove = (p: Project) => {
    if (window.confirm(`案件「${p.name || '名称未設定'}」を削除します。元に戻せません。よろしいですか？`)) store.removeProject(p.id);
  };

  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `workshop-planner-backup-${localDate()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // ログイン中の全置き換えは、この端末だけでなくチームで共有しているデータ（Firestore）にも及ぶ。必ず確認する
  const sharedNote = user ? '\n\n⚠ ログイン中のため、この端末だけでなく、チームで共有しているデータも置き換わります。' : '';
  const importJson = async (file: File) => {
    try {
      const d = hydrateData(JSON.parse(await file.text()));
      if (window.confirm(`バックアップ（案件 ${d.projects.length} 件）を読み込み、現在のデータをすべて置き換えます。${sharedNote}\n\nよろしいですか？`)) store.replaceAll(d);
    } catch {
      alert('ファイルを読み込めませんでした（JSON 形式ではありません）。');
    }
  };
  const loadSample = () => {
    const empty = data.projects.length === 0 && data.staff.length === 0 && data.venues.length === 0;
    if ((empty && !user) || window.confirm(`現在のデータをすべてサンプルデータで置き換えます。${sharedNote}\n\nよろしいですか？`)) {
      store.replaceAll(sampleData());
      setTab('projects');
    }
  };

  const syncLabel = !isFirebaseConfigured
    ? 'この端末に保存（Firebase 未設定）'
    : !user ? 'この端末に保存（未ログイン）'
    : { local: '同期待機', saving: '同期中…', saved: '保存済み', error: '同期失敗' }[store.syncState];

  return (
    <div className="app">
      <header className="app__head">
        <h1>KitaKita Lab ワークショップ運営プランナー</h1>
        <span className={`sync sync--${user ? store.syncState : 'local'}`}>{syncLabel}</span>
        <AuthButton />
      </header>
      <nav className="app__tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => { setTab(t.id); setOpenId(null); }}>{t.label}</button>
        ))}
      </nav>

      <main className="app__main">
        {tab === 'projects' && open && (
          <ProjectView
            project={open} data={data} onBack={() => setOpenId(null)}
            onChange={(fn) => store.updateProject(open.id, fn)}
            onSaveVenueTemplate={(venueId, p) => setMaster('venues', data.venues.map((v) => (v.id === venueId
              ? { ...v, template: { ...v.template, width: p.layout.width, height: p.layout.height, env: p.layout.env.map((e) => ({ ...e, id: genId() })) } }
              : v)))}
          />
        )}
        {tab === 'projects' && !open && (
          <section>
            <h2>案件一覧<small>案件 ＝ 会場 × 期間 × 実施コンテンツ</small></h2>
            <Grid
              rows={rows} cols={cols} rowKey={(r) => r.p.id} onAdd={create} addLabel="＋ 新しい案件"
              rowActions={(r) => (
                <>
                  <button className="cellbtn cellbtn--wide primary" onClick={() => setOpenId(r.p.id)}>開く</button>
                  <button className="cellbtn cellbtn--wide" onClick={() => duplicate(r.p)}>複製</button>
                  <button className="cellbtn" title="削除" onClick={() => remove(r.p)}>×</button>
                </>
              )}
              emptyText="案件がありません。「＋ 新しい案件」か、データタブの「サンプルデータを読み込む」から始められます"
            />
          </section>
        )}
        {tab === 'staff' && <StaffMaster data={data} setMaster={setMaster} />}
        {tab === 'venues' && <VenueMaster data={data} setMaster={setMaster} />}
        {tab === 'contents' && <ContentMaster data={data} setMaster={setMaster} />}
        {tab === 'parts' && <PartMaster data={data} setMaster={setMaster} />}
        {tab === 'data' && (
          <section>
            <h2>データ</h2>
            <div className="panel panel--wide">
              <div className="panel__title">サンプルデータ</div>
              <p className="hint">
                参考の配置図（ラソラ札幌）をなぞった会場雛形・レイアウト・試算のサンプルです。案件は 2 件入ります：
                デモ（12/5〜6）と、ラソラ札幌 11/13〜17・フラワーボトルの土台。<b>金額・個数・人員・時間・寸法はすべて仮置きの値</b>で、人名は架空です。
              </p>
              <div className="panel__btns"><button onClick={loadSample}>サンプルデータを読み込む</button></div>
            </div>
            <div className="panel panel--wide">
              <div className="panel__title">バックアップ</div>
              <p className="hint">全データを JSON ファイルとして保存・復元します。</p>
              <div className="panel__btns">
                <button onClick={exportJson}>バックアップを保存（JSON）</button>
                <button onClick={() => fileRef.current?.click()}>バックアップから復元…</button>
                <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
