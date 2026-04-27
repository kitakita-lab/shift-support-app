import { Staff, WorkSite, ShiftAssignment } from '../types';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  assignments: ShiftAssignment[];
}

interface StatCardProps {
  label: string;
  value: number;
  alert?: boolean;
}

function StatCard({ label, value, alert }: StatCardProps) {
  return (
    <div className={`stat-card${alert ? ' stat-card--alert' : ''}`}>
      <div className="stat-card__value">{value}</div>
      <div className="stat-card__label">{label}</div>
    </div>
  );
}

export default function Dashboard({ staff, workSites, assignments }: Props) {
  const totalRequired = workSites.reduce((sum, s) => sum + s.requiredPeople, 0);
  const totalAssigned = assignments.reduce((sum, a) => sum + a.assignedStaffIds.length, 0);
  const totalShortage = assignments.reduce((sum, a) => sum + a.shortage, 0);
  const warningCount = assignments.filter((a) => a.shortage > 0).length;

  return (
    <div className="dashboard">
      <h2>ダッシュボード</h2>
      {assignments.length === 0 && (
        <p className="dashboard__hint">
          スタッフと現場を登録してシフトを自動作成すると、ここに集計が表示されます。
        </p>
      )}
      <div className="stat-grid">
        <StatCard label="登録スタッフ数" value={staff.length} />
        <StatCard label="登録現場数" value={workSites.length} />
        <StatCard label="必要総人数" value={totalRequired} />
        <StatCard label="割当済み人数" value={totalAssigned} />
        <StatCard label="不足人数" value={totalShortage} alert={totalShortage > 0} />
        <StatCard label="不足現場数" value={warningCount} alert={warningCount > 0} />
      </div>
    </div>
  );
}
