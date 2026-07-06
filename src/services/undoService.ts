import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

/** Undo で復元できるアプリデータのスナップショット */
export interface AppData {
  staff:       Staff[];
  workSites:   WorkSite[];
  assignments: ShiftAssignment[];
  importLogs:  ImportLog[];
}

/** 操作ラベル付きスナップショット */
export interface UndoSnapshot extends AppData {
  label: string;
}

export function createSnapshot(label: string, data: AppData): UndoSnapshot {
  return { ...data, label };
}
