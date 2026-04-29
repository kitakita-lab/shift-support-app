import { Staff, WorkSite, ShiftAssignment } from '../types';

const KEYS = {
  staff: 'shift_staff',
  workSites: 'shift_worksites',
  assignments: 'shift_assignments',
};

function load<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function save<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

export const storage = {
  loadStaff: (): Staff[] =>
    load<Partial<Staff> & Omit<Staff, 'staffNo' | 'preferredWorkSites'>>(KEYS.staff).map(
      (s) => ({ staffNo: '', preferredWorkSites: [], ...s } as Staff)
    ),
  saveStaff: (data: Staff[]): void => save(KEYS.staff, data),

  loadWorkSites: (): WorkSite[] => load<WorkSite>(KEYS.workSites),
  saveWorkSites: (data: WorkSite[]): void => save(KEYS.workSites, data),

  loadAssignments: (): ShiftAssignment[] => load<ShiftAssignment>(KEYS.assignments),
  saveAssignments: (data: ShiftAssignment[]): void => save(KEYS.assignments, data),

  clearAll: (): void => {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  },
};
