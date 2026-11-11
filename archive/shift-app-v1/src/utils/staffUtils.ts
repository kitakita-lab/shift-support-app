import { Staff } from '../types';

export function compareStaffNo(a: Staff, b: Staff): number {
  const na = parseInt(a.staffNo, 10);
  const nb = parseInt(b.staffNo, 10);
  if (!isNaN(na) && !isNaN(nb)) {
    const d = na - nb;
    return d !== 0 ? d : a.name.localeCompare(b.name, 'ja');
  }
  if (!isNaN(na)) return -1;
  if (!isNaN(nb)) return 1;
  if (a.staffNo && b.staffNo) {
    const d = a.staffNo.localeCompare(b.staffNo, 'ja');
    return d !== 0 ? d : a.name.localeCompare(b.name, 'ja');
  }
  if (a.staffNo) return -1;
  if (b.staffNo) return 1;
  return a.name.localeCompare(b.name, 'ja');
}

export function sortStaff<T extends Staff>(staff: T[]): T[] {
  return [...staff].sort(compareStaffNo);
}

export function nextStaffNo(staff: Staff[]): string {
  const nums = staff.map((s) => parseInt(s.staffNo, 10)).filter((n) => !isNaN(n));
  return String(nums.length > 0 ? Math.max(...nums) + 1 : 1);
}

export function sortedByStaffNo(ids: string[], index: Record<string, Staff>): string[] {
  return [...ids].sort((a, b) => {
    const sa = index[a];
    const sb = index[b];
    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;
    return compareStaffNo(sa, sb);
  });
}
