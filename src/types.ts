export interface Staff {
  id: string;
  name: string;
  availableWeekdays: string[];
  requestedDaysOff: string[];
  maxWorkDays: number;
  memo: string;
}

export interface WorkSite {
  id: string;
  date: string;
  siteName: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
}

export interface ShiftAssignment {
  siteId: string;
  assignedStaffIds: string[];
  shortage: number;
}
