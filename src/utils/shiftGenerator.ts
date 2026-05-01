import { Staff, WorkSite, ShiftAssignment } from '../types';
import { compareStaffNo } from './staffUtils';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function getWeekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.replace(/\//g, '-').split('-').map(Number);
  return WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()];
}

export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  const sortedSites = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  // 各スタッフの割当日数を追跡
  const workDayCount: Record<string, number> = {};
  staff.forEach((s) => (workDayCount[s.id] = 0));

  const assignments: ShiftAssignment[] = [];

  for (const site of sortedSites) {
    const weekday = getWeekdayLabel(site.date);

    // 候補スタッフを絞り込む
    const candidates = staff.filter((s) => {
      const availableOnDay = s.availableWeekdays.includes(weekday);
      const notOnHoliday = !s.requestedDaysOff.includes(site.date);
      const underMaxDays = workDayCount[s.id] < s.maxWorkDays;
      return availableOnDay && notOnHoliday && underMaxDays;
    });

    // 優先現場グループを先に割当、不足時のみ一般グループで補充
    // 同一グループ内: 勤務日数少ない順 → staffNo順 → 名前順
    const byWorkDaysThenStaffNo = (a: Staff, b: Staff): number => {
      const diff = workDayCount[a.id] - workDayCount[b.id];
      return diff !== 0 ? diff : compareStaffNo(a, b);
    };
    const preferred = candidates.filter((s) => s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const others = candidates.filter((s) => !s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const merged = [...preferred, ...others];

    const assigned = merged.slice(0, site.requiredPeople).sort(compareStaffNo);
    assigned.forEach((s) => (workDayCount[s.id] += 1));

    if (import.meta.env.DEV) {
      console.log(`[シフト] ${site.date} ${site.siteName}: 優先候補${preferred.length}人 / 一般候補${others.length}人 → 選出: [${assigned.map((s) => s.name).join(', ')}]`);
    }

    const shortage = Math.max(0, site.requiredPeople - assigned.length);

    assignments.push({
      siteId: site.id,
      assignedStaffIds: assigned.map((s) => s.id),
      shortage,
    });
  }

  return assignments;
}
