// アプリ全データの保持・localStorage 保存・Firestore 同期。
// 旧アプリ useFirestoreSync から引き継いだ原則:
//   1. localStorage と Firestore の二重書き（未ログイン・Firebase 未設定でも単体で動く）
//   2. 初回 snapshot が届くまで Firestore へ書かない（ログイン直後の上書き事故を防ぐ）
//   3. 自分の書き込みのエコーで手元の編集を巻き戻さない
// 3 は旧アプリのフラグ方式ではなく updatedAt の新旧比較で行う（ドラッグ中の連続編集に耐えるため）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { hydrateLayout } from '../domain/layout';
import { emptyData } from '../domain/seed';
import { AppData, Project, Venue } from '../types';
import {
  Actor, MASTER_KEYS, MasterKey, deleteProject, saveMaster, saveProject, subscribeMaster, subscribeProjects,
} from './remote';

const LS_KEY = 'kkl_workshop_v1';
const SAVE_DELAY_MS = 700;

export type SyncState = 'local' | 'saving' | 'saved' | 'error';

function hydrateProject(p: Project): Project {
  return {
    ...p,
    contents: p.contents ?? [],
    assignments: p.assignments ?? [],
    otherCosts: p.otherCosts ?? [],
    layout: hydrateLayout(p.layout),
    updatedAt: p.updatedAt ?? 0,
  };
}

export function hydrateData(raw: Partial<AppData> | null): AppData {
  const base = emptyData();
  if (!raw) return base;
  return {
    staff: raw.staff ?? [],
    venues: (raw.venues ?? []).map((v: Venue) => ({ ...v, template: hydrateLayout(v.template) })),
    contents: (raw.contents ?? []).map((c) => ({ ...c, materials: c.materials ?? [] })),
    partTypes: raw.partTypes ?? base.partTypes,
    composites: raw.composites ?? base.composites,
    projects: (raw.projects ?? []).map(hydrateProject),
  };
}

function loadLocal(): AppData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return hydrateData(raw ? (JSON.parse(raw) as Partial<AppData>) : null);
  } catch {
    return emptyData();
  }
}

export interface AppStore {
  data: AppData;
  syncState: SyncState;
  /** マスタの置き換え */
  setMaster: <K extends MasterKey>(key: K, items: AppData[K]) => void;
  addProject: (p: Project) => void;
  updateProject: (id: string, fn: (p: Project) => Project) => void;
  removeProject: (id: string) => void;
  /** 全データを置き換える（サンプル読込・バックアップ復元） */
  replaceAll: (d: AppData) => void;
}

