import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { startPresenceHeartbeat, subscribePresence, PresenceUser } from '../services/presenceService';
import { subscribeLastActivity, DocMeta } from '../services/firestoreService';

export interface CollaborativePresenceResult {
  onlineUsers:  PresenceUser[];
  lastActivity: DocMeta | null;
}

/**
 * Presence heartbeat + オンラインユーザー一覧 + 最終更新情報を管理する hook。
 * ログアウト時に全状態をリセットする。
 */
export function useCollaborativePresence(): CollaborativePresenceResult {
  const { user } = useAuth();

  const [onlineUsers,  setOnlineUsers]  = useState<PresenceUser[]>([]);
  const [lastActivity, setLastActivity] = useState<DocMeta | null>(null);

  useEffect(() => {
    if (!user) {
      setOnlineUsers([]);
      setLastActivity(null);
      return;
    }

    const stopHeartbeat     = startPresenceHeartbeat({
      uid:         user.uid,
      displayName: user.displayName,
      photoURL:    user.photoURL,
    });
    const unsubPresence     = subscribePresence(setOnlineUsers);
    const unsubLastActivity = subscribeLastActivity(setLastActivity);

    return () => {
      stopHeartbeat();
      unsubPresence();
      unsubLastActivity();
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  return { onlineUsers, lastActivity };
}
