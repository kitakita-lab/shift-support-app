import { useState, useEffect } from 'react';
import { Staff, WorkSite, ShiftAssignment } from './types';
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
  { id: 'import',    label: 'CSVインポート' },
];

export default function App() {
  const [activeTab,   setActiveTab]   = useState<Tab>('dashboard');
  const [staff,       setStaff]       = useState<Staff[]>(() => storage.loadStaff());
  const [workSites,   setWorkSites]   = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());

  useEffect(() => { storage.saveStaff(staff); },       [staff]);
  useEffect(() => { storage.saveWorkSites(workSites); }, [workSites]);
  useEffect(() => { storage.saveAssignments(assignments); }, [assignments]);

  function handleClearAll() {
    storage.clearAll();
    setStaff([]);
    setWorkSites([]);
    setAssignments([]);
  }

  // スタッフが削除された場合、該当 staffId を assignedStaffIds から除去し shortage を補正する
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
    setStaff(newStaff);
  }

  // 現場が削除された場合、該当 siteId の assignment を削除する
  function handleWorkSiteChange(newSites: WorkSite[]) {
    const newIds = new Set(newSites.map((s) => s.id));
    setAssignments((prev) => prev.filter((a) => newIds.has(a.siteId)));
    setWorkSites(newSites);
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

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <Dashboard staff={staff} workSites={workSites} assignments={assignments} />
        )}
        {activeTab === 'staff' && (
          <StaffManager staff={staff} workSites={workSites} onChange={handleStaffChange} />
        )}
        {activeTab === 'worksite' && (
          <WorkSiteManager workSites={workSites} onChange={handleWorkSiteChange} />
        )}
        {activeTab === 'shift' && (
          <ShiftBuilder
            staff={staff}
            workSites={workSites}
            assignments={assignments}
            onGenerate={setAssignments}
          />
        )}
        {activeTab === 'export' && (
          <ExportPanel
            staff={staff}
            workSites={workSites}
            assignments={assignments}
            onClearAll={handleClearAll}
          />
        )}
        {activeTab === 'import' && (
          <CsvImporter
            staff={staff}
            currentSiteCount={workSites.filter((s) => !s.isPlaceholder).length}
            csvSiteCount={workSites.filter((s) => s.source === 'csv').length}
            onImportStaff={(imported) => setStaff((prev) => [...prev, ...imported])}
            onImportSites={(imported, overwrite) => {
              // 上書きモード時：全 assignment を削除してから workSites を置き換える
              // CSV更新後は必ずシフト再生成が必要なため、中途半端な割当を残さない
              if (overwrite) {
                setAssignments([]);
              }
              setWorkSites((prev) => {
                const base = overwrite ? prev.filter((s) => s.source !== 'csv') : prev;
                return [...base, ...imported];
              });
            }}
            onApplyDaysOff={(updates) =>
              setStaff((prev) =>
                prev.map((s) => {
                  const upd = updates.find((u) => u.id === s.id);
                  return upd ? { ...s, requestedDaysOff: upd.requestedDaysOff } : s;
                })
              )
            }
            onDeleteCsvSites={() => {
              // CSV 現場を削除する前に関連 assignment をクリーンアップする
              const csvIds = new Set(
                workSites.filter((s) => s.source === 'csv').map((s) => s.id)
              );
              if (csvIds.size > 0) {
                setAssignments((prev) => prev.filter((a) => !csvIds.has(a.siteId)));
              }
              setWorkSites((prev) => prev.filter((s) => s.source !== 'csv'));
            }}
          />
        )}
      </main>
    </div>
  );
}
