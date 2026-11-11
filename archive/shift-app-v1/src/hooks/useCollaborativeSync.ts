import { Dispatch, SetStateAction } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';
import { DocMeta } from '../services/firestoreService';
import { PresenceUser } from '../services/presenceService';
import { ActivityLog } from '../services/activityLogService';
import { EditingState } from '../services/editingService';
import { useFirestoreSync, SyncState } from './useFirestoreSync';
import { useCollaborativePresence } from './useCollaborativePresence';
import { useCollaborativeFeatures } from './useCollaborativeFeatures';

export type { SyncState };

export interface CollaborativeSyncResult {
  staff:          Staff[];
  setStaff:       Dispatch<SetStateAction<Staff[]>>;
  workSites:      WorkSite[];
  setWorkSites:   Dispatch<SetStateAction<WorkSite[]>>;
  assignments:    ShiftAssignment[];
  setAssignments: Dispatch<SetStateAction<ShiftAssignment[]>>;
  importLogs:     ImportLog[];
  setImportLogs:  Dispatch<SetStateAction<ImportLog[]>>;
  syncState:      SyncState;
  lastActivity:   DocMeta | null;
  onlineUsers:    PresenceUser[];
  activityLogs:   ActivityLog[];
  editingStates:  EditingState[];
}

/**
 * useFirestoreSync / useCollaborativePresence / useCollaborativeFeatures
 * を束ねた後方互換ファサード。
 * App.tsx は直接 3 つの hooks を呼ぶことを推奨。
 */
export function useCollaborativeSync(): CollaborativeSyncResult {
  const firestore    = useFirestoreSync();
  const presence     = useCollaborativePresence();
  const features     = useCollaborativeFeatures();

  return {
    staff:          firestore.staff,
    setStaff:       firestore.setStaff,
    workSites:      firestore.workSites,
    setWorkSites:   firestore.setWorkSites,
    assignments:    firestore.assignments,
    setAssignments: firestore.setAssignments,
    importLogs:     firestore.importLogs,
    setImportLogs:  firestore.setImportLogs,
    syncState:      firestore.syncState,
    lastActivity:   firestore.lastActivity,
    onlineUsers:    presence.onlineUsers,
    activityLogs:   features.activityLogs,
    editingStates:  features.editingStates,
  };
}
