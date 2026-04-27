import { Staff, WorkSite, ShiftAssignment } from '../types';

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

    // 勤務日数が少ない順に並べて均等配分
    candidates.sort((a, b) => workDayCount[a.id] - workDayCount[b.id]);

    const assigned = candidates.slice(0, site.requiredPeople);
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
