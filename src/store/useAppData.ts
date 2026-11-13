// アプリのデータの入口。データの置き場所は 2 つあり、自動では混ざらない。
//
//   「この端末だけのデータ」… ブラウザ内（localStorage）に保存。同期しない。未ログインでも使える。
//                              サンプルの読み込み・バックアップからの復元は、必ずこちらに入る。
//   「共有データ」          … ログイン中に使える。Firestore が正（sharedSession.ts）。
//
// 画面は、いま選んでいる置き場所のデータ（data）だけを見る。置き場所をまたぐのは、明示的な「コピー」だけ。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { emptyData } from '../domain/seed';
import { genId } from '../domain/util';
import { downloadBlob } from '../export/download';
import { isFirebaseConfigured, onDbResetElsewhere } from '../firebase';
import { AppData, Project } from '../types';
import { loadLocal, saveLocal } from './localData';
import { Notice, capNotices } from './notices';
import { MasterKey } from './paths';
import { OFF_VIEW, SessionHooks, SharedSession, SharedView, claimCache, discardUnsent } from './sharedSession';
import { ProjectCopy, planProjectCopy } from './sharedLogic';

export { hydrateData } from './localData';
export type { MasterKey } from './paths';
export type { Notice } from './notices';

export type Space = 'local' | 'shared';

const SPACE_KEY = 'kkl_space_v1';
const NOTICE_KEY = 'kkl_notices_v1';
const SEEN_KEY = 'kkl_v3_seen';
const EMPTY = emptyData();
const noSubscribe = () => () => {};
const offView = () => OFF_VIEW;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量超過などは無視 */ }
}

/** コピーの結果を、コピー先（この端末だけのデータ）に足す */
function applyCopy(d: AppData, copy: ProjectCopy): AppData {
  return {
    staff: [...d.staff, ...(copy.add.staff ?? [])],
    venues: [...d.venues, ...(copy.add.venues ?? [])],
    contents: [...d.contents, ...(copy.add.contents ?? [])],
    partTypes: [...d.partTypes, ...(copy.add.partTypes ?? [])],
    composites: [...d.composites, ...(copy.add.composites ?? [])],
    projects: [...d.projects, { ...copy.project, updatedAt: Date.now() }],
  };
}

export function downloadJson(filename: string, json: unknown): void {
  downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), filename);
}

export interface AppStore {
  /** いま表示している置き場所 */
  space: Space;
  setSpace: (s: Space) => void;
  /** 共有データを選べる状態か（ログイン中） */
  canShare: boolean;
  /** 表示している置き場所のデータ。共有を選んでいて、まだ使えない間は空 */
  data: AppData;
  /** 表示している置き場所のデータを編集できる状態か */
  usable: boolean;
  /** 「この端末だけのデータ」（どちらを表示していても参照できる） */
  local: AppData;
  shared: SharedView;
  session: SharedSession | null;
  notices: Notice[];
  notify: (kind: Notice['kind'], text: string) => void;
  dismissNotice: (id: string) => void;
  /** マスタの置き換え */
  setMaster: <K extends MasterKey>(key: K, items: AppData[K]) => void;
  addProject: (p: Project) => void;
  updateProject: (id: string, fn: (p: Project) => Project) => void;
  /**
   * 表示している置き場所の、いまの案件（画面の描画を待たずに読む。無ければ undefined）。
   * あとから届く処理（日報の同期など）の結果を書く前に、案件が変わっていないかを確かめるために使う
   */
  getProject: (id: string) => Project | undefined;
  removeProject: (id: string) => void;
  /** 「この端末だけのデータ」を丸ごと置き換える（サンプル読込・バックアップ復元）。共有データには触れない */
  replaceLocal: (d: AppData) => void;
  /** 表示中の案件を、もう一方の置き場所へコピーする。コピー先に無い会場・コンテンツ・スタッフ・パーツも一緒に足す（上書きはしない） */
  copyProject: (id: string, to: Space) => Promise<boolean>;
  /** ログアウトの前に呼ぶ。送れるものを送り、残る未送信の件数を返す */
  beforeSignOut: () => Promise<number>;
  /** ログアウトで未送信の変更を破棄する */
  discardUnsent: () => void;
}

