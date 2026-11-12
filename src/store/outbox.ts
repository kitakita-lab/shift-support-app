// 共有データへの「まだ届いたと確認できていない変更」の控え（ブラウザの localStorage）。
//
// 何のためか:
//   共有データは Firestore を正とし、端末に別のコピーは持たない。ただし入力のたびに送ると回数が多すぎるので、
//   入力がいったん止まるのを少し待ってから送る。その「待っている間」に画面を閉じても入力が消えないよう、
//   変更のたびに、ここへすぐ（同期的に）書いておく。届いたと確認できたら消す。
//
// 決まり:
//   - 控えは「画面（タブ）× ドキュメント」ごとに 1 つ。**開いているほかの画面の控えを上書きしたり消したりしない**
//     （同じ案件を 2 つの画面で編集していても、互いの控えを壊さない）。
//   - 書いた画面がもう無い控え（前回の残り）は、開いている画面が引き取る。引き取った変更は画面に重ねて表示し、
//     未送信として数え、**共有側のいまの状態を確かめてから**送る（sharedSession.ts の「引き取り」）:
//       既に届いていた → 何もしない／誰も触っていない → 送る（必ず「既にあるものの更新」として）／
//       ほかの人が変更していた・削除されていた → 上書きしない。表示し、案件は「この端末だけのデータ」に控えを残す
//   - 引き取りは、同時に 1 つの画面だけが行う（2 つの画面が同じ控えを二重に引き取らない）。
import { genId } from '../domain/util';
import { TEAM_ID } from './paths';
import { Body } from './sharedLogic';

const PREFIX = 'kkl_outbox_v2:';

export interface OutboxEntry {
  uid: string;
  coll: string;
  id: string;
  kind: 'create' | 'update' | 'delete';
  /** 変えた項目の名前（create は全項目） */
  fields: string[];
  /** 変更後の中身の全体（rev・updatedBy は含まない）。容量が足りないときは変えた項目だけ（partial） */
  body: Body | null;
  partial?: boolean;
  /** 表示名（例: 案件「◯◯」） */
  label: string;
  /**
   * この一連の変更を始めたときに、共有側のドキュメントに付いていた印（rev）。印の無いドキュメントは ''、
   * 共有側にまだ無かった（この端末で作った）場合は null。
   * 次に開いたとき、共有側の印がこれと同じなら「誰も触っていない＝送ってよい」と分かる。
   */
  baseRev: string | null;
  /** この一連の変更で、送信した書き込みの印（送った順） */
  revs: string[];
  /**
   * 共有側の印がこのどれかなら「この控えの変更を始めてから、誰も触っていない」と言える印の一覧。
   * 省略時は baseRev と revs（＝この控え自身の履歴）。前回の残りを引き取って書き直した控えでは、引き取った残りの履歴だけを入れる
   * （その上に重ねた新しい編集や、別の残りの基準の印を混ぜない。混ぜると、古い変更が「安全」と判定されてしまう）。
   */
  safe?: string[];
  /** 最後に送信したあとにも、まだ送っていない変更がある */
  dirty: boolean;
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
} catch { /* ロックが使えない環境では、開いている画面を見分けられない（aliveTabs が null を返す） */ }

const prefixOf = (uid: string) => `${PREFIX}${TEAM_ID}:${uid}:`;
const keyOf = (uid: string, sid: string, coll: string, id: string) => `${prefixOf(uid)}${sid}:${coll}/${id}`;

/** この画面の控えを書く。保存できなかったら false（呼び出し側が、利用者に知らせる） */
export function putOutbox(e: Omit<OutboxEntry, 'sid' | 'at'>): boolean {
  const entry: OutboxEntry = { ...e, sid: SID, at: Date.now() };
  const key = keyOf(e.uid, SID, e.coll, e.id);
  try {
    localStorage.setItem(key, JSON.stringify(entry));
    return true;
  } catch {
    // 容量が足りない: 変えた項目だけにして、もう一度だけ試す（送ることはできるが、控えの全文は残せない）
    try {
      const slim: Body = {};
      for (const f of e.fields) if (e.body && f in e.body) slim[f] = e.body[f];
      localStorage.setItem(key, JSON.stringify({ ...entry, body: e.body ? slim : null, partial: true }));
      return true;
    } catch {
      return false;                              // どちらも書けない: この変更は、画面を閉じると控えからは復元できない
    }
  }
}

