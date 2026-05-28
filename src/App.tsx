import { useState, useEffect, useRef, useMemo } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from './types';
import { storage, hydrateWorkSite } from './utils/storage';
import Dashboard from './components/Dashboard';
import StaffManager from './components/StaffManager';
import WorkSiteManager from './components/WorkSiteManager';
import ShiftBuilder from './components/ShiftBuilder';
import ExportPanel from './components/ExportPanel';
import CsvImporter from './components/CsvImporter';
import AuthButton from './components/AuthButton';
import { useAuth } from './contexts/AuthContext';
import { firestoreService, setCurrentUser, subscribeLastActivity, DocMeta } from './services/firestoreService';
import { startPresenceHeartbeat, subscribePresence, PresenceUser } from './services/presenceService';
import { logActivity, subscribeActivityLogs, ActivityLog } from './services/activityLogService';
import './styles/App.css';

type Tab = 'dashboard' | 'staff' | 'worksite' | 'shift' | 'export' | 'import';
type SyncState = 'idle' | 'saving' | 'saved' | 'error';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'ダッシュボード' },
  { id: 'staff',     label: 'スタッフ管理' },
  { id: 'worksite',  label: '現場管理' },
  { id: 'shift',     label: 'シフト作成' },
  { id: 'export',    label: '出力' },
  { id: 'import',    label: 'インポート' },
];

function toYearMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return toYearMonth(new Date(y, m - 2, 1));
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return toYearMonth(new Date(y, m, 1));
}

/** source が 'manual' でないデータをインポート由来として扱う */
function isImportedSite(s: WorkSite): boolean {
  return s.source === 'csv' || s.source === 'excel';
}

