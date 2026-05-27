import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

type Unsubscribe = () => void;

// 全ログインユーザーが共有する固定チームID（将来は動的化可能）
export const TEAM_ID = 'intention-dev';

// Firestore パス: teams/{teamId}/appData/{key}
function teamDoc(key: string) {
  return doc(db!, 'teams', TEAM_ID, 'appData', key);
}

function save<T>(key: string, items: T[]): Promise<void> {
  if (!db) return Promise.resolve();
  return setDoc(teamDoc(key), { items, updatedAt: Date.now() });
}

function subscribe<T>(key: string, onData: (items: T[]) => void): Unsubscribe {
  if (!db) return () => {};
  return onSnapshot(
    teamDoc(key),
    (snap) => {
      if (snap.exists()) onData((snap.data().items ?? []) as T[]);
    },
    () => {},
  );
}

export const firestoreService = {
  // リアルタイム購読（ログイン中の全端末で同期）
  subscribeStaff:    (cb: (items: Staff[]) => void): Unsubscribe    => subscribe<Staff>('staff', cb),
  subscribeWorkSites:(cb: (items: WorkSite[]) => void): Unsubscribe => subscribe<WorkSite>('workSites', cb),

  // 書き込み
  saveStaff:       (items: Staff[]): Promise<void>           => save('staff',       items),
  saveWorkSites:   (items: WorkSite[]): Promise<void>        => save('workSites',   items),
  saveAssignments: (items: ShiftAssignment[]): Promise<void> => save('assignments', items),
  saveImportLogs:  (items: ImportLog[]): Promise<void>       => save('importLogs',  items),
};