/** この画面の控えを消す（ほかの画面の控えには触れない） */
export function removeOutbox(uid: string, coll: string, id: string): void {
  try { localStorage.removeItem(keyOf(uid, SID, coll, id)); } catch { /* 何もしない */ }
}
/** 引き取った控え（ほかの画面・前のログインで書かれたもの）を消す */
export function removeEntry(e: OutboxEntry): void {
  try { localStorage.removeItem(keyOf(e.uid, e.sid, e.coll, e.id)); } catch { /* 何もしない */ }
}

function entriesOf(uid: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  const prefix = prefixOf(uid);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const e = JSON.parse(localStorage.getItem(k) ?? 'null') as OutboxEntry | null;
        if (e && e.coll && e.id && e.sid && Array.isArray(e.fields)) {
          const entry: OutboxEntry = { ...e, revs: Array.isArray(e.revs) ? e.revs : [], baseRev: e.baseRev ?? null, dirty: e.dirty !== false };
          if (!Array.isArray(e.safe)) delete entry.safe;
          out.push(entry);
        } else {
          localStorage.removeItem(k);
        }
      } catch { localStorage.removeItem(k); }
    }
  } catch { /* localStorage が使えない */ }
  return out.sort((a, b) => a.at - b.at);
}

/** 共有側の印がこの中にあれば、「この控えの変更を始めてから、誰も触っていない」と言える */
export function safeRevs(e: OutboxEntry): string[] {
  return e.safe ?? [...(e.baseRev !== null ? [e.baseRev] : []), ...e.revs];
}

/** ほかの画面も含めて、控えが残っている件数（ログアウト前の確認に使う） */
export function countOutbox(uid: string): number {
  return entriesOf(uid).length;
}
/** この利用者の控えのすべて（書かれた順。ほかの画面の分も含む） */
export function allEntries(uid: string): OutboxEntry[] {
  return entriesOf(uid);
}

/**
 * この画面が以前のログインで書いた控えを、「前回の残り」に回す（控えを書いた画面の印を、使われていないものに付け替える）。
 * ログインのたびに、同期を始める前に呼ぶ。こうしておくと、いまのログインで書く控え（編集・送信中のもの）と、
 * 前回の残りとを、取り違えない。
 */
export function retireOwn(uid: string): void {
  for (const e of entriesOf(uid)) {
    if (e.sid !== SID) continue;
    const moved: OutboxEntry = { ...e, sid: `old-${genId()}` };
    try {
      localStorage.setItem(keyOf(uid, moved.sid, e.coll, e.id), JSON.stringify(moved));
      localStorage.removeItem(keyOf(uid, SID, e.coll, e.id));
    } catch { /* 書けなければ、そのまま（この画面の控えとして残る） */ }
  }
}

/**
 * 引き取りの候補（書かれた順）: この画面以外が書いた控え。
 * 書いた画面がまだ開いているかどうかは、aliveTabs で見分ける（開いている画面の控えは引き取らない）。
 */
export function leftovers(uid: string): OutboxEntry[] {
  return entriesOf(uid).filter((e) => e.sid !== SID);
}

/**
 * いま開いている画面（タブ）の印の一覧。見分けられない環境（Web Locks が無い）では null。
 * 呼び出し側は、null のとき「ほかの画面が開いているかもしれない」として安全側に扱う。
 */
export async function aliveTabs(): Promise<Set<string> | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.locks?.query) return null;
    const held = (await navigator.locks.query()).held ?? [];
    return new Set(held.map((l) => l.name ?? '').filter((n) => n.startsWith('kkl-tab-')).map((n) => n.slice('kkl-tab-'.length)));
  } catch {
    return null;
  }
}
/** この画面のほかに、開いている画面があるか（見分けられない環境では「ある」とみなす） */
export async function otherTabsOpen(): Promise<boolean> {
  const alive = await aliveTabs();
  if (!alive) return true;
  return [...alive].some((sid) => sid !== SID);
}

/**
 * 控えの引き取りを、同時に 1 つの画面だけが行うようにする。ほかの画面が引き取り中なら、何もせず false を返す
 * （次の機会に、残っていれば引き取る）。Web Locks が無い環境では、そのまま実行する。
 */
export async function exclusive(fn: () => Promise<void> | void): Promise<boolean> {
  let locks: LockManager | undefined;
  try { locks = typeof navigator !== 'undefined' ? navigator.locks : undefined; } catch { locks = undefined; }
  if (!locks?.request) { await fn(); return true; }
  return (await locks.request('kkl-outbox-adopt', { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  })) as boolean;
}

/** この利用者の控えをすべて捨てる（ログアウトで未送信の変更を破棄するとき。ほかの画面の分も含む） */
export function clearOutbox(uid: string): void {
  for (const e of entriesOf(uid)) removeEntry(e);
}
