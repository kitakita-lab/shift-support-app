import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { startEditing, EditingType } from '../services/editingService';

interface UseEditingPresenceProps {
  type:       EditingType;
  targetId:   string | null;
  targetName: string;
  enabled:    boolean;
}

/**
 * 編集フォームが開いている間、Firestore editingStates に heartbeat を書き込む。
 * フォームを閉じる（enabled=false or targetId=null）と doc を削除する。
 * コンポーネントアンマウント時にも自動クリーンアップされる。
 */
export function useEditingPresence({ type, targetId, targetName, enabled }: UseEditingPresenceProps): void {
  const { user } = useAuth();
  const stopRef  = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (enabled && targetId && user) {
      stopRef.current?.();
      stopRef.current = startEditing(
        { uid: user.uid, displayName: user.displayName ?? user.email ?? '不明' },
        type, targetId, targetName,
      );
    } else {
      stopRef.current?.();
      stopRef.current = null;
    }
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [enabled, targetId, type, user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps
}
