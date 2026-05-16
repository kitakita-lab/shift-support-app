import { useState, useEffect, useMemo } from 'react';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from './types';
import { storage } from './utils/storage';
import Dashboard from './components/Dashboard';
import StaffManager from './components/StaffManager';
import WorkSiteManager from './components/WorkSiteManager';
import ShiftBuilder from './components/ShiftBuilder';
import ExportPanel from './components/ExportPanel';
import CsvImporter from './components/CsvImporter';
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

export default function App() {
  const [activeTab,   setActiveTab]   = useState<Tab>('dashboard');
  const [staff,       setStaff]       = useState<Staff[]>(() => storage.loadStaff());
  const [workSites,   setWorkSites]   = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());
  const [importLogs,  setImportLogs]  = useState<ImportLog[]>(() => storage.loadImportLogs());

  const [selectedMonth, setSelectedMonth] = useState<string>(() => toYearMonth(new Date()));

  useEffect(() => { storage.saveStaff(staff); },         [staff]);
  useEffect(() => { storage.saveWorkSites(workSites); },  [workSites]);
  useEffect(() => { storage.saveAssignments(assignments); }, [assignments]);
  useEffect(() => { storage.saveImportLogs(importLogs); }, [importLogs]);

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

  function handleClearAll() {
    storage.clearAll();
    setStaff([]);
    setWorkSites([]);
    setAssignments([]);
    setImportLogs([]);
  }

  function handleAddImportLog(log: ImportLog) {
    setImportLogs((prev) => [...prev, log]);
  }

  function handleStaffChange(newStaff: Staff[]) {
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
    // 削除されたスタッフのIDを ngPartnerIds からも除去
    setStaff(newStaff.map((s) => ({
      ...s,
      ngPartnerIds: s.ngPartnerIds?.filter((id) => newIds.has(id)),
    })));
  }

  function handleWorkSiteChange(newSites: WorkSite[]) {
    const newIds = new Set(newSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => newIds.has(a.siteId)));
    setWorkSites(newSites);
  }

  function handleGenerateShifts(newMonthlyAssignments: ShiftAssignment[]) {
    const monthSiteIds = new Set(monthlyWorkSites.map((s) => s.id));
    setAssignments((prev) => [
      ...prev.filter((a) => !monthSiteIds.has(a.siteId)),
      ...newMonthlyAssignments,
    ]);
  }

  function handleClearMonthlyShifts() {
    const monthSiteIds = new Set(monthlyWorkSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => !monthSiteIds.has(a.siteId)));
  }

  /** バッチ単位削除。source === 'manual' または isManuallyEdited === true は保護する。 */
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

  /** 再インポート：旧バッチを削除し新データを追加する。手動データ・手動編集済みは保護。 */
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
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>シフト作成サポート</h1>
        <span className="app-header__badge">MVP</span>
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
                // 上書きモード: 手動データは保持しインポート済みのみ削除
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