function formatLastActivity(meta: DocMeta): string {
  const d = new Date(meta.updatedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const who  = meta.updatedBy?.displayName ?? '不明';
  return `${date}  ${who}`;
}

export default function App() {
  const [activeTab,   setActiveTab]   = useState<Tab>('dashboard');
  const [staff,       setStaff]       = useState<Staff[]>(() => storage.loadStaff());
  const [workSites,   setWorkSites]   = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());
  const [importLogs,  setImportLogs]  = useState<ImportLog[]>(() => storage.loadImportLogs());

  const [selectedMonth, setSelectedMonth] = useState<string>(() => toYearMonth(new Date()));

  // ── Firestore sync state ──────────────────────────────────────
  const [syncState,     setSyncState]     = useState<SyncState>('idle');
  const [lastActivity,  setLastActivity]  = useState<DocMeta | null>(null);
  const [onlineUsers,   setOnlineUsers]   = useState<PresenceUser[]>([]);
  const [activityLogs,  setActivityLogs]  = useState<ActivityLog[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { user } = useAuth();

  // Firestore からの更新で setState した直後は書き戻しをスキップするフラグ（ref: レンダー不要）
  const fromFirestore = useRef({ staff: false, workSites: false, assignments: false, importLogs: false });
  // 初回 snapshot 到着後のみ書き込みを許可（ログイン直後の localStorage 上書き防止）
  const [firestoreReady, setFirestoreReady] = useState({ staff: false, workSites: false, assignments: false, importLogs: false });

  // ── 保存状態ラッパー ───────────────────────────────────────────
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

  // ── 現在ユーザーを firestoreService に注入 ────────────────────
  useEffect(() => {
    setCurrentUser(
      user
        ? { uid: user.uid, displayName: user.displayName ?? user.email ?? '不明' }
        : null,
    );
  }, [user]);

  // マウント時の localStorage 初期値をログ
  useEffect(() => {
    console.debug(
      '[App] init localStorage —',
      'staff:', storage.loadStaff().length,
      'workSites:', storage.loadWorkSites().length,
    );
  }, []);

  // ── Firestore リアルタイム購読 ────────────────────────────────
  useEffect(() => {
    if (!user) {
      setFirestoreReady({ staff: false, workSites: false, assignments: false, importLogs: false });
      setOnlineUsers([]);
      setActivityLogs([]);
      setLastActivity(null);
      return;
    }
    console.debug('[App] subscribe start — uid:', user.uid);

    // スタッフ
    const unsubStaff = firestoreService.subscribeStaff(
      (items) => {
        console.debug('[App] ← Firestore staff count:', items.length);
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
        console.debug('[App] staff ready');
        setFirestoreReady((prev) => ({ ...prev, staff: true }));
      },
    );

    // 現場
    const unsubWorkSites = firestoreService.subscribeWorkSites(
      (items) => {
        console.debug('[App] ← Firestore workSites count:', items.length);
        fromFirestore.current.workSites = true;
        setWorkSites(items.map((s) => hydrateWorkSite(s as Partial<WorkSite>)));
      },
      () => {
        console.debug('[App] workSites ready');
        setFirestoreReady((prev) => ({ ...prev, workSites: true }));
      },
    );

    // シフト割当
    const unsubAssignments = firestoreService.subscribeAssignments(
      (items) => {
        console.debug('[App] ← Firestore assignments count:', items.length);
        fromFirestore.current.assignments = true;
        setAssignments(items.map((a) => ({ ...a, assignedStaffIds: a.assignedStaffIds ?? [] })));
      },
      () => {
        console.debug('[App] assignments ready');
        setFirestoreReady((prev) => ({ ...prev, assignments: true }));
      },
    );

    // インポートログ
    const unsubImportLogs = firestoreService.subscribeImportLogs(
      (items) => {
        console.debug('[App] ← Firestore importLogs count:', items.length);
        fromFirestore.current.importLogs = true;
        setImportLogs(items);
      },
      () => {
        console.debug('[App] importLogs ready');
        setFirestoreReady((prev) => ({ ...prev, importLogs: true }));
      },
    );

    // 最終更新情報
    const unsubLastActivity = subscribeLastActivity(setLastActivity);

    // Presence（heartbeat + 購読）
    const stopHeartbeat = startPresenceHeartbeat({
      uid:         user.uid,
      displayName: user.displayName,
      photoURL:    user.photoURL,
    });
    const unsubPresence = subscribePresence(setOnlineUsers);

    // アクティビティログ
    const unsubActivityLogs = subscribeActivityLogs(setActivityLogs);

    return () => {
      console.debug('[App] unsubscribe');
      unsubStaff();
      unsubWorkSites();
      unsubAssignments();
      unsubImportLogs();
      unsubLastActivity();
      stopHeartbeat();
      unsubPresence();
      unsubActivityLogs();
      fromFirestore.current = { staff: false, workSites: false, assignments: false, importLogs: false };
    };
  }, [user]);

  // ── セーブエフェクト ──────────────────────────────────────────

  // スタッフ
  useEffect(() => {
    storage.saveStaff(staff);
    if (!user) return;
    if (!firestoreReady.staff) { console.debug('[App] staff save skip — not ready'); return; }
    if (fromFirestore.current.staff) { console.debug('[App] staff save skip — from Firestore'); fromFirestore.current.staff = false; return; }
    console.debug('[App] staff → Firestore write count:', staff.length);
    wrapSave(firestoreService.saveStaff(staff));
  }, [staff, user, firestoreReady.staff]); // eslint-disable-line react-hooks/exhaustive-deps

  // 現場
  useEffect(() => {
    storage.saveWorkSites(workSites);
    if (!user) return;
    if (!firestoreReady.workSites) { console.debug('[App] workSites save skip — not ready'); return; }
    if (fromFirestore.current.workSites) { console.debug('[App] workSites save skip — from Firestore'); fromFirestore.current.workSites = false; return; }
    console.debug('[App] workSites → Firestore write count:', workSites.length);
    wrapSave(firestoreService.saveWorkSites(workSites));
  }, [workSites, user, firestoreReady.workSites]); // eslint-disable-line react-hooks/exhaustive-deps

  // シフト割当
  useEffect(() => {
    storage.saveAssignments(assignments);
    if (!user) return;
    if (!firestoreReady.assignments) { console.debug('[App] assignments save skip — not ready'); return; }
    if (fromFirestore.current.assignments) { console.debug('[App] assignments save skip — from Firestore'); fromFirestore.current.assignments = false; return; }
    console.debug('[App] assignments → Firestore write count:', assignments.length);
    wrapSave(firestoreService.saveAssignments(assignments));
  }, [assignments, user, firestoreReady.assignments]); // eslint-disable-line react-hooks/exhaustive-deps

  // インポートログ
  useEffect(() => {
    storage.saveImportLogs(importLogs);
    if (!user) return;
    if (!firestoreReady.importLogs) { console.debug('[App] importLogs save skip — not ready'); return; }
    if (fromFirestore.current.importLogs) { console.debug('[App] importLogs save skip — from Firestore'); fromFirestore.current.importLogs = false; return; }
    console.debug('[App] importLogs → Firestore write count:', importLogs.length);
    wrapSave(firestoreService.saveImportLogs(importLogs));
  }, [importLogs, user, firestoreReady.importLogs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 計算値 ───────────────────────────────────────────────────

  const monthlyWorkSites = useMemo(
    () => workSites.filter((s) => !s.isPlaceholder && s.date.startsWith(selectedMonth)),
    [workSites, selectedMonth]
  );

  const monthlyAssignments = useMemo(() => {
    const siteIds = new Set(monthlyWorkSites.map((s) => s.id));
    return assignments.filter((a) => siteIds.has(a.siteId));
  }, [monthlyWorkSites, assignments]);

  const hasSites = useMemo(
    () => workSites.some((s) => !s.isPlaceholder),
    [workSites]
  );

  // アクター情報（activityLog 用）
  const actor = user
    ? { uid: user.uid, name: user.displayName ?? user.email ?? '不明' }
    : null;

  // ── イベントハンドラ ─────────────────────────────────────────

  function handleClearAll() {
    storage.clearAll();
    setStaff([]);
    setWorkSites([]);
    setAssignments([]);
    setImportLogs([]);
  }

  function handleAddImportLog(log: ImportLog) {
    setImportLogs((prev) => [...prev, log]);
    if (actor) logActivity(actor, 'import', log.sourceFileName);
  }

  function handleStaffChange(newStaff: Staff[]) {
    // アクティビティログ: 追加/削除の検出
    if (actor) {
      const prevIds = new Set(staff.map((s) => s.id));
      const newIds  = new Set(newStaff.map((s) => s.id));
      newStaff.filter((s) => !prevIds.has(s.id)).forEach((s) =>
        logActivity(actor, 'staff_add', s.name)
      );
      staff.filter((s) => !newIds.has(s.id)).forEach((s) =>
        logActivity(actor, 'staff_delete', s.name)
      );
    }

    const newIds = new Set(newStaff.map((s) => s.id));
    setAssignments((prev) =>
      prev.map((a) => {
        const validStaff   = a.assignedStaffIds.filter((id) => newIds.has(id));
        const removedCount = a.assignedStaffIds.length - validStaff.length;
        return removedCount === 0
          ? a
          : { ...a, assignedStaffIds: validStaff, shortage: a.shortage + removedCount };
      })
    );
    setStaff(newStaff.map((s) => ({
      ...s,
      ngPartnerIds: s.ngPartnerIds?.filter((id) => newIds.has(id)),
    })));
  }

  function handleWorkSiteChange(newSites: WorkSite[]) {
    // アクティビティログ: 会場単位で追加/削除を検出
    if (actor) {
      const prevGroupIds = new Set(
        workSites.filter((s) => !s.isPlaceholder).map((s) => s.groupId ?? s.id)
      );
      const newGroupIds  = new Set(
        newSites.filter((s) => !s.isPlaceholder).map((s) => s.groupId ?? s.id)
      );
      const addedCount   = [...newGroupIds].filter((id) => !prevGroupIds.has(id)).length;
      const deletedCount = [...prevGroupIds].filter((id) => !newGroupIds.has(id)).length;
      if (addedCount   > 0) logActivity(actor, 'worksite_add',    `${addedCount}件`);
      if (deletedCount > 0) logActivity(actor, 'worksite_delete', `${deletedCount}件`);
    }

    const newIds = new Set(newSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => newIds.has(a.siteId)));
    setWorkSites(newSites);
  }

  function handleGenerateShifts(newMonthlyAssignments: ShiftAssignment[]) {
    if (actor) logActivity(actor, 'shift_generate', `${selectedMonth} ${newMonthlyAssignments.length}件`);
    const monthSiteIds = new Set(monthlyWorkSites.map((s) => s.id));
    setAssignments((prev) => [
      ...prev.filter((a) => !monthSiteIds.has(a.siteId)),
      ...newMonthlyAssignments,
    ]);
  }

  function handleClearMonthlyShifts() {
    if (actor) logActivity(actor, 'shift_clear', selectedMonth);
    const monthSiteIds = new Set(monthlyWorkSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => !monthSiteIds.has(a.siteId)));
  }

  function handleDeleteImportBatch(importBatchId: string) {
    const batchIds = new Set(
      workSites
        .filter((s) => s.importBatchId === importBatchId && s.source !== 'manual' && !s.isManuallyEdited)
        .map((s) => s.id)
    );
    if (batchIds.size > 0) {
      setAssignments((prev) => prev.filter((a) => !batchIds.has(a.siteId)));
    }
    setWorkSites((prev) =>
      prev.filter((s) => !(s.importBatchId === importBatchId && s.source !== 'manual' && !s.isManuallyEdited))
    );
    setImportLogs((prev) => prev.filter((l) => l.importBatchId !== importBatchId));
  }

  function handleReimportBatch(oldBatchId: string, newSites: WorkSite[], newLog: ImportLog) {
    const oldBatchSiteIds = new Set(
      workSites
        .filter((s) => s.importBatchId === oldBatchId && s.source !== 'manual' && !s.isManuallyEdited)
        .map((s) => s.id)
    );
    setAssignments((prev) => prev.filter((a) => !oldBatchSiteIds.has(a.siteId)));
    setWorkSites((prev) => {
      const remaining = prev.filter(
        (s) => !(s.importBatchId === oldBatchId && s.source !== 'manual' && !s.isManuallyEdited)
      );
      return [...remaining, ...newSites];
    });
    setImportLogs((prev) => [...prev.filter((l) => l.importBatchId !== oldBatchId), newLog]);
    if (actor) logActivity(actor, 'import', newLog.sourceFileName ? `再インポート: ${newLog.sourceFileName}` : '再インポート');
  }

  // ── ヘッダー UI ───────────────────────────────────────────────

  const syncLabel =
    syncState === 'saving' ? '同期中…' :
    syncState === 'saved'  ? '保存済み' :
    syncState === 'error'  ? '同期失敗' : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <h1>シフト作成サポート</h1>
          <span className="app-header__badge">MVP</span>
        </div>

        {user && (
          <div className="app-header__meta">
            {lastActivity && (
              <span className="header-last-activity" title={formatLastActivity(lastActivity)}>
                最終更新: {formatLastActivity(lastActivity)}
              </span>
            )}
            {syncLabel && (
              <span className={`header-sync-badge header-sync-badge--${syncState}`}>
                {syncLabel}
              </span>
            )}
            {onlineUsers.length > 0 && (
              <div className="header-presence">
                {onlineUsers.slice(0, 5).map((u) => (
                  u.photoURL ? (
                    <img
                      key={u.uid}
                      src={u.photoURL}
                      alt={u.displayName}
                      title={u.displayName}
                      className="presence-avatar"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span key={u.uid} className="presence-initial" title={u.displayName}>
                      {u.displayName.slice(0, 1)}
                    </span>
                  )
                ))}
                <span className="presence-count">{onlineUsers.length}人オンライン</span>
              </div>
            )}
          </div>
        )}

        <AuthButton />
      </header>

      <nav className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-nav__item${activeTab === tab.id ? ' tab-nav__item--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="month-bar">
        <span className="month-bar__label">対象月</span>
        <button className="month-bar__btn" onClick={() => setSelectedMonth(prevMonth(selectedMonth))}>◀</button>
        <input
          className="month-bar__input"
          type="month"
          value={selectedMonth}
          onChange={(e) => { if (e.target.value) setSelectedMonth(e.target.value); }}
        />
        <button className="month-bar__btn" onClick={() => setSelectedMonth(nextMonth(selectedMonth))}>▶</button>
        {selectedMonth !== toYearMonth(new Date()) && (
          <button className="month-bar__today" onClick={() => setSelectedMonth(toYearMonth(new Date()))}>
            今月
          </button>
        )}
      </div>

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <Dashboard
            staff={staff}
            workSites={monthlyWorkSites}
            assignments={monthlyAssignments}
            selectedMonth={selectedMonth}
            onNavigate={(tab) => setActiveTab(tab as Tab)}
            hasSites={hasSites}
            activityLogs={activityLogs}
          />
        )}
        {activeTab === 'staff' && (
          <StaffManager
            staff={staff}
            workSites={workSites}
            onChange={handleStaffChange}
            selectedMonth={selectedMonth}
          />
        )}
        {activeTab === 'worksite' && (
          <WorkSiteManager
            workSites={workSites}
            onChange={handleWorkSiteChange}
            onAddImportLog={handleAddImportLog}
            selectedMonth={selectedMonth}
          />
        )}
        {activeTab === 'shift' && (
          <ShiftBuilder
            staff={staff}
            workSites={monthlyWorkSites}
            assignments={monthlyAssignments}
            selectedMonth={selectedMonth}
            onGenerate={handleGenerateShifts}
            onClear={handleClearMonthlyShifts}
          />
        )}
        {activeTab === 'export' && (
          <ExportPanel
            staff={staff}
            workSites={monthlyWorkSites}
            assignments={monthlyAssignments}
            onClearAll={handleClearAll}
            selectedMonth={selectedMonth}
          />
        )}
        {activeTab === 'import' && (
          <CsvImporter
            staff={staff}
            workSites={workSites}
            importLogs={importLogs}
            currentSiteCount={workSites.filter((s) => !s.isPlaceholder).length}
            csvSiteCount={workSites.filter((s) => isImportedSite(s)).length}
            onImportStaff={(imported) => setStaff((prev) => [...prev, ...imported])}
            onImportSites={(imported, overwrite) => {
              if (overwrite) {
                const overwriteIds = new Set(
                  workSites.filter((s) => isImportedSite(s)).map((s) => s.id)
                );
                setAssignments((prev) => prev.filter((a) => !overwriteIds.has(a.siteId)));
              }
              setWorkSites((prev) => {
                const base = overwrite ? prev.filter((s) => !isImportedSite(s)) : prev;
                return [...base, ...imported];
              });
            }}
            onAddImportLog={handleAddImportLog}
            onApplyDaysOff={(updates) =>
              setStaff((prev) =>
                prev.map((s) => {
                  const upd = updates.find((u) => u.id === s.id);
                  return upd ? { ...s, requestedDaysOff: upd.requestedDaysOff } : s;
                })
              )
            }
            onDeleteCsvSites={() => {
              const importedIds = new Set(
                workSites.filter((s) => isImportedSite(s)).map((s) => s.id)
              );
              if (importedIds.size > 0) {
                setAssignments((prev) => prev.filter((a) => !importedIds.has(a.siteId)));
              }
              setWorkSites((prev) => prev.filter((s) => !isImportedSite(s)));
            }}
            onDeleteImportBatch={handleDeleteImportBatch}
            onReimportBatch={handleReimportBatch}
            selectedMonth={selectedMonth}
          />
        )}
      </main>
    </div>
  );
}
