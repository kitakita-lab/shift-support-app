export interface Staff {
  id: string;
  staffNo: string;
  name: string;
  availableWeekdays: string[];
  requestedDaysOff: string[];
  maxWorkDays: number;
  memo: string;
  preferredWorkSites: string[];
}

export interface WorkSite {
  id: string;
  groupId?: string;
  groupLabel?: string;
  sessionId?: string;
  date: string;
  siteName: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
  isPlaceholder?: boolean;
}

export interface ShiftAssignment {
  siteId: string;
  assignedStaffIds: string[];
  shortage: number;
}
