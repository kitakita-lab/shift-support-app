import { Staff, WorkSite, ShiftAssignment } from '../types';
import { compareStaffNo } from './staffUtils';

const DEFAULT_MAX_CONSECUTIVE_DAYS = 5;
const DEFAULT_MAX_WORK_DAYS = 20;

// 曜日インデックス（getDay()）→ Staff.availableWeekdays の文字列
const DOW_KEYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function parseDateLocal(s: string): Date {
  const [y, m, d] = s.replace(/\//g, '-').split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// targetDate を追加したときの連勤数が limit を超えるか判定
// limit は Staff.maxConsecutiveDays ?? DEFAULT_MAX_CONSECUTIVE_DAYS を渡す
function wouldExceedConsecutive(assignedDates: Set<string>, targetDate: string, limit: number): boolean {
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
  return count > limit;
}

// スタッフがその曜日に勤務可能か判定
// availableWeekdays が空配列または未定義の場合は全曜日可能とみなす（既存データ互換）
function isAvailableOnDate(s: Staff, date: string): boolean {
  if (!s.availableWeekdays || s.availableWeekdays.length === 0) return true;
  const dow = DOW_KEYS[parseDateLocal(date).getDay()];
  return s.availableWeekdays.includes(dow);
}

// 月間勤務日数が上限未満か判定
// maxWorkDays が未定義の場合は DEFAULT_MAX_WORK_DAYS を使用（既存データ互換）
function isWithinMaxWorkDays(s: Staff, assignedDates: Set<string>): boolean {
  const limit = s.maxWorkDays ?? DEFAULT_MAX_WORK_DAYS;
  // assignedDates は日付単位の Set なので重複カウントなし
  return assignedDates.size < limit;
}

export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  const sortedSites = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  // 各スタッフの割当済み日付を追跡（連勤判定・月間上限判定に使用）
  const assignedDates: Record<string, Set<string>> = {};
  staff.forEach((s) => (assignedDates[s.id] = new Set()));

  const assignments: ShiftAssignment[] = [];

  for (const site of sortedSites) {
    // ── 絶対条件フィルタ ──────────────────────────────────────────
    // 以下のいずれかに該当するスタッフは候補から除外する
    //   1. 希望休（requestedDaysOff）
    //   2. 最大連勤超過（maxConsecutiveDays、未設定時は DEFAULT_MAX_CONSECUTIVE_DAYS）
    //   3. 勤務不可曜日（availableWeekdays）
    //   4. 月間最大勤務日数超過（maxWorkDays）
    const candidates = staff.filter((s) => {
      const consecutiveLimit  = s.maxConsecutiveDays ?? DEFAULT_MAX_CONSECUTIVE_DAYS;
      const notOnHoliday      = !s.requestedDaysOff.includes(site.date);
      const withinConsecutive = !wouldExceedConsecutive(assignedDates[s.id], site.date, consecutiveLimit);
      const availableWeekday  = isAvailableOnDate(s, site.date);
      const withinMaxDays     = isWithinMaxWorkDays(s, assignedDates[s.id]);
      return notOnHoliday && withinConsecutive && availableWeekday && withinMaxDays;
    });

    // 優先現場グループを先に割当、不足時のみ一般グループで補充
    // 同一グループ内: 勤務日数少ない順 → staffNo順
    // TODO(Phase 2): preferredWorkSites を { siteName, clientName } 対応にする場合は
    //               ここの includes(site.siteName) を複合キー照合に変更する
    const byWorkDaysThenStaffNo = (a: Staff, b: Staff): number => {
      const diff = assignedDates[a.id].size - assignedDates[b.id].size;
      return diff !== 0 ? diff : compareStaffNo(a, b);
    };
    const preferred = candidates.filter((s) =>  s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const others    = candidates.filter((s) => !s.preferredWorkSites.includes(site.siteName)).sort(byWorkDaysThenStaffNo);
    const merged    = [...preferred, ...others];

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
