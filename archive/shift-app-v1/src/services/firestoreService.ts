import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { Staff, WorkSite, ShiftAssignment, ImportLog } from '../types';

type Unsubscribe = () => void;

export const TEAM_ID = 'intention-dev';

// Firestore パス: teams/{teamId}/appData/{key}
function teamDoc(key: string) {
  return doc(db!, 'teams', TEAM_ID, 'appData', key);
}

// ── ユーザー情報（save 時に updatedBy として付与）────────────────

let _currentUser: { uid: string; displayName: string } | null = null;

/** ログイン/ログアウト時に呼ぶ。以降の save に updatedBy が付与される。 */
export function setCurrentUser(
  user: { uid: string; displayName: string } | null,
): void {
  _currentUser = user;
}

// ── 最終更新メタ情報 ──────────────────────────────────────────

export interface DocMeta {
  updatedAt: number;
  updatedBy: { uid: string; displayName: string } | null;
}

// ── 内部ヘルパー ──────────────────────────────────────────────

function save<T>(key: string, items: T[]): Promise<void> {
  if (!db) {
    console.debug(`[FS] save(${key}) skip — db=null`);
    return Promise.resolve();
  }
  console.debug(`[FS] write teams/${TEAM_ID}/appData/${key} count=${(items as unknown[]).length}`);
  const data: Record<string, unknown> = { items, updatedAt: Date.now() };
  if (_currentUser) data.updatedBy = _currentUser;
  return setDoc(teamDoc(key), data);
}

/**
 * @param onFirstSnapshot ドキュメントの有無に関わらず初回 snapshot 到着時に 1 度だけ呼ばれる。
 *   これが呼ばれるまでは書き込みをブロックすることで、ログイン直後の上書きを防ぐ。
 * @param onMeta サーバー確定 snapshot の updatedAt/updatedBy を通知する。
 *   保存競合検知（serverUpdatedAt）とヘッダーの「最終更新」表示の両方がこれを使う。
 *   以前は「最終更新」用に subscribeLastActivity が同じ 3 ドキュメントを別途購読していたが、
 *   リスナー重複のため onMeta に統合した。
 */
function subscribe<T>(
  key: string,
  onData: (items: T[]) => void,
  onFirstSnapshot: () => void,
  onMeta?: (meta: DocMeta) => void,
): Unsubscribe {
  if (!db) {
    console.debug(`[FS] subscribe(${key}) skip — db=null`);
    onFirstSnapshot();
    return () => {};
  }
  console.debug(`[FS] subscribe start — teams/${TEAM_ID}/appData/${key}`);
  let isFirst = true;

  return onSnapshot(
    teamDoc(key),
    (snap) => {
      console.debug(
        `[FS] snapshot(${key}) exists=${snap.exists()} pending=${snap.metadata.hasPendingWrites}`,
      );
      if (snap.metadata.hasPendingWrites) return;

      if (isFirst) { isFirst = false; onFirstSnapshot(); }
      if (snap.exists()) {
        const data = snap.data();
        if (onMeta && typeof data.updatedAt === 'number') {
          onMeta({ updatedAt: data.updatedAt, updatedBy: data.updatedBy ?? null });
        }
        onData((data.items ?? []) as T[]);
      }
    },
    (err) => {
      console.debug(`[FS] error(${key}):`, err.code, err.message);
      if (isFirst) { isFirst = false; onFirstSnapshot(); }
    },
  );
}

// ── 公開 API ─────────────────────────────────────────────────

export const firestoreService = {
  subscribeStaff: (
    cb: (items: Staff[]) => void,
    onFirst: () => void,
    onMeta?: (meta: DocMeta) => void,
  ): Unsubscribe => subscribe<Staff>('staff', cb, onFirst, onMeta),

  subscribeWorkSites: (
    cb: (items: WorkSite[]) => void,
    onFirst: () => void,
    onMeta?: (meta: DocMeta) => void,
  ): Unsubscribe => subscribe<WorkSite>('workSites', cb, onFirst, onMeta),

  subscribeAssignments: (
    cb: (items: ShiftAssignment[]) => void,
    onFirst: () => void,
    onMeta?: (meta: DocMeta) => void,
  ): Unsubscribe => subscribe<ShiftAssignment>('assignments', cb, onFirst, onMeta),

  subscribeImportLogs: (
    cb: (items: ImportLog[]) => void,
    onFirst: () => void,
    onMeta?: (meta: DocMeta) => void,
  ): Unsubscribe => subscribe<ImportLog>('importLogs', cb, onFirst, onMeta),

  saveStaff:       (items: Staff[]): Promise<void>           => save('staff',       items),
  saveWorkSites:   (items: WorkSite[]): Promise<void>        => save('workSites',   items),
  saveAssignments: (items: ShiftAssignment[]): Promise<void> => save('assignments', items),
  saveImportLogs:  (items: ImportLog[]): Promise<void>       => save('importLogs',  items),
};
