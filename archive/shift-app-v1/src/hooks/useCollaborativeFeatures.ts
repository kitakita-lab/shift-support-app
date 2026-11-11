import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { subscribeActivityLogs, ActivityLog } from '../services/activityLogService';
import { subscribeEditingStates, EditingState } from '../services/editingService';

export interface CollaborativeFeaturesResult {
  activityLogs:  ActivityLog[];
  editingStates: EditingState[];
}

/**
 * アクティビティログ・編集中状態をリアルタイム購読する hook。
 * ログアウト時に全状態をリセットする。
 */
export function useCollaborativeFeatures(): CollaborativeFeaturesResult {
  const { user } = useAuth();

  const [activityLogs,  setActivityLogs]  = useState<ActivityLog[]>([]);
  const [editingStates, setEditingStates] = useState<EditingState[]>([]);

  useEffect(() => {
    if (!user) {
      setActivityLogs([]);
      setEditingStates([]);
      return;
    }

    const unsubActivity = subscribeActivityLogs(setActivityLogs);
    const unsubEditing  = subscribeEditingStates(setEditingStates);

    return () => {
      unsubActivity();
      unsubEditing();
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  return { activityLogs, editingStates };
}
