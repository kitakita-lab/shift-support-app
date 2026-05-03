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
  // isPlaceholder（会期なし会場の仮レコード）を除いたアクティブな現場日程
  const activeSites = workSites.filter((s) => !s.isPlaceholder);

  // ① 登録現場数：ユニーク会場名（siteName）の数
  const venueCount = new Set(activeSites.map((s) => s.siteName)).size;

  // ② 登録会期数：ユニーク sessionId の数（sessionId がない旧データは id で代替）
  const sessionCount = new Set(
    activeSites.map((s) => s.sessionId ?? s.id)
  ).size;

  // ③ 必要人数（延べ）：アクティブな現場日程ごとの requiredPeople の合計
  //    assignments は siteId（WorkSite.id）単位 = 日別単位なので粒度が一致する
  const totalRequired = activeSites.reduce((sum, s) => sum + s.requiredPeople, 0);

  // ④ 割当済み人数（延べ）：日別スロットごとに割り当てられたスタッフ数の合計
  const totalAssigned = assignments.reduce((sum, a) => sum + a.assignedStaffIds.length, 0);

  // ⑤ 不足人数（延べ）：必要人数 − 割当済み人数
  //    assignments が生成されていないスロットの分も正確に計上できる
  const totalShortage = Math.max(0, totalRequired - totalAssigned);

  // 不足が生じている日別スロット数
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
        <StatCard label="登録現場数" value={venueCount} />
        <StatCard label="登録会期数" value={sessionCount} />
        <StatCard label="必要人数（延べ）" value={totalRequired} />
        <StatCard label="割当済み人数（延べ）" value={totalAssigned} />
        <StatCard label="不足人数（延べ）" value={totalShortage} alert={totalShortage > 0} />
        <StatCard label="不足スロット数" value={warningCount} alert={warningCount > 0} />
      </div>
    </div>
  );
}
