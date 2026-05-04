import { useState } from 'react';
import { Staff, WorkSite, ShiftAssignment } from '../types';
import { exportCsv } from '../utils/csvExport';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  assignments: ShiftAssignment[];
  onClearAll: () => void;
  selectedMonth: string;
}

export default function ExportPanel({ staff, workSites, assignments, onClearAll, selectedMonth }: Props) {
  const [isExporting, setIsExporting] = useState(false);

  function handleExportCsv() {
    if (workSites.length === 0) {
      alert('出力するデータがありません');
      return;
    }
    exportCsv(workSites, assignments, staff, `shift_${selectedMonth}.csv`);
  }

  async function handleExportExcel() {
    if (workSites.length === 0) {
      alert('出力するデータがありません');
      return;
    }
    setIsExporting(true);
    try {
      // exceljs は重いため、クリック時に動的インポートして分割チャンクとして読み込む
      const { exportExcel } = await import('../utils/excelExport');
      await exportExcel(workSites, assignments, staff, `shift_schedule_${selectedMonth}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  }

  function handleClear() {
    if (confirm('すべてのデータを削除します。この操作は取り消せません。')) {
      onClearAll();
    }
  }

  const staffMap: Record<string, string> = {};
  staff.forEach((s) => (staffMap[s.id] = s.name));

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      <h2>出力</h2>

      {/* ── エクスポートボタン群 ─────────────────────────── */}
      <div className="card">
        <h3>エクスポート</h3>
        <p className="section-desc">
          シフト表をダウンロードします。Excelは書式付きで出力され、不足行は赤色で強調されます。
        </p>
        <div className="export-buttons">
          <button className="btn btn--primary btn--large" onClick={handleExportCsv}>
            CSVダウンロード
          </button>
          <button
            className="btn btn--excel btn--large"
            onClick={handleExportExcel}
            disabled={isExporting}
          >
            {isExporting ? 'Excelを生成中…' : 'Excelダウンロード (.xlsx)'}
          </button>
        </div>
      </div>

      {/* ── 出力プレビュー ───────────────────────────────── */}
      {sorted.length > 0 && (
        <div className="card">
          <h3>出力プレビュー</h3>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>現場名</th>
                  <th>開始</th>
                  <th>終了</th>
                  <th>必要人数</th>
                  <th>割当スタッフ</th>
                  <th>不足</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((site) => {
                  const asgn     = assignMap[site.id];
                  const names    = asgn
                    ? asgn.assignedStaffIds.map((id) => staffMap[id] ?? id).join(' / ')
                    : '未作成';
                  const shortage = asgn ? asgn.shortage : '—';
                  const hasShortage = typeof shortage === 'number' && shortage > 0;
                  return (
                    <tr key={site.id} className={hasShortage ? 'row--alert' : ''}>
                      <td>{site.date}</td>
                      <td>{site.siteName}</td>
                      <td>{site.startTime}</td>
                      <td>{site.endTime}</td>
                      <td>{site.requiredPeople}</td>
                      <td>{names}</td>
                      <td>
                        {hasShortage
                          ? <span className="shortage-badge">{shortage}人不足</span>
                          : shortage}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── データ管理 ───────────────────────────────────── */}
      <div className="card card--danger">
        <h3>データ管理</h3>
        <p>全データ（スタッフ・現場・シフト）を削除します。</p>
        <button className="btn btn--danger btn--large" onClick={handleClear}>
          データを全削除
        </button>
      </div>
    </div>
  );
}
