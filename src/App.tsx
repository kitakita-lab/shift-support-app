import { useState, useEffect } from 'react';
import { Staff, WorkSite, ShiftAssignment } from './types';
import { storage } from './utils/storage';
import Dashboard from './components/Dashboard';
import StaffManager from './components/StaffManager';
import WorkSiteManager from './components/WorkSiteManager';
import ShiftBuilder from './components/ShiftBuilder';
import ExportPanel from './components/ExportPanel';
import './styles/App.css';

type Tab = 'dashboard' | 'staff' | 'worksite' | 'shift' | 'export';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'ダッシュボード' },
  { id: 'staff', label: 'スタッフ管理' },
  { id: 'worksite', label: '現場管理' },
  { id: 'shift', label: 'シフト作成' },
  { id: 'export', label: '出力' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [staff, setStaff] = useState<Staff[]>(() => storage.loadStaff());
  const [workSites, setWorkSites] = useState<WorkSite[]>(() => storage.loadWorkSites());
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(() => storage.loadAssignments());

  useEffect(() => {
    storage.saveStaff(staff);
  }, [staff]);

  useEffect(() => {
    storage.saveWorkSites(workSites);
  }, [workSites]);

  useEffect(() => {
    storage.saveAssignments(assignments);
  }, [assignments]);

  function handleClearAll() {
    storage.clearAll();
    setStaff([]);
    setWorkSites([]);
    setAssignments([]);
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
          <StaffManager staff={staff} onChange={setStaff} />
        )}
        {activeTab === 'worksite' && (
          <WorkSiteManager workSites={workSites} onChange={setWorkSites} />
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
      </main>
    </div>
  );
}
