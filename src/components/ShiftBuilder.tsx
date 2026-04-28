import { Staff, WorkSite, ShiftAssignment } from '../types';
import { generateShifts } from '../utils/shiftGenerator';
import { sortedByStaffNo } from '../utils/staffUtils';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  assignments: ShiftAssignment[];
  onGenerate: (assignments: ShiftAssignment[]) => void;
}

export default function ShiftBuilder({ staff, workSites, assignments, onGenerate }: Props) {
  const staffMap: Record<string, string> = {};
  const staffIndex: Record<string, Staff> = {};
  staff.forEach((s) => {
    staffMap[s.id] = s.name;
    staffIndex[s.id] = s;
  });

  const siteMap: Record<string, WorkSite> = {};
  workSites.forEach((w) => (siteMap[w.id] = w));

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  function handleGenerate() {
    if (workSites.length === 0) {
      alert('現場が登録されていません');
      return;
    }
    if (staff.length === 0) {
      alert('スタッフが登録されていません');
      return;
    }
    const result = generateShifts(staff, workSites);
    onGenerate(result);
  }

  return (
    <div>
      <h2>シフト作成</h2>
      <div className="card">
        <div className="shift-actions">
          <button className="btn btn--primary btn--large" onClick={handleGenerate}>
            シフトを自動作成
          </button>
          <span className="shift-hint">
            スタッフの勤務可能曜日・希望休・最大勤務日数を考慮して自動割り当てします
          </span>
        </div>
      </div>

      {assignments.length > 0 && (
        <div className="card">
          <h3>シフト表</h3>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>現場名</th>
                  <th>時間</th>
                  <th>必要人数</th>
                  <th>割当スタッフ</th>
                  <th>不足</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((site) => {
                  const asgn = assignMap[site.id];
                  if (!asgn) return null;
                  const names = sortedByStaffNo(asgn.assignedStaffIds, staffIndex).map((id) => staffMap[id] ?? id);
                  const hasShortage = asgn.shortage > 0;
                  return (
                    <tr key={site.id} className={hasShortage ? 'row--alert' : ''}>
                      <td>{site.date}</td>
                      <td>{site.siteName}</td>
                      <td>
                        {site.startTime}〜{site.endTime}
                      </td>
                      <td>{site.requiredPeople}人</td>
                      <td>{names.length > 0 ? names.join('、') : '未割当'}</td>
                      <td>
                        {hasShortage ? (
                          <span className="shortage-badge">{asgn.shortage}人不足</span>
                        ) : (
                          <span className="ok-badge">OK</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assignments.length === 0 && workSites.length > 0 && (
        <div className="card">
          <p className="empty-msg">「シフトを自動作成」ボタンを押してください</p>
        </div>
      )}
    </div>
  );
}
