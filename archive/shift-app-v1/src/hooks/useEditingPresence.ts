import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { startEditing, EditingType } from '../services/editingService';

interface UseEditingPresenceProps {
  type:       EditingType;
  targetId:   string | null;
  targetName: string;
  enabled:    boolean;
}

export interface UseEditingPresenceResult {
  /** 編集フォームを開いた時刻（ms）。保存競合検知に使用。フォームを閉じると null に戻る。 */
  editingStartedAt: number | null;
}

/**
 * 編集フォームが開いている間、Firestore editingStates に heartbeat を書き込む。
 * フォームを閉じる（enabled=false or targetId=null）と doc を削除する。
 * コンポーネントアンマウント時にも自動クリーンアップされる。
 * editingStartedAt は保存競合警告（Phase2）で使用する。
 */
export function useEditingPresence({
  type, targetId, targetName, enabled,
}: UseEditingPresenceProps): UseEditingPresenceResult {
  const { user } = useAuth();
  const stopRef  = useRef<(() => void) | null>(null);
  const [editingStartedAt, setEditingStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (enabled && targetId && user) {
      setEditingStartedAt(Date.now());
      stopRef.current?.();
      stopRef.current = startEditing(
        { uid: user.uid, displayName: user.displayName ?? user.email ?? '不明' },
        type, targetId, targetName,
      );
    } else {
      setEditingStartedAt(null);
      stopRef.current?.();
      stopRef.current = null;
    }
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [enabled, targetId, type, user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  return { editingStartedAt };
}
