import { Staff, WorkSite, ShiftAssignment } from '../types';

function escape(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function exportCsv(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staffList: Staff[]
): void {
  const staffMap: Record<string, string> = {};
  staffList.forEach((s) => (staffMap[s.id] = s.name));

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const headers = ['日付', '現場名', '開始時間', '終了時間', '必要人数', '割当スタッフ', '不足人数'];

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  const rows = sorted.map((site) => {
    const asgn = assignMap[site.id];
    const staffNames = asgn
      ? asgn.assignedStaffIds.map((id) => staffMap[id] ?? id).join(' / ')
      : '';
    const shortage = asgn ? asgn.shortage : site.requiredPeople;
    return [
      site.date,
      site.siteName,
      site.startTime,
      site.endTime,
      site.requiredPeople,
      staffNames,
      shortage,
    ].map(escape).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const bom = '﻿';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shift.csv';
  a.click();
  URL.revokeObjectURL(url);
}
