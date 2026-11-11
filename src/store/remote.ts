// Firestore 入出力。旧アプリ（archive/shift-app-v1）の方式を引き継ぎつつ、案件だけ 1案件=1ドキュメントに分割。
//
//   teams/{TEAM_ID}/workshopData/{staff|venues|contents|partTypes|composites}  … { items[], updatedAt, updatedBy }
//   teams/{TEAM_ID}/workshopProjects/{projectId}                               … Project そのもの + updatedBy
//
// 旧アプリのデータ（teams/{TEAM_ID}/appData/*）には一切触れない。
// 既存の firestore.rules（teams/intention-dev/** をログイン済みユーザーに許可）の範囲内なので、ルールのデプロイは不要。
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { AppData, Project } from '../types';

export const TEAM_ID = 'intention-dev';
export type MasterKey = Exclude<keyof AppData, 'projects'>;
export const MASTER_KEYS: MasterKey[] = ['staff', 'venues', 'contents', 'partTypes', 'composites'];

export interface Actor { uid: string; displayName: string }
type Unsub = () => void;

/** Firestore は undefined を保存できないため取り除く */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function subscribeMaster<K extends MasterKey>(
  key: K,
  onData: (items: AppData[K], updatedAt: number) => void,
  onFirst: () => void,
): Unsub {
  if (!db) { onFirst(); return () => {}; }
  let first = true;
  const done = () => { if (first) { first = false; onFirst(); } };
  return onSnapshot(
    doc(db, 'teams', TEAM_ID, 'workshopData', key),
    (snap) => {
      // 自分の書き込みのローカルエコーは無視（旧アプリと同じ）
      if (snap.metadata.hasPendingWrites) return;
      if (snap.exists()) onData((snap.data().items ?? []) as AppData[K], Number(snap.data().updatedAt) || 0);
      done();
    },
    (err) => { console.debug(`[FS] error(${key}):`, err.code); done(); },
  );
}

export function saveMaster<K extends MasterKey>(
  key: K, items: AppData[K], updatedAt: number, actor: Actor | null,
): Promise<void> {
  if (!db) return Promise.resolve();
  return setDoc(doc(db, 'teams', TEAM_ID, 'workshopData', key), clean({ items, updatedAt, updatedBy: actor }));
}

export function subscribeProjects(onData: (items: Project[]) => void, onFirst: () => void): Unsub {
  if (!db) { onFirst(); return () => {}; }
  let first = true;
  const done = () => { if (first) { first = false; onFirst(); } };
  return onSnapshot(
    collection(db, 'teams', TEAM_ID, 'workshopProjects'),
    (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      onData(snap.docs.map((d) => d.data() as Project));
      done();
    },
    (err) => { console.debug('[FS] error(projects):', err.code); done(); },
  );
}

export function saveProject(p: Project, actor: Actor | null): Promise<void> {
  if (!db) return Promise.resolve();
  return setDoc(doc(db, 'teams', TEAM_ID, 'workshopProjects', p.id), clean({ ...p, updatedBy: actor }));
}

export function deleteProject(id: string): Promise<void> {
  if (!db) return Promise.resolve();
  return deleteDoc(doc(db, 'teams', TEAM_ID, 'workshopProjects', id));
}
