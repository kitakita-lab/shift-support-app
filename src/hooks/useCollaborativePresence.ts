import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { startPresenceHeartbeat, subscribePresence, PresenceUser } from '../services/presenceService';

export interface CollaborativePresenceResult {
  onlineUsers: PresenceUser[];
}

/**
 * Presence heartbeat + オンラインユーザー一覧を管理する hook。
 * ログアウト時に全状態をリセットする。
 *
 * 「最終更新」情報（lastActivity）は useFirestoreSync が onMeta 経由で提供する
 * （以前はここで subscribeLastActivity を購読していたが、リスナー重複のため統合した）。
 */
export function useCollaborativePresence(): CollaborativePresenceResult {
  const { user } = useAuth();

  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    if (!user) {
      setOnlineUsers([]);
      return;
    }

    const stopHeartbeat = startPresenceHeartbeat({
      uid:         user.uid,
      displayName: user.displayName,
      photoURL:    user.photoURL,
    });
    const unsubPresence = subscribePresence(setOnlineUsers);

    return () => {
      stopHeartbeat();
      unsubPresence();
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  return { onlineUsers };
}
