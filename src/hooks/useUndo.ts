import { useState, useRef } from 'react';
import { AppData, UndoSnapshot, createSnapshot } from '../services/undoService';

export interface UseUndoResult {
  snapshot:     UndoSnapshot | null;
  toast:        string | null;
  saveSnapshot: (label: string, data: AppData) => void;
  applyUndo:    () => UndoSnapshot | null;
}

/** 直前1回分の Undo 状態を管理する hook */
export function useUndo(): UseUndoResult {
  const [snapshot, setSnapshot] = useState<UndoSnapshot | null>(null);
  const [toast,    setToast]    = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function saveSnapshot(label: string, data: AppData): void {
    setSnapshot(createSnapshot(label, data));
  }

  function applyUndo(): UndoSnapshot | null {
    if (!snapshot) return null;
    const restored = snapshot;
    setSnapshot(null);
    setToast(`「${restored.label}」を元に戻しました`);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3000);
    return restored;
  }

  return { snapshot, toast, saveSnapshot, applyUndo };
}
