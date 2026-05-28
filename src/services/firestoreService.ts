import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

type Unsubscribe = () => void;

export const TEAM_ID = 'intention-dev';

// Firestore パス: teams/{teamId}/appData/{key}
function teamDoc(key: string) {
  return doc(db!, 'teams', TEAM_ID, 'appData', key);
}

function save<T>(key: string, items: T[]): Promise<void> {
  if (!db) {
    console.debug(`[FS] save(${key}) skip — db=null`);
    return Promise.resolve();
  }
  console.debug(`[FS] write teams/${TEAM_ID}/appData/${key} count=${(items as unknown[]).length}`);
  return setDoc(teamDoc(key), { items, updatedAt: Date.now() });
}

/**
 * @param onFirstSnapshot ドキュメントの有無に関わらず初回 snapshot 到着時に 1 度だけ呼ばれる。
 *   これが呼ばれるまでは書き込みをブロックすることで、ログイン直後の上書きを防ぐ。
 */
function subscribe<T>(
  key: string,
  onData: (items: T[]) => void,
  onFirstSnapshot: () => void,
): Unsubscribe {
  if (!db) {
    console.debug(`[FS] subscribe(${key}) skip — db=null`);
    onFirstSnapshot();
    return () => {};
  }
  console.debug(`[FS] subscribe start — teams/${TEAM_ID}/appData/${key}`);
  let isFirst = true;

  return onSnapshot(
    teamDoc(key),
    (snap) => {
      console.debug(
        `[FS] snapshot(${key}) exists=${snap.exists()} pending=${snap.metadata.hasPendingWrites}`,
      );
      // 自端末の書き込みによるローカルキャッシュ通知はスキップ（server 確認済みのみ処理）
      if (snap.metadata.hasPendingWrites) return;

      if (isFirst) { isFirst = false; onFirstSnapshot(); }
      if (snap.exists()) onData((snap.data().items ?? []) as T[]);
    },
    (err) => {
      console.debug(`[FS] error(${key}):`, err.code, err.message);
      if (isFirst) { isFirst = false; onFirstSnapshot(); }
    },
  );
}

export const firestoreService = {
  subscribeStaff: (
    cb: (items: Staff[]) => void,
    onFirst: () => void,
  ): Unsubscribe => subscribe<Staff>('staff', cb, onFirst),

  subscribeWorkSites: (
    cb: (items: WorkSite[]) => void,
    onFirst: () => void,
  ): Unsubscribe => subscribe<WorkSite>('workSites', cb, onFirst),

  subscribeAssignments: (
    cb: (items: ShiftAssignment[]) => void,
    onFirst: () => void,
  ): Unsubscribe => subscribe<ShiftAssignment>('assignments', cb, onFirst),

  subscribeImportLogs: (
    cb: (items: ImportLog[]) => void,
    onFirst: () => void,
  ): Unsubscribe => subscribe<ImportLog>('importLogs', cb, onFirst),

  saveStaff:       (items: Staff[]): Promise<void>           => save('staff',       items),
  saveWorkSites:   (items: WorkSite[]): Promise<void>        => save('workSites',   items),
  saveAssignments: (items: ShiftAssignment[]): Promise<void> => save('assignments', items),
  saveImportLogs:  (items: ImportLog[]): Promise<void>       => save('importLogs',  items),
};
