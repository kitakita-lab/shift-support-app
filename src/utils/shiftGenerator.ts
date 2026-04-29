import { Staff, WorkSite, ShiftAssignment } from '../types';
import { compareStaffNo } from './staffUtils';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function getWeekdayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return WEEKDAY_LABELS[d.getDay()];
}

export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  const sortedSites = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

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
    const byWorkDays = (a: Staff, b: Staff) => workDayCount[a.id] - workDayCount[b.id];
    const preferred = candidates.filter((s) => s.preferredWorkSites.includes(site.siteName)).sort(byWorkDays);
    const others = candidates.filter((s) => !s.preferredWorkSites.includes(site.siteName)).sort(byWorkDays);
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
