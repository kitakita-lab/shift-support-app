import { Staff, WorkSite, ShiftAssignment } from '../types';
import { exportCsv } from '../utils/csvExport';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  assignments: ShiftAssignment[];
  onClearAll: () => void;
}

export default function ExportPanel({ staff, workSites, assignments, onClearAll }: Props) {
  function handleExport() {
    if (workSites.length === 0) {
      alert('出力するデータがありません');
      return;
    }
    exportCsv(workSites, assignments, staff);
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
      <div className="card">
        <h3>CSVエクスポート</h3>
        <p>シフト表をCSVファイルとしてダウンロードします。</p>
        <button className="btn btn--primary btn--large" onClick={handleExport}>
          CSVダウンロード
        </button>
      </div>

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
                  const asgn = assignMap[site.id];
                  const names = asgn
                    ? asgn.assignedStaffIds.map((id) => staffMap[id] ?? id).join(' / ')
                    : '未作成';
                  const shortage = asgn ? asgn.shortage : '—';
                  return (
                    <tr key={site.id}>
                      <td>{site.date}</td>
                      <td>{site.siteName}</td>
                      <td>{site.startTime}</td>
                      <td>{site.endTime}</td>
                      <td>{site.requiredPeople}</td>
                      <td>{names}</td>
                      <td>{shortage}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
