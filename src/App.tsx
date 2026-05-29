import { useState, useMemo } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from './types';
import { storage } from './utils/storage';
import Dashboard from './components/Dashboard';
import StaffManager from './components/StaffManager';
import WorkSiteManager from './components/WorkSiteManager';
import ShiftBuilder from './components/ShiftBuilder';
import ExportPanel from './components/ExportPanel';
import CsvImporter from './components/CsvImporter';
import AuthButton from './components/AuthButton';
import { useAuth } from './contexts/AuthContext';
import { logActivity } from './services/activityLogService';
import { DocMeta } from './services/firestoreService';
import { useFirestoreSync } from './hooks/useFirestoreSync';
import { useCollaborativePresence } from './hooks/useCollaborativePresence';
import { useCollaborativeFeatures } from './hooks/useCollaborativeFeatures';
import { useUndo } from './hooks/useUndo';
import './styles/App.css';

type Tab = 'dashboard' | 'staff' | 'worksite' | 'shift' | 'export' | 'import';

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
  const [activeTab,     setActiveTab]     = useState<Tab>('dashboard');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => toYearMonth(new Date()));

  const firestore     = useFirestoreSync();
  const presence      = useCollaborativePresence();
  const collaboration = useCollaborativeFeatures();

  const { staff, setStaff, workSites, setWorkSites, assignments, setAssignments, importLogs, setImportLogs, syncState } = firestore;
  const { lastActivity, onlineUsers } = presence;
  const { activityLogs, editingStates } = collaboration;

  const { snapshot, toast, saveSnapshot, applyUndo } = useUndo();

  const { user } = useAuth();

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
    const prevIds = new Set(staff.map((s) => s.id));
    const newIds  = new Set(newStaff.map((s) => s.id));
    const deleted = staff.filter((s) => !newIds.has(s.id));

    if (deleted.length > 0) {
      saveSnapshot(`スタッフ削除（${deleted.map((s) => s.name).join('・')}）`, { staff, workSites, assignments, importLogs });
    }

    if (actor) {
      newStaff.filter((s) => !prevIds.has(s.id)).forEach((s) =>
        logActivity(actor, 'staff_add', s.name)
      );
      deleted.forEach((s) => logActivity(actor, 'staff_delete', s.name));
    }

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
    const prevGroupIds = new Set(
      workSites.filter((s) => !s.isPlaceholder).map((s) => s.groupId ?? s.id)
    );
    const newGroupIds  = new Set(
      newSites.filter((s) => !s.isPlaceholder).map((s) => s.groupId ?? s.id)
    );
    const addedCount   = [...newGroupIds].filter((id) => !prevGroupIds.has(id)).length;
    const deletedCount = [...prevGroupIds].filter((id) => !newGroupIds.has(id)).length;

    if (deletedCount > 0) {
      saveSnapshot(`現場削除（${deletedCount}件）`, { staff, workSites, assignments, importLogs });
    }

    if (actor) {
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
    saveSnapshot(`シフトクリア（${selectedMonth}）`, { staff, workSites, assignments, importLogs });
    if (actor) logActivity(actor, 'shift_clear', selectedMonth);
    const monthSiteIds = new Set(monthlyWorkSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => !monthSiteIds.has(a.siteId)));
  }

  function handleDeleteImportBatch(importBatchId: string) {
    saveSnapshot('インポートバッチ削除', { staff, workSites, assignments, importLogs });
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
    saveSnapshot('再インポート', { staff, workSites, assignments, importLogs });
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

  function handleUndo() {
    const restored = applyUndo();
    if (!restored) return;
    setStaff(restored.staff);
    setWorkSites(restored.workSites);
    setAssignments(restored.assignments);
    setImportLogs(restored.importLogs);
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
            {snapshot && (
              <button className="header-undo-btn" onClick={handleUndo} title={snapshot.label}>
                ↩ Undo
              </button>
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

      {toast && <div className="undo-toast">{toast}</div>}

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
            editingStates={editingStates}
            currentUserId={user?.uid}
            staffServerUpdatedAt={firestore.serverUpdatedAt.staff}
          />
        )}
        {activeTab === 'worksite' && (
          <WorkSiteManager
            workSites={workSites}
            onChange={handleWorkSiteChange}
            onAddImportLog={handleAddImportLog}
            selectedMonth={selectedMonth}
            editingStates={editingStates}
            currentUserId={user?.uid}
            workSitesServerUpdatedAt={firestore.serverUpdatedAt.workSites}
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
              saveSnapshot('CSVインポート', { staff, workSites, assignments, importLogs });
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