export function useAppData(): AppStore {
  const { user, loading } = useAuth();
  const canShare = isFirebaseConfigured && !!user;
  const [local, setLocal] = useState<AppData>(loadLocal);
  const [notices, setNotices] = useState<Notice[]>(() => loadJson<Notice[]>(NOTICE_KEY, []));
  const [pref, setPref] = useState<Space>(() => (loadJson<string>(SPACE_KEY, 'shared') === 'local' ? 'local' : 'shared'));
  const [session, setSession] = useState<SharedSession | null>(null);
  const shared = useSyncExternalStore(session ? session.subscribe : noSubscribe, session ? session.getView : offView);

  // ── この端末だけのデータ: 変更のたびにすぐ保存する ──
  // まとめて遅らせると、入力の直後に再読み込み・タブを閉じた場合（スマホでの画面切り替えを含む）に最後の入力が消える
  const notify = useCallback((kind: Notice['kind'], text: string) => {
    setNotices((n) => capNotices([...n, { id: genId(), kind, text, at: Date.now() }]));
  }, []);
  const saveFailed = useRef(false);
  useEffect(() => {
    const ok = saveLocal(local);
    // 保存できなかった（ブラウザの保存領域がいっぱい）ことを、黙ったままにしない。続けて何度も知らせない
    if (!ok && !saveFailed.current) {
      notify('warn', 'このブラウザの保存領域がいっぱいのため、「この端末だけのデータ」を保存できませんでした。このまま閉じると、最後の変更が失われます。「データ」タブでバックアップを保存してから、不要な案件を削除してください。');
    }
    saveFailed.current = !ok;
  }, [local, notify]);
  useEffect(() => { saveJson(NOTICE_KEY, notices); }, [notices]);

  // ほかの画面（タブ）が端末内の共有データの控えを消した（ログアウト・アカウントの切り替えなど）:
  // この画面の Firestore への接続は使えなくなっているので、読み込み直す（送信前の変更は、控えに残っている）
  useEffect(() => onDbResetElsewhere(() => { window.location.reload(); }), []);

  const dismissNotice = useCallback((id: string) => setNotices((n) => n.filter((x) => x.id !== id)), []);
  const setSpace = useCallback((s: Space) => { setPref(s); saveJson(SPACE_KEY, s); }, []);

  // ── 共有データのセッション（ログインしているアカウントごと） ──
  const hooks = useRef<SessionHooks>(null as unknown as SessionHooks);
  hooks.current = {
    // 共有に反映できなかった案件を、参照している会場・コンテンツ・スタッフ・パーツごと、この端末に控えとして残す
    stash: (p, sharedData) => {
      const newId = genId();
      setLocal((d) => {
        const copy = planProjectCopy({ ...sharedData, projects: [p] }, p.id, d, newId, '（控え）');
        return copy ? applyCopy(d, copy) : d;
      });
      return `${p.name}（控え）`;
    },
    notify,
    download: downloadJson,
  };
  const uid = canShare ? user!.uid : null;
  const email = user?.email ?? '';
  const displayName = user?.displayName ?? '';
  useEffect(() => {
    if (loading) return;
    if (!uid) {
      setSession(null);
      void claimCache(null);                       // ログアウト: 端末内の共有データの控えを消す
      return;
    }
    const s = new SharedSession({ uid, email, displayName }, {
      stash: (p, d) => hooks.current.stash(p, d),
      notify: (k, t) => hooks.current.notify(k, t),
      download: (f, j) => hooks.current.download(f, j),
    });
    setSession(s);
    s.start();
    return () => s.stop();
  }, [uid, email, displayName, loading]);

  // ログインした瞬間は、共有データを表示する（再読み込みでログイン状態が戻っただけのときは、前回の選択のまま）
  const wasSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (loading) return;
    if (wasSignedIn.current === false && canShare) setSpace('shared');
    wasSignedIn.current = canShare;
  }, [canShare, loading, setSpace]);

  const space: Space = canShare && pref === 'shared' ? 'shared' : 'local';
  const ready = shared.phase === 'ready';
  const usable = space === 'local' || ready;
  const data = space === 'local' ? local : ready ? shared.data : EMPTY;

  // 以前の版（共有のたびに端末にも保存していた）から使っている端末への案内。初めて共有データを開いたときに 1 回だけ
  useEffect(() => {
    if (!ready || loadJson<boolean>(SEEN_KEY, false)) return;
    saveJson(SEEN_KEY, true);
    if (local.projects.length > 0 || local.staff.length > 0 || local.venues.length > 0) {
      notify('info', 'この端末には、「この端末だけのデータ」が残っています（以前の版で保存したもの・試しに入れたサンプルなど）。共有データとは別の入れ物で、自動では混ざりません。画面上部の帯で切り替えて確認できます。');
    }
  }, [ready, local, notify]);

  // 画面が表示している内容（操作は「表示していた内容からの差分」として扱う）
  const shown = useRef(data);
  useLayoutEffect(() => { shown.current = data; });

  const setMaster = useCallback(<K extends MasterKey>(key: K, items: AppData[K]) => {
    if (space === 'shared') session?.setMaster(key, shown.current[key], items);
    else setLocal((d) => ({ ...d, [key]: items }));
  }, [space, session]);

  const addProject = useCallback((p: Project) => {
    if (space === 'shared') session?.addProject(p);
    else setLocal((d) => ({ ...d, projects: [...d.projects, { ...p, updatedAt: Date.now() }] }));
  }, [space, session]);

  const updateProject = useCallback((id: string, fn: (p: Project) => Project) => {
    if (space === 'shared') session?.updateProject(id, fn);
    else setLocal((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)) }));
  }, [space, session]);

  // 置き場所にある、いまの案件（画面の描画を待たずに読む）。あとから届いた処理（日報の同期など）の結果を書く前に、
  // 案件が、処理を始めたときから変わっていないかを確かめるために使う。古い画面が持っている関数から呼んでも、いまの内容が返る
  const localNow = useRef(local);
  localNow.current = local;
  const getProject = useCallback((id: string): Project | undefined => {
    if (space === 'shared') {
      const v = session?.getView();
      return v && v.phase === 'ready' ? v.data.projects.find((p) => p.id === id) : undefined;
    }
    return localNow.current.projects.find((p) => p.id === id);
  }, [space, session]);

  const removeProject = useCallback((id: string) => {
    if (space === 'shared') session?.removeProject(id);
    else setLocal((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== id) }));
  }, [space, session]);

  const replaceLocal = useCallback((d: AppData) => {
    const now = Date.now();
    setLocal({ ...d, projects: d.projects.map((p) => ({ ...p, updatedAt: now })) });
    setSpace('local');
  }, [setSpace]);

  const copying = useRef(false);
  const copyProject = useCallback(async (id: string, to: Space): Promise<boolean> => {
    const from = to === 'shared' ? local : shared.data;
    const target = to === 'shared' ? shared.data : local;
    if (to === 'shared' && (!session || shared.phase !== 'ready')) return false;
    const copy = planProjectCopy(from, id, target, genId());
    if (!copy) return false;
    let existed = 0;
    if (to === 'shared') {
      // 共有へのコピーは、共有側に「まだ無い」ことを確かめながら作るので、結果が分かるまで少し待つ
      if (copying.current) { notify('warn', '前のコピーの処理が、まだ終わっていません。少し待ってから、もう一度お試しください。'); return false; }
      copying.current = true;
      try {
        const r = await session!.importCopy(copy);
        if (!r.ok) { notify('warn', r.message); return false; }
        existed = r.existed;
      } finally {
        copying.current = false;
      }
    } else {
      setLocal((d) => applyCopy(d, copy));
    }
    const name = copy.project.name || '名称未設定';
    const added = (Object.values(copy.add) as { id: string }[][]).reduce((n, xs) => n + xs.length, 0) - existed;
    notify('info', [
      `案件「${name}」を、${to === 'shared' ? '共有データ' : 'この端末だけのデータ'}へコピーしました（元の案件はそのまま残っています）。`,
      added > 0 ? `案件が使っている会場・コンテンツ・スタッフ・パーツのうち、コピー先に無かった ${added} 件も一緒に追加しました。` : '',
      existed > 0 ? `一緒に追加しようとした ${existed} 件は、直前にコピー先へ追加されていたため、コピー先にある内容をそのまま使います（上書きしていません）。` : '',
      ...copy.notes,
    ].filter(Boolean).join(' '));
    return true;
  }, [local, shared, session, notify]);

  const beforeSignOut = useCallback(async () => (session ? session.settle() : 0), [session]);
  const discard = useCallback(() => { if (uid) discardUnsent(uid); }, [uid]);

  return useMemo(() => ({
    space, setSpace, canShare, data, usable, local, shared, session, notices, notify, dismissNotice,
    setMaster, addProject, updateProject, getProject, removeProject, replaceLocal, copyProject, beforeSignOut, discardUnsent: discard,
  }), [space, setSpace, canShare, data, usable, local, shared, session, notices, notify, dismissNotice,
    setMaster, addProject, updateProject, getProject, removeProject, replaceLocal, copyProject, beforeSignOut, discard]);
}
