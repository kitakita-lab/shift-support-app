import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';
import { storage, hydrateWorkSite } from '../utils/storage';
import { useAuth } from '../contexts/AuthContext';
import { firestoreService, setCurrentUser } from '../services/firestoreService';

export type SyncState = 'idle' | 'saving' | 'saved' | 'error';

type ReadyFlags = { staff: boolean; workSites: boolean; assignments: boolean; importLogs: boolean };
const READY_FALSE: ReadyFlags = { staff: false, workSites: false, assignments: false, importLogs: false };

/** 各データキーの最新 Firestore updatedAt（他ユーザーの保存検知に使用） */
export interface ServerUpdatedAt {
  staff:       number;
  workSites:   number;
  assignments: number;
  importLogs:  number;
}

export interface FirestoreSyncResult {
  staff:           Staff[];
  setStaff:        Dispatch<SetStateAction<Staff[]>>;
  workSites:       WorkSite[];
  setWorkSites:    Dispatch<SetStateAction<WorkSite[]>>;
  assignments:     ShiftAssignment[];
  setAssignments:  Dispatch<SetStateAction<ShiftAssignment[]>>;
  importLogs:      ImportLog[];
  setImportLogs:   Dispatch<SetStateAction<ImportLog[]>>;
  syncState:       SyncState;
  serverUpdatedAt: ServerUpdatedAt;
}

/**
 * Firestore のリアルタイム同期・localStorage 二重書き・保存状態管理を担う hook。
 * - 初回 snapshot 到着まで書き込みをブロック（ログイン直後の上書き防止）
 * - serverUpdatedAt で他ユーザーの保存を検知可能
 */
export function useFirestoreSync(): FirestoreSyncResult {
  const { user } = useAuth();

  const [staff,       setStaff]       = useState<Staff[]>(() => storage.loadStaff());
  const [workSites,   setWorkSites]   = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());
  const [importLogs,  setImportLogs]  = useState<ImportLog[]>(() => storage.loadImportLogs());

  const [syncState,       setSyncState]       = useState<SyncState>('idle');
  const [firestoreReady,  setFirestoreReady]  = useState<ReadyFlags>(READY_FALSE);
  const [serverUpdatedAt, setServerUpdatedAt] = useState<ServerUpdatedAt>({
    staff: 0, workSites: 0, assignments: 0, importLogs: 0,
  });

  const fromFirestore = useRef({ staff: false, workSites: false, assignments: false, importLogs: false });
  const syncTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCurrentUser(
      user
        ? { uid: user.uid, displayName: user.displayName ?? user.email ?? '不明' }
        : null,
    );
  }, [user]);

  function wrapSave(promise: Promise<void>): void {
    setSyncState('saving');
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    promise
      .then(() => {
        setSyncState('saved');
        syncTimerRef.current = setTimeout(() => setSyncState('idle'), 2000);
      })
      .catch(() => setSyncState('error'));
  }

  useEffect(() => {
    if (!user) {
      setFirestoreReady(READY_FALSE);
      return;
    }

    const unsubStaff = firestoreService.subscribeStaff(
      (items) => {
        fromFirestore.current.staff = true;
        setStaff(items.map((s) => ({
          ...s,
          staffNo:            s.staffNo            ?? '',
          availableWeekdays:  s.availableWeekdays  ?? [],
          requestedDaysOff:   s.requestedDaysOff   ?? [],
          maxWorkDays:        s.maxWorkDays         ?? 20,
          maxConsecutiveDays: s.maxConsecutiveDays  ?? 5,
          memo:               s.memo               ?? '',
          preferredWorkSites: s.preferredWorkSites  ?? [],
          ngPartnerIds:       s.ngPartnerIds        ?? [],
        })));
      },
      () => setFirestoreReady((prev) => ({ ...prev, staff: true })),
      (updatedAt) => setServerUpdatedAt((prev) => ({ ...prev, staff: updatedAt })),
    );

    const unsubWorkSites = firestoreService.subscribeWorkSites(
      (items) => {
        fromFirestore.current.workSites = true;
        setWorkSites(items.map((s) => hydrateWorkSite(s as Partial<WorkSite>)));
      },
      () => setFirestoreReady((prev) => ({ ...prev, workSites: true })),
      (updatedAt) => setServerUpdatedAt((prev) => ({ ...prev, workSites: updatedAt })),
    );

    const unsubAssignments = firestoreService.subscribeAssignments(
      (items) => {
        fromFirestore.current.assignments = true;
        setAssignments(items.map((a) => ({ ...a, assignedStaffIds: a.assignedStaffIds ?? [] })));
      },
      () => setFirestoreReady((prev) => ({ ...prev, assignments: true })),
      (updatedAt) => setServerUpdatedAt((prev) => ({ ...prev, assignments: updatedAt })),
    );

    const unsubImportLogs = firestoreService.subscribeImportLogs(
      (items) => {
        fromFirestore.current.importLogs = true;
        setImportLogs(items);
      },
      () => setFirestoreReady((prev) => ({ ...prev, importLogs: true })),
      (updatedAt) => setServerUpdatedAt((prev) => ({ ...prev, importLogs: updatedAt })),
    );

    return () => {
      unsubStaff();
      unsubWorkSites();
      unsubAssignments();
      unsubImportLogs();
      fromFirestore.current = { staff: false, workSites: false, assignments: false, importLogs: false };
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    storage.saveStaff(staff);
    if (!user || !firestoreReady.staff) return;
    if (fromFirestore.current.staff) { fromFirestore.current.staff = false; return; }
    wrapSave(firestoreService.saveStaff(staff));
  }, [staff, user, firestoreReady.staff]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    storage.saveWorkSites(workSites);
    if (!user || !firestoreReady.workSites) return;
    if (fromFirestore.current.workSites) { fromFirestore.current.workSites = false; return; }
    wrapSave(firestoreService.saveWorkSites(workSites));
  }, [workSites, user, firestoreReady.workSites]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    storage.saveAssignments(assignments);
    if (!user || !firestoreReady.assignments) return;
    if (fromFirestore.current.assignments) { fromFirestore.current.assignments = false; return; }
    wrapSave(firestoreService.saveAssignments(assignments));
  }, [assignments, user, firestoreReady.assignments]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    storage.saveImportLogs(importLogs);
    if (!user || !firestoreReady.importLogs) return;
    if (fromFirestore.current.importLogs) { fromFirestore.current.importLogs = false; return; }
    wrapSave(firestoreService.saveImportLogs(importLogs));
  }, [importLogs, user, firestoreReady.importLogs]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    staff, setStaff,
    workSites, setWorkSites,
    assignments, setAssignments,
    importLogs, setImportLogs,
    syncState,
    serverUpdatedAt,
  };
}
