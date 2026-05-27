import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

type Unsubscribe = () => void;

// Firestore パス: users/{uid}/appData/{key}
function saveDoc<T>(uid: string, key: string, items: T[]): Promise<void> {
  if (!db) return Promise.resolve();
  return setDoc(doc(db, 'users', uid, 'appData', key), { items, updatedAt: Date.now() });
}

function subscribeDoc<T>(
  uid: string,
  key: string,
  onData: (items: T[]) => void,
): Unsubscribe {
  if (!db) return () => {};
  return onSnapshot(
    doc(db, 'users', uid, 'appData', key),
    (snap) => {
      if (snap.exists()) onData((snap.data().items ?? []) as T[]);
    },
    () => {},
  );
}

export const firestoreService = {
  // リアルタイム購読（ログイン中の全端末で同期）
  subscribeStaff: (uid: string, cb: (items: Staff[]) => void): Unsubscribe =>
    subscribeDoc<Staff>(uid, 'staff', cb),

  subscribeWorkSites: (uid: string, cb: (items: WorkSite[]) => void): Unsubscribe =>
    subscribeDoc<WorkSite>(uid, 'workSites', cb),

  // 書き込み
  saveStaff:       (uid: string, items: Staff[]): Promise<void>           => saveDoc(uid, 'staff',       items),
  saveWorkSites:   (uid: string, items: WorkSite[]): Promise<void>        => saveDoc(uid, 'workSites',   items),
  saveAssignments: (uid: string, items: ShiftAssignment[]): Promise<void> => saveDoc(uid, 'assignments', items),
  saveImportLogs:  (uid: string, items: ImportLog[]): Promise<void>       => saveDoc(uid, 'importLogs',  items),
};
