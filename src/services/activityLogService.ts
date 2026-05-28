import { collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { TEAM_ID } from './firestoreService';

export type ActivityAction =
  | 'shift_generate'
  | 'shift_clear'
  | 'staff_add'
  | 'staff_delete'
  | 'worksite_add'
  | 'worksite_delete'
  | 'import';

export const ACTION_LABELS: Record<ActivityAction, string> = {
  shift_generate:  'シフト自動作成',
  shift_clear:     'シフトクリア',
  staff_add:       'スタッフ追加',
  staff_delete:    'スタッフ削除',
  worksite_add:    '現場追加',
  worksite_delete: '現場削除',
  import:          'CSVインポート',
};

export interface ActivityLog {
  id?: string;
  action: ActivityAction;
  actorUid: string;
  actorName: string;
  timestamp: number;
  details?: string;
}

function activityCol() {
  return collection(db!, 'teams', TEAM_ID, 'activityLogs');
}

export function logActivity(
  actor: { uid: string; name: string },
  action: ActivityAction,
  details?: string,
): void {
  if (!db) return;
  addDoc(activityCol(), {
    action,
    actorUid:  actor.uid,
    actorName: actor.name,
    details:   details ?? '',
    timestamp: Date.now(),
  }).catch(() => {});
}

/** 直近 20 件のアクティビティをリアルタイム購読する。 */
export function subscribeActivityLogs(
  onChange: (logs: ActivityLog[]) => void,
): () => void {
  if (!db) return () => {};

  const q = query(activityCol(), orderBy('timestamp', 'desc'), limit(20));
  return onSnapshot(
    q,
    (snap) => {
      const logs = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ActivityLog, 'id'>),
      }));
      onChange(logs);
    },
    () => {},
  );
}