export function useAppData(): AppStore {
  const { user } = useAuth();
  const [data, setData] = useState<AppData>(loadLocal);
  const [syncState, setSyncState] = useState<SyncState>('local');
  const [ready, setReady] = useState<Record<string, boolean>>({});

  // 「サーバーと一致している」と分かっている参照。これと違うものだけを書き込む。
  const syncedMaster = useRef<Partial<Record<MasterKey, unknown>>>({});
  const syncedProjects = useRef(new Map<string, Project>());
  // マスタごとの最終ローカル編集時刻（エコー・古い snapshot の判定用）
  const masterAt = useRef<Record<string, number>>({});
  // 削除したがまだサーバーへ反映していない案件（snapshot で復活させないため）
  const pendingDeletes = useRef(new Set<string>());
  const dataRef = useRef(data);
  dataRef.current = data;

  const setMaster = useCallback(<K extends MasterKey>(key: K, items: AppData[K]) => {
    masterAt.current[key] = Date.now();
    setData((d) => ({ ...d, [key]: items }));
  }, []);

  const addProject = useCallback((p: Project) => {
    setData((d) => ({ ...d, projects: [...d.projects, { ...p, updatedAt: Date.now() }] }));
  }, []);

  const updateProject = useCallback((id: string, fn: (p: Project) => Project) => {
    setData((d) => ({
      ...d,
      projects: d.projects.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)),
    }));
  }, []);

  const removeProject = useCallback((id: string) => {
    pendingDeletes.current.add(id);
    setData((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== id) }));
  }, []);

  const replaceAll = useCallback((d: AppData) => {
    const now = Date.now();
    for (const k of MASTER_KEYS) masterAt.current[k] = now;
    setData({ ...d, projects: d.projects.map((p) => ({ ...p, updatedAt: now })) });
  }, []);

  // ── Firestore 購読 ──
  useEffect(() => {
    setReady({});
    syncedMaster.current = {};
    syncedProjects.current = new Map();
    if (!user) { setSyncState('local'); return; }

    const unsubs = MASTER_KEYS.map((key) =>
      subscribeMaster(
        key,
        (items, updatedAt) => {
          // 手元の編集のほうが新しければ採用しない（次の保存でサーバーを更新する）
          if (updatedAt < (masterAt.current[key] ?? 0)) return;
          const hydrated = hydrateData({ [key]: items })[key];
          masterAt.current[key] = updatedAt;
          syncedMaster.current[key] = hydrated;
          setData((d) => ({ ...d, [key]: hydrated }));
        },
        () => setReady((r) => ({ ...r, [key]: true })),
      ),
    );

    unsubs.push(
      subscribeProjects(
        (remote) => {
          const local = dataRef.current.projects;
          const localById = new Map(local.map((p) => [p.id, p]));
          const remoteIds = new Set(remote.map((p) => p.id));
          const next: Project[] = [];
          for (const raw of remote) {
            if (pendingDeletes.current.has(raw.id)) continue;
            const r = hydrateProject(raw);
            const l = localById.get(r.id);
            if (l && l.updatedAt >= r.updatedAt) {
              // 手元が同じか新しい → 手元を維持。同時刻なら「同期済み」として記録
              if (l.updatedAt === r.updatedAt) syncedProjects.current.set(l.id, l);
              next.push(l);
            } else {
              syncedProjects.current.set(r.id, r);
              next.push(r);
            }
          }
          for (const l of local) {
            if (remoteIds.has(l.id)) continue;
            // サーバーに存在していたものが消えた → 他の人が削除した。未保存の新規は残す
            if (syncedProjects.current.has(l.id)) syncedProjects.current.delete(l.id);
            else next.push(l);
          }
          setData((d) => ({ ...d, projects: next }));
        },
        () => setReady((r) => ({ ...r, projects: true })),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [user]);

  // ── 保存（この端末）: 変更のたびにすぐ保存する ──
  // まとめて遅らせると、入力の直後に再読み込み・タブを閉じた場合（スマホでの画面切り替えを含む）に最後の入力が消える
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* 容量超過などは無視 */ }
  }, [data]);

  // ── 保存（Firestore）: ログイン時のみ。0.7 秒まとめてから、変わったマスタ／案件だけを書く ──
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      const actor: Actor = { uid: user.uid, displayName: user.displayName ?? user.email ?? '不明' };
      const jobs: Promise<void>[] = [];

      for (const key of MASTER_KEYS) {
        if (!ready[key] || syncedMaster.current[key] === data[key]) continue;
        syncedMaster.current[key] = data[key];
        if (!masterAt.current[key]) masterAt.current[key] = Date.now();
        jobs.push(saveMaster(key, data[key], masterAt.current[key], actor));
      }
      if (ready.projects) {
        const ids = new Set(data.projects.map((p) => p.id));
        for (const p of data.projects) {
          if (syncedProjects.current.get(p.id) === p) continue;
          syncedProjects.current.set(p.id, p);
          jobs.push(saveProject(p, actor));
        }
        const gone = new Set([...syncedProjects.current.keys()].filter((id) => !ids.has(id)));
        for (const id of pendingDeletes.current) if (!ids.has(id)) gone.add(id);
        pendingDeletes.current.clear();
        for (const id of gone) {
          syncedProjects.current.delete(id);
          jobs.push(deleteProject(id));
        }
      }
      if (jobs.length === 0) return;
      setSyncState('saving');
      Promise.all(jobs).then(() => setSyncState('saved')).catch(() => setSyncState('error'));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [data, user, ready]);

  return { data, syncState, setMaster, addProject, updateProject, removeProject, replaceAll };
}
