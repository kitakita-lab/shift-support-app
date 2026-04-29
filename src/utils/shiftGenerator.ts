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

    // 優先現場指定があるスタッフを同じ勤務日数内で優先、その後均等配分
    candidates.sort((a, b) => {
      const aP = a.preferredWorkSites.includes(site.siteName) ? 0 : 1;
      const bP = b.preferredWorkSites.includes(site.siteName) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return workDayCount[a.id] - workDayCount[b.id];
    });

    const assigned = candidates.slice(0, site.requiredPeople).sort(compareStaffNo);
    assigned.forEach((s) => (workDayCount[s.id] += 1));

    const shortage = Math.max(0, site.requiredPeople - assigned.length);

    assignments.push({
      siteId: site.id,
      assignedStaffIds: assigned.map((s) => s.id),
      shortage,
    });
  }

  return assignments;
}
