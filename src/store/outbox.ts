// 共有データへの「まだ届いたと確認できていない変更」の控え（ブラウザの localStorage）。
//
// 何のためか:
//   共有データは Firestore を正とし、端末に別のコピーは持たない。ただし入力のたびに送ると回数が多すぎるので、
//   入力がいったん止まるのを少し待ってから送る。その「待っている間」に画面を閉じても入力が消えないよう、
//   変更のたびに、ここへすぐ（同期的に）書いておく。次に開いたときに残っていれば、送り直す。
//   送り直す前に、共有側のいまの状態を確かめる（sharedSession.ts の adopt）:
//     - 既に届いていた            → 何もしない
//     - 誰も触っていない          → 送り直す（必ず「既にあるものの更新」として。削除されたものは復活しない）
//     - ほかの人が変更していた・削除されていた → 自動では上書きしない。利用者に表示し、案件は
//       「この端末だけのデータ」に控えとして残す（古い内容で、新しい変更を巻き戻さないため）
import { genId } from '../domain/util';
import { TEAM_ID } from './paths';
import { Body } from './sharedLogic';

const PREFIX = 'kkl_outbox_v1:';

export interface OutboxEntry {
  uid: string;
  coll: string;
  id: string;
  kind: 'create' | 'update' | 'delete';
  /** 変えた項目の名前（create は全項目） */
  fields: string[];
  /** 変更後の中身の全体（管理用の項目は含まない）。容量が足りないときは変えた項目だけ（partial） */
  body: Body | null;
  partial?: boolean;
  /** 表示名（例: 案件名） */
  label: string;
  /**
   * この一連の変更を始めたときに、共有側のドキュメントに付いていた印（rev）。印の無いドキュメントは ''、
   * 共有側にまだ無かった（この端末で作った）場合は null。
   * 次に開いたとき、共有側の印がこれと同じなら「誰も触っていない＝送り直してよい」と分かる。
   */
  baseRev?: string | null;
  /** この一連の変更で、送信した書き込みの印（送った順） */
  revs?: string[];
  /** 最後に送信したあとにも、まだ送っていない変更がある */
  dirty?: boolean;
  /** この控えを書いた画面（タブ）の印 */
  sid: string;
  at: number;
}

/** この画面（タブ）の印。開いている間だけ有効 */
export const SID = genId();
const lockName = (sid: string) => `kkl-tab-${sid}`;

// この画面が開いている間、名前付きのロックを持ち続ける（ほかの画面が「まだ開いている」と分かるようにするため）
try {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    void navigator.locks.request(lockName(SID), () => new Promise<void>(() => { /* 画面が閉じるまで保持 */ }));
  }
} catch { /* ロックが使えない環境では、時刻で判断する（orphans） */ }

const keyOf = (uid: string, coll: string, id: string) => `${PREFIX}${TEAM_ID}:${uid}:${coll}/${id}`;

export function putOutbox(e: Omit<OutboxEntry, 'sid' | 'at'>): boolean {
  const entry: OutboxEntry = { ...e, sid: SID, at: Date.now() };
  const key = keyOf(e.uid, e.coll, e.id);
  try {
    localStorage.setItem(key, JSON.stringify(entry));
    return true;
  } catch {
    // 容量が足りない: 変えた項目だけにして、もう一度だけ試す（送り直しはできるが、控えは一部になる）
    try {
      const slim: Body = {};
      for (const f of e.fields) if (e.body && f in e.body) slim[f] = e.body[f];
      localStorage.setItem(key, JSON.stringify({ ...entry, body: e.body ? slim : null, partial: true }));
      return true;
    } catch {
      return false;
    }
  }
}

export function removeOutbox(uid: string, coll: string, id: string): void {
  try { localStorage.removeItem(keyOf(uid, coll, id)); } catch { /* 何もしない */ }
}

function entriesOf(uid: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  const prefix = `${PREFIX}${TEAM_ID}:${uid}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const e = JSON.parse(localStorage.getItem(k) ?? 'null') as OutboxEntry | null;
        if (e && e.coll && e.id && Array.isArray(e.fields)) out.push(e);
        else localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
  } catch { /* localStorage が使えない */ }
  return out.sort((a, b) => a.at - b.at);
}

/** ほかの画面も含めて、控えが残っている件数（ログアウト前の確認に使う） */
export function countOutbox(uid: string): number {
  return entriesOf(uid).length;
}

/**
 * 引き取りの候補になる控え。
 *   - ほかの画面が書いたもの … その画面がもう開いていなければ対象（前回、送る前に閉じられたもの）。
 *     まだ開いている画面が送る途中のものは含めない（二重に送って順序が入れ替わるのを避ける）
 *   - この画面が書いたもの … すべて返す。いま編集・送信中のものかどうかは呼び出し側が見分ける
 *     （この画面でログアウトして入り直した場合など、前のログイン中に残したものを拾うため）
 */
export async function orphans(uid: string): Promise<OutboxEntry[]> {
  const all = entriesOf(uid);
  if (all.length === 0) return [];
  let alive: Set<string> | null = null;
  try {
    if (navigator.locks?.query) alive = new Set(((await navigator.locks.query()).held ?? []).map((l) => l.name ?? ''));
  } catch { alive = null; }
  const now = Date.now();
  return all.filter((e) => e.sid === SID || (alive ? !alive.has(lockName(e.sid)) : now - e.at > 15000));
}

/** この利用者の控えをすべて捨てる（ログアウトで未送信の変更を破棄するとき） */
export function clearOutbox(uid: string): void {
  for (const e of entriesOf(uid)) removeOutbox(uid, e.coll, e.id);
}
