import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

// Firestore パス: users/{uid}/appData/{key}
const appDataDoc = (uid: string, key: string) =>
  doc(db, 'users', uid, 'appData', key);

// 共通: setDoc でまるごと上書き。失敗は呼び出し側で .catch(() => {}) により無視する
async function saveDoc<T>(uid: string, key: string, items: T[]): Promise<void> {
  await setDoc(appDataDoc(uid, key), { items, updatedAt: Date.now() });
}

export const firestoreService = {
  saveStaff:       (uid: string, items: Staff[])           => saveDoc(uid, 'staff',       items),
  saveWorkSites:   (uid: string, items: WorkSite[])        => saveDoc(uid, 'workSites',   items),
  saveAssignments: (uid: string, items: ShiftAssignment[]) => saveDoc(uid, 'assignments', items),
  saveImportLogs:  (uid: string, items: ImportLog[])       => saveDoc(uid, 'importLogs',  items),
};
