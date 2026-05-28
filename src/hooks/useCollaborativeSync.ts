import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';
import { storage, hydrateWorkSite } from '../utils/storage';
import { useAuth } from '../contexts/AuthContext';
import {
  firestoreService,
  setCurrentUser,
  subscribeLastActivity,
  DocMeta,
} from '../services/firestoreService';
import { startPresenceHeartbeat, subscribePresence, PresenceUser } from '../services/presenceService';
import { subscribeActivityLogs, ActivityLog } from '../services/activityLogService';
import { subscribeEditingStates, EditingState } from '../services/editingService';

export type SyncState = 'idle' | 'saving' | 'saved' | 'error';

type ReadyFlags = { staff: boolean; workSites: boolean; assignments: boolean; importLogs: boolean };
const READY_FALSE: ReadyFlags = { staff: false, workSites: false, assignments: false, importLogs: false };

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
 * アプリデータの Firestore リアルタイム同期・ローカル保存・共同編集メタデータを一括管理する hook。
 * - subscribe/save/wrapSave/firestoreReady の実装詳細を App.tsx から隠蔽する。
 * - setStaff 等のセッターを通じて App.tsx がデータを変更すると、save effect が自動的に Firestore へ書き込む。
 */
export function useCollaborativeSync(): CollaborativeSyncResult {
  const { user } = useAuth();

  // ── データ state（localStorage で初期化、Firestore と同期）
  const [staff,       setStaff]       = useState<Staff[]>(() => storage.loadStaff());
  const [workSites,   setWorkSites]   = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());
  const [importLogs,  setImportLogs]  = useState<ImportLog[]>(() => storage.loadImportLogs());

  // ── 共同編集メタデータ
  const [syncState,     setSyncState]     = useState<SyncState>('idle');
  const [lastActivity,  setLastActivity]  = useState<DocMeta | null>(null);
  const [onlineUsers,   setOnlineUsers]   = useState<PresenceUser[]>([]);
  const [activityLogs,  setActivityLogs]  = useState<ActivityLog[]>([]);
  const [editingStates, setEditingStates] = useState<EditingState[]>([]);

  // 初回 snapshot 到着まで save をブロック（ログイン直後の上書き防止）
  const [firestoreReady, setFirestoreReady] = useState<ReadyFlags>(READY_FALSE);

  // Firestore → setState 直後の書き戻しをスキップするフラグ
  const fromFirestore = useRef({ staff: false, workSites: false, assignments: false, importLogs: false });
  const syncTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // updatedBy を firestoreService へ注入
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

  // ── Firestore subscribe（認証状態が変わるたびに再接続）
  useEffect(() => {
    if (!user) {
      setFirestoreReady(READY_FALSE);
      setOnlineUsers([]);
      setActivityLogs([]);
      setLastActivity(null);
      setEditingStates([]);
      return;
    }
    console.debug('[sync] subscribe start — uid:', user.uid);

    const unsubStaff = firestoreService.subscribeStaff(
      (items) => {
        console.debug('[sync] ← staff count:', items.length);
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
      () => {
        console.debug('[sync] staff ready');
        setFirestoreReady((prev) => ({ ...prev, staff: true }));
      },
    );

    const unsubWorkSites = firestoreService.subscribeWorkSites(
      (items) => {
        console.debug('[sync] ← workSites count:', items.length);
        fromFirestore.current.workSites = true;
        setWorkSites(items.map((s) => hydrateWorkSite(s as Partial<WorkSite>)));
      },
      () => {
        console.debug('[sync] workSites ready');
        setFirestoreReady((prev) => ({ ...prev, workSites: true }));
      },
    );

    const unsubAssignments = firestoreService.subscribeAssignments(
      (items) => {
        console.debug('[sync] ← assignments count:', items.length);
        fromFirestore.current.assignments = true;
        setAssignments(items.map((a) => ({ ...a, assignedStaffIds: a.assignedStaffIds ?? [] })));
      },
      () => {
        console.debug('[sync] assignments ready');
        setFirestoreReady((prev) => ({ ...prev, assignments: true }));
      },
    );

    const unsubImportLogs = firestoreService.subscribeImportLogs(
      (items) => {
        console.debug('[sync] ← importLogs count:', items.length);
        fromFirestore.current.importLogs = true;
        setImportLogs(items);
      },
      () => {
        console.debug('[sync] importLogs ready');
        setFirestoreReady((prev) => ({ ...prev, importLogs: true }));
      },
    );

    const unsubLastActivity = subscribeLastActivity(setLastActivity);

    const stopHeartbeat = startPresenceHeartbeat({
      uid:         user.uid,
      displayName: user.displayName,
      photoURL:    user.photoURL,
    });
    const unsubPresence = subscribePresence(setOnlineUsers);
    const unsubActivity = subscribeActivityLogs(setActivityLogs);
    const unsubEditing  = subscribeEditingStates(setEditingStates);

    return () => {
      console.debug('[sync] unsubscribe');
      unsubStaff();
      unsubWorkSites();
      unsubAssignments();
      unsubImportLogs();
      unsubLastActivity();
      stopHeartbeat();
      unsubPresence();
      unsubActivity();
      unsubEditing();
      fromFirestore.current = { staff: false, workSites: false, assignments: false, importLogs: false };
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── save effects（state 変化 → localStorage + Firestore）
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
    lastActivity,
    onlineUsers,
    activityLogs,
    editingStates,
  };
}
