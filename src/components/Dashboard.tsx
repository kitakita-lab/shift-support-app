import { Staff, WorkSite, ShiftAssignment } from '../types';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  assignments: ShiftAssignment[];
  selectedMonth: string;
  onNavigate: (tab: string) => void;
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

function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  return `${y}年${parseInt(m)}月`;
}

export default function Dashboard({ staff, workSites, assignments, selectedMonth, onNavigate }: Props) {
  const monthLabel = formatMonthLabel(selectedMonth);

  // isPlaceholder（会期なし会場の仮レコード）を除いたアクティブな現場日程
  // workSites は App.tsx 側で selectedMonth でフィルタ済み
  const activeSites = workSites.filter((s) => !s.isPlaceholder);

  // ① 登録現場数：ユニーク会場名（siteName）の数
  const venueCount = new Set(activeSites.map((s) => s.siteName)).size;

  // ② 登録会期数：ユニーク sessionId の数（sessionId がない旧データは id で代替）
  const sessionCount = new Set(
    activeSites.map((s) => s.sessionId ?? s.id)
  ).size;

  // ③ 必要人数（延べ）：アクティブな現場日程ごとの requiredPeople の合計
  const totalRequired = activeSites.reduce((sum, s) => sum + s.requiredPeople, 0);

  // 防衛的フィルタリング：存在しない siteId / staffId を持つ孤立 assignment を除外する
  const validSiteIds  = new Set(activeSites.map((s) => s.id));
  const validStaffIds = new Set(staff.map((s) => s.id));
  const cleanAssignments = assignments
    .filter((a) => validSiteIds.has(a.siteId))
    .map((a) => ({
      ...a,
      assignedStaffIds: a.assignedStaffIds.filter((id) => validStaffIds.has(id)),
    }));

  // ④ 割当済み人数（延べ）
  const totalAssigned = cleanAssignments.reduce((sum, a) => sum + a.assignedStaffIds.length, 0);

  // ⑤ 不足人数（延べ）：必要人数 − 割当済み人数
  const totalShortage = Math.max(0, totalRequired - totalAssigned);

  // 不足が生じている日別スロット数（requiredPeople > 割当数 のスロット）
  const requiredBySite = new Map(activeSites.map((s) => [s.id, s.requiredPeople]));
  const warningCount = cleanAssignments.filter(
    (a) => a.assignedStaffIds.length < (requiredBySite.get(a.siteId) ?? 0)
  ).length;

  const hasMonthlyData = activeSites.length > 0;

  return (
    <div className="dashboard">
      <h2>ダッシュボード</h2>
      <p className="dashboard__month-label">対象月：{monthLabel}</p>

      {!hasMonthlyData ? (
        <div className="empty-state">
          <p className="empty-state__title">{monthLabel}のデータはまだありません</p>
          <p className="empty-state__desc">
            現場を登録するか、CSVインポートから取り込んでください
          </p>
          <div className="empty-state__actions">
            <button className="btn btn--primary" onClick={() => onNavigate('worksite')}>
              現場管理へ
            </button>
            <button className="btn btn--secondary" onClick={() => onNavigate('import')}>
              CSVインポートへ
            </button>
          </div>
          {staff.length > 0 && (
            <p className="empty-state__note">登録スタッフ数：{staff.length}人</p>
          )}
        </div>
      ) : (
        <div className="stat-grid">
          <StatCard label="登録スタッフ数" value={staff.length} />
          <StatCard label="登録現場数" value={venueCount} />
          <StatCard label="登録会期数" value={sessionCount} />
          <StatCard label="必要人数（延べ）" value={totalRequired} />
          <StatCard label="割当済み人数（延べ）" value={totalAssigned} />
          <StatCard label="不足人数（延べ）" value={totalShortage} alert={totalShortage > 0} />
          <StatCard label="不足スロット数" value={warningCount} alert={warningCount > 0} />
        </div>
      )}
    </div>
  );
}
