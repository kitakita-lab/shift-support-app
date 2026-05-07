import { Staff, WorkSite, ShiftAssignment } from '../types';
import { sortedByStaffNo } from './staffUtils';

function escape(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function download(csv: string, filename: string): void {
  const bom = '﻿';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 現場別CSV（1行 = 1現場、複数スタッフはセル内で結合）
export function exportCsv(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staffList: Staff[],
  filename = 'shift.csv'
): void {
  const staffMap: Record<string, string> = {};
  const staffIndex: Record<string, Staff> = {};
  staffList.forEach((s) => {
    staffMap[s.id] = s.name;
    staffIndex[s.id] = s;
  });

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const headers = ['日付', '現場名', 'クライアント名', '開始時間', '終了時間', '必要人数', '割当スタッフ', '不足人数'];

  const sorted = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  const rows = sorted.map((site) => {
    const asgn = assignMap[site.id];
    const staffNames = asgn
      ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex).map((id) => staffMap[id] ?? id).join(' / ')
      : '';
    const shortage = asgn ? asgn.shortage : site.requiredPeople;
    return [
      site.date,
      site.siteName,
      site.clientName ?? '',
      site.startTime,
      site.endTime,
      site.requiredPeople,
      staffNames,
      shortage,
    ].map(escape).join(',');
  });

  download([headers.join(','), ...rows].join('\n'), filename);
}

// スタッフ別CSV（1行 = 1スタッフ）
export function exportStaffCsv(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staffList: Staff[],
  filename = 'shift_by_staff.csv'
): void {
  const staffMap: Record<string, string> = {};
  const staffIndex: Record<string, Staff> = {};
  staffList.forEach((s) => {
    staffMap[s.id] = s.name;
    staffIndex[s.id] = s;
  });

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const headers = ['日付', '現場名', 'クライアント名', '開始時間', '終了時間', 'スタッフ名'];

  const sorted = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  const rows: string[] = [];
  for (const site of sorted) {
    const asgn = assignMap[site.id];
    const staffIds = asgn && asgn.assignedStaffIds.length > 0
      ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex)
      : [];
    const clientName = site.clientName ?? '';

    if (staffIds.length === 0) {
      rows.push([site.date, site.siteName, clientName, site.startTime, site.endTime, ''].map(escape).join(','));
    } else {
      for (const id of staffIds) {
        rows.push([site.date, site.siteName, clientName, site.startTime, site.endTime, staffMap[id] ?? id].map(escape).join(','));
      }
    }
  }

  download([headers.join(','), ...rows].join('\n'), filename);
}
