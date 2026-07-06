import { doc, setDoc, deleteDoc, collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { TEAM_ID } from './firestoreService';

export interface PresenceUser {
  uid: string;
  displayName: string;
  photoURL: string | null;
  lastSeen: number;
}

// heartbeat 30s / online threshold 95s（3 missed beats + 5s マージンで offline 扱い）
// 30s × 3人 × 8h ≒ 2,880 writes/日。10s だと 8,640/日で無料枠(20k/日)の 43% を占めるため 30s とする。
// 変更する場合は ONLINE_THR_MS = HEARTBEAT_MS × 3 + 5s の比率を維持すること。
const HEARTBEAT_MS  = 30_000;
const ONLINE_THR_MS = 95_000;

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
