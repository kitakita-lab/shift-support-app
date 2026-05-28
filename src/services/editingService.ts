import { doc, setDoc, deleteDoc, collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { TEAM_ID } from './firestoreService';

export type EditingType = 'staff' | 'worksite';

export interface EditingState {
  type: EditingType;
  targetId: string;
  targetName: string;
  userId: string;
  userName: string;
  updatedAt: number;
}

const HEARTBEAT_MS       = 10_000;
const EDITING_TIMEOUT_MS = 30_000;

function editingDoc(type: EditingType, targetId: string) {
  return doc(db!, 'teams', TEAM_ID, 'editingStates', `${type}_${targetId}`);
}

/** 編集開始。返り値はクリーンアップ関数（フォームを閉じた時に呼ぶ）。 */
export function startEditing(
  user: { uid: string; displayName: string },
  type: EditingType,
  targetId: string,
  targetName: string,
): () => void {
  if (!db) return () => {};

  const write = () => {
    setDoc(editingDoc(type, targetId), {
      type,
      targetId,
      targetName,
      userId:    user.uid,
      userName:  user.displayName,
      updatedAt: Date.now(),
    }).catch(() => {});
  };

  write();
  const id = window.setInterval(write, HEARTBEAT_MS);

  return () => {
    window.clearInterval(id);
    deleteDoc(editingDoc(type, targetId)).catch(() => {});
  };
}

/** editingStates コレクションをリアルタイム購読し、30 秒以内の編集状態一覧を返す。 */
export function subscribeEditingStates(
  onChange: (states: EditingState[]) => void,
): () => void {
  if (!db) return () => {};

  const col = collection(db, 'teams', TEAM_ID, 'editingStates');
  return onSnapshot(
    col,
    (snap) => {
      const now    = Date.now();
      const active = snap.docs
        .map((d) => d.data() as EditingState)
        .filter((e) => typeof e.updatedAt === 'number' && now - e.updatedAt < EDITING_TIMEOUT_MS);
      onChange(active);
    },
    () => {},
  );
}
