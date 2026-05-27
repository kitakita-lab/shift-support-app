import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

// Firestore パス: users/{uid}/appData/{key}
// db が null（Firebase 未設定）の場合は何もしない
async function saveDoc<T>(uid: string, key: string, items: T[]): Promise<void> {
  if (!db) return;
  await setDoc(doc(db, 'users', uid, 'appData', key), { items, updatedAt: Date.now() });
}

export const firestoreService = {
  saveStaff:       (uid: string, items: Staff[])           => saveDoc(uid, 'staff',       items),
  saveWorkSites:   (uid: string, items: WorkSite[])        => saveDoc(uid, 'workSites',   items),
  saveAssignments: (uid: string, items: ShiftAssignment[]) => saveDoc(uid, 'assignments', items),
  saveImportLogs:  (uid: string, items: ImportLog[])       => saveDoc(uid, 'importLogs',  items),
};
