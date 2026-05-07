import { Fragment } from 'react';
import { Staff, WorkSite, ShiftAssignment } from '../types';
import { generateShifts } from '../utils/shiftGenerator';
import { sortedByStaffNo, sortStaff } from '../utils/staffUtils';
import { formatSiteLabel } from '../utils/siteUtils';

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

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  // プレースホルダー（会期なし現場）はシフト作成対象外
  const activeSites = workSites.filter((s) => !s.isPlaceholder);
  const sorted = [...activeSites].sort((a, b) => a.date.localeCompare(b.date));

  // date → staff who requested that date off (deduplicated dates, sorted by staffNo)
  const seenDates = new Set<string>();
  const dateToOffStaff = new Map<string, Staff[]>();
  for (const site of sorted) {
    if (!seenDates.has(site.date)) {
      seenDates.add(site.date);
      const offs = sortStaff(staff.filter((s) => s.requestedDaysOff.includes(site.date)));
      if (offs.length > 0) dateToOffStaff.set(site.date, offs);
    }
  }

  function handleGenerate() {
    if (activeSites.length === 0) {
      alert('シフト対象の現場が登録されていません');
      return;
    }
    if (staff.length === 0) {
      alert('スタッフが登録されていません');
      return;
    }
    const result = generateShifts(staff, activeSites);
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

      {/* 希望休サマリー: 現場登録済みなら常に表示 */}
      {workSites.length > 0 && dateToOffStaff.size > 0 && (
        <div className="card">
          <h3>日付別 希望休スタッフ</h3>
          <p className="section-desc">シフト対象日に希望休を申請しているスタッフの一覧です</p>
          <div className="dayoff-summary">
            {[...dateToOffStaff.entries()].map(([date, offs]) => (
              <div key={date} className="dayoff-summary-row">
                <span className="dayoff-summary-date">{date}</span>
                <div className="dayoff-summary-names">
                  {offs.map((s) => (
                    <span key={s.id} className="tag">
                      {s.staffNo ? `${s.staffNo}: ${s.name}` : s.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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

                  const sortedIds = sortedByStaffNo(asgn.assignedStaffIds, staffIndex);
                  const hasShortage = asgn.shortage > 0;

                  // 希望休日に割当されているスタッフ（通常はゼロ、安全チェック用）
                  const violationIds = new Set(
                    asgn.assignedStaffIds.filter(
                      (id) => staffIndex[id]?.requestedDaysOff.includes(site.date)
                    )
                  );

                  // 希望休があり割当から外れたスタッフ
                  const offStaff = dateToOffStaff.get(site.date) ?? [];
                  const excludedStaff = offStaff.filter(
                    (s) => !asgn.assignedStaffIds.includes(s.id)
                  );

                  return (
                    <tr key={site.id} className={hasShortage ? 'row--alert' : ''}>
                      <td>{site.date}</td>
                      <td>{formatSiteLabel(site.siteName, site.clientName)}</td>
                      <td>
                        {site.startTime}〜{site.endTime}
                      </td>
                      <td>{site.requiredPeople}人</td>
                      <td>
                        {sortedIds.length > 0 ? (
                          <div className="assigned-cell">
                            <div className="assigned-names">
                              {sortedIds.map((id, i) => (
                                <Fragment key={id}>
                                  {i > 0 && '、'}
                                  {violationIds.has(id) ? (
                                    <span className="assign-violation" title="希望休日に割当されています">
                                      ⚠ {staffMap[id] ?? id}
                                    </span>
                                  ) : staffIndex[id]?.preferredWorkSites.includes(site.siteName) ? (
                                    <span className="assign-preferred" title="優先現場として設定されています">
                                      ★ {staffMap[id] ?? id}
                                    </span>
                                  ) : (
                                    staffMap[id] ?? id
                                  )}
                                </Fragment>
                              ))}
                            </div>
                            {excludedStaff.length > 0 && (
                              <div className="dayoff-excluded-row">
                                希望休除外: {excludedStaff.map((s) => s.name).join('・')}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="unassigned-label">未割当</span>
                        )}
                      </td>
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

      {assignments.length === 0 && activeSites.length > 0 && (
        <div className="card">
          <p className="empty-msg">「シフトを自動作成」ボタンを押してください</p>
        </div>
      )}
    </div>
  );
}
