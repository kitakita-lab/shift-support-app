import { doc, setDoc, deleteDoc, collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { TEAM_ID } from './firestoreService';

export interface PresenceUser {
  uid: string;
  displayName: string;
  photoURL: string | null;
  lastSeen: number;
}

// heartbeat 10s / online threshold 35s（3 missed beats で offline 扱い）
const HEARTBEAT_MS  = 10_000;
const ONLINE_THR_MS = 35_000;

function presenceDoc(uid: string) {
  return doc(db!, 'teams', TEAM_ID, 'presence', uid);
}

/** ログイン時に呼ぶ。返り値はクリーンアップ関数。 */
export function startPresenceHeartbeat(
  user: { uid: string; displayName: string | null; photoURL: string | null },
): () => void {
  if (!db) return () => {};

  const write = () => {
    setDoc(presenceDoc(user.uid), {
      uid:         user.uid,
      displayName: user.displayName ?? 'ユーザー',
      photoURL:    user.photoURL    ?? null,
      lastSeen:    Date.now(),
    }).catch(() => {});
  };

  write();
  const id = window.setInterval(write, HEARTBEAT_MS);

  return () => {
    window.clearInterval(id);
    deleteDoc(presenceDoc(user.uid)).catch(() => {});
  };
}

/** presence コレクションをリアルタイム購読し、オンラインユーザー一覧を返す。 */
export function subscribePresence(
  onChange: (users: PresenceUser[]) => void,
): () => void {
  if (!db) return () => {};

  const col = collection(db, 'teams', TEAM_ID, 'presence');
  return onSnapshot(
    col,
    (snap) => {
      const now    = Date.now();
      const online = snap.docs
        .map((d) => d.data() as PresenceUser)
        .filter((u) => typeof u.lastSeen === 'number' && now - u.lastSeen < ONLINE_THR_MS);
      onChange(online);
    },
    () => {},
  );
}
