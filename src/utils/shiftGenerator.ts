import { Staff, WorkSite, ShiftAssignment } from '../types';
import { compareStaffNo } from './staffUtils';

const MAX_CONSECUTIVE_WORK_DAYS = 5;

function parseDateLocal(s: string): Date {
  const [y, m, d] = s.replace(/\//g, '-').split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// targetDate を追加したときの連勤数が MAX_CONSECUTIVE_WORK_DAYS を超えるか判定
function wouldExceedConsecutive(assignedDates: Set<string>, targetDate: string): boolean {
  let count = 1;
  const back = parseDateLocal(targetDate);
  back.setDate(back.getDate() - 1);
  while (assignedDates.has(formatDate(back))) {
    count++;
    back.setDate(back.getDate() - 1);
  }
  const fwd = parseDateLocal(targetDate);
  fwd.setDate(fwd.getDate() + 1);
  while (assignedDates.has(formatDate(fwd))) {
    count++;
    fwd.setDate(fwd.getDate() + 1);
  }
  return count > MAX_CONSECUTIVE_WORK_DAYS;
}

export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  const sortedSites = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  // 各スタッフの割当済み日付を追跡（連勤判定に使用）
  const assignedDates: Record<string, Set<string>> = {};
  staff.forEach((s) => (assignedDates[s.id] = new Set()));

  const assignments: ShiftAssignment[] = [];

  for (const site of sortedSites) {
    // 候補スタッフを絞り込む（希望休・最大連勤数制限）
    const candidates = staff.filter((s) => {
      const notOnHoliday = !s.requestedDaysOff.includes(site.date);
      const withinConsecutive = !wouldExceedConsecutive(assignedDates[s.id], site.date);
      return notOnHoliday && withinConsecutive;
    });

    // 優先現場グループを先に割当、不足時のみ一般グループで補充
    // 同一グループ内: 勤務日数少ない順 → staffNo順
    const byWorkDaysThenStaffNo = (a: Staff, b: Staff): number => {
      const diff = assignedDates[a.id].size - assignedDates[b.id].size;
      return diff !== 0 ? diff : compareStaffNo(a, b);
    };
    const preferred = candidates.filter((s) => s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const others = candidates.filter((s) => !s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const merged = [...preferred, ...others];

    const assigned = merged.slice(0, site.requiredPeople).sort(compareStaffNo);
    assigned.forEach((s) => assignedDates[s.id].add(site.date));

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
