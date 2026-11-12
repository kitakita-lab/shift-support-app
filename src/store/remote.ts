// 共有データ（Firestore）の入出力。置き場所は paths.ts だけが組み立てる（ここには場所の名前を直接書かない）。
//
// 書き込みの原則:
//   - 新しく作るもの … 「作成」（setDoc）
//   - 既にあるものの変更 … 「更新」（updateDoc）。相手が削除済みなら Firestore が拒否するので、消したものが復活しない
//   - 削除 … deleteDoc
//   - 共有側のいまの状態を確かめてから書くもの（前回の残りの送信・共有へのコピー・名簿の変更・移行）… トランザクション。
//     つながっていなければその場で失敗し、端末内の送信待ちには残らない
// V1・V2 の形式の場所（workshopData・workshopProjects）は読むだけで、書き込む処理は作らない。
import {
  DocumentReference, FirestoreError, Transaction, collection, deleteDoc, deleteField, doc, getDocFromCache, getDocFromServer,
  getDocsFromServer, onSnapshot, runTransaction, setDoc, updateDoc, waitForPendingWrites,
} from 'firebase/firestore';
import { getDb, isEmulator } from '../firebase';
import {
  FORMAT_VERSION, LEGACY_DATA_COLL, LEGACY_PROJECT_COLL, MASTER_KEYS, MEMBER_COLL, META_COLL, META_DOC,
  PROBE_COLL, PROBE_DOC, collPath, docPath,
} from './paths';
import { Body, LegacyData, PlannedDoc, RecoveryVerdict, isValidMemberEmail, normalizeEmail } from './sharedLogic';

export interface Actor { uid: string; displayName: string }
type Unsub = () => void;

function db() {
  const d = getDb();
  if (!d) throw new Error('Firebase が設定されていません');
  return d;
}
const dref = (coll: string, id: string) => doc(db(), ...docPath(coll, id));
const cref = (coll: string) => collection(db(), ...collPath(coll));

export const errorCode = (e: unknown): string => (e instanceof FirestoreError ? e.code : (e as { code?: string })?.code ?? 'unknown');

/** 一定時間で打ち切る（圏外だと、サーバーの応答を待つ処理が終わらないため） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── 購読 ───────────────────────────────────────────────────
export interface DocChange { id: string; body: Body | null; pending: boolean }
export interface SnapInfo { fromCache: boolean }

/** コレクションを購読する。届くのは変わったドキュメントだけ（body が null は「無くなった」） */
export function watchCollection(
  coll: string, onNext: (changes: DocChange[], info: SnapInfo) => void, onError: (code: string) => void,
): Unsub {
  return onSnapshot(
    cref(coll), { includeMetadataChanges: true },
    (snap) => onNext(
      snap.docChanges({ includeMetadataChanges: true }).map((c) => ({
        id: c.doc.id,
        body: c.type === 'removed' ? null : (c.doc.data() as Body),
        pending: c.type !== 'removed' && c.doc.metadata.hasPendingWrites,
      })),
      { fromCache: snap.metadata.fromCache },
    ),
    (err) => onError(err.code),
  );
}

export function watchDoc(coll: string, id: string, onNext: (body: Body | null) => void, onError: (code: string) => void): Unsub {
  return onSnapshot(dref(coll, id), (snap) => onNext(snap.exists() ? (snap.data() as Body) : null), (err) => onError(err.code));
}

// ── 書き込み（1 件ずつ。圏外なら送信待ちになり、つながったときに送られる） ─────────
/** 最上位が undefined の項目は「その項目を消す」として送る（入れ子の undefined は SDK が取り除く） */
function forUpdate(patch: Body): Body {
  const out: Body = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? deleteField() : v;
  return out;
}
export const createDoc = (coll: string, id: string, body: Body): Promise<void> => setDoc(dref(coll, id), body);
export const patchDoc = (coll: string, id: string, patch: Body): Promise<void> => updateDoc(dref(coll, id), forUpdate(patch));
export const removeDoc = (coll: string, id: string): Promise<void> => deleteDoc(dref(coll, id));
/** 送信待ちの書き込みが、すべてサーバーに届く（または拒否される）まで待つ */
export const waitPending = (): Promise<void> => waitForPendingWrites(db());

// ── 確かめてから書く（トランザクション。圏外ならその場で失敗し、送信待ちに残らない） ─────────
/**
 * 時間を区切って行うトランザクション。失敗（時間切れを含む）を呼び出し側に知らせたあとは、SDK のやり直しも止める
 * （知らせたあとで、あらためて読み直して書く、ということが起きないように）。
 * 止められないのは、時間切れの瞬間に、もう送ってしまっていた書き込みだけ（届いたかどうかは、あとで読んで確かめる）。
 */
function bounded<T>(ms: number, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let over = false;
  const run = runTransaction(db(), async (tx) => {
    const stop = () => { if (over) throw Object.assign(new Error('timeout'), { code: 'timeout' }); };   // FirestoreError でない失敗は、SDK がやり直さない
    stop();
    const out = await fn(tx);
    stop();
    return out;
  });
  return withTimeout(run, ms).catch((e) => { over = true; throw e; });
}
/**
 * 前回の残りを送る。「共有側のいまの状態を確かめる」ことと「書く」ことを、1 つのトランザクションで行う。
 *   - judge が 'send' を返したときだけ、patch を「更新」として書く。それ以外は何も書かない。
 *   - 読んでから書くまでに共有側が変わったら、トランザクションはやり直しになり、judge がもう一度呼ばれる
 *     （確かめたあとで届いたほかの人の変更を、古い内容で上書きしない）。
 *   - つながっていなければ、その場で失敗する。端末内の送信待ちには残らない
 *     （確かめた結果が古くなってから書き込みが送られる、ということが起きない）。
 * 返すのは、最後に読んだ共有側の内容と、その判定。
 *
 * 注意: この書き込みは、端末内の送信待ちの列を通らない。
 *   - 送信待ちに、同じドキュメントへの古い書き込みが残っている間に呼ぶと、その古い書き込みがあとから届いて、順番が入れ替わる。
 *     呼ぶ側は、送信待ちが空になってから呼ぶ（sharedSession.ts の resolveAdopted）。
 *   - 書いた内容は、購読には少し遅れて届く（端末内の控えは、それまで古い内容のまま）。
 *     呼ぶ側は、続けて同じドキュメントへふつうの書き込みを送る前に、readDocServer で控えを最新にする。
 */
export function recoverDoc(
  coll: string, id: string, patch: Body, judge: (server: Body | null) => RecoveryVerdict,
): Promise<{ verdict: RecoveryVerdict; server: Body | null }> {
  return bounded(20000, async (tx) => {
    const ref = dref(coll, id);
    const snap = await tx.get(ref);
    const server = snap.exists() ? (snap.data() as Body) : null;
    const verdict = judge(server);
    if (verdict === 'send') tx.update(ref, forUpdate(patch));
    return { verdict, server };
  });
}
/**
 * まだ無いものだけを作る（「共有へコピー」用）。「無いことを確かめる」ことと「作る」ことを、1 つのトランザクションで行う。
 * 既にあるものは上書きしない（確かめたあとで、ほかの人が同じ ID のものを作っていても、上書きしない）。
 * つながっていなければその場で失敗し、送信待ちに残らない。既にあったもの（作らなかったもの）の場所を返す。
 * 1 回に扱う件数を少なくしている理由は、writeAllGuarded と同じ（ルールが名簿を見る回数の上限）。
 * 途中で失敗した場合、それより前の回のものは作られている（呼ぶ側は、欠けても困らないものを先に並べる）。
 */
export async function createMissing(docs: PlannedDoc[]): Promise<string[]> {
  const MAX_DOCS = 8;
  const found: string[] = [];
  for (let i = 0; i < docs.length; i += MAX_DOCS) {
    const chunk = docs.slice(i, i + MAX_DOCS);
    found.push(...await bounded(30000, async (tx) => {
      // 読み取りは、すべて書き込みより前に行う（トランザクションの決まり）
      const snaps = await Promise.all(chunk.map((d) => tx.get(dref(d.coll, d.id))));
      const existing: string[] = [];
      chunk.forEach((d, j) => {
        if (snaps[j].exists()) existing.push(`${d.coll}/${d.id}`);
        else tx.set(dref(d.coll, d.id), d.body);
      });
      return existing;
    }));
  }
  return found;
}

// ── 読み取り（サーバーから。圏外なら失敗する） ─────────────────────────
export async function readDocServer(coll: string, id: string): Promise<Body | null> {
  const s = await getDocFromServer(dref(coll, id));
  return s.exists() ? (s.data() as Body) : null;
}
export async function readDocCache(coll: string, id: string): Promise<Body | null | undefined> {
  try {
    const s = await getDocFromCache(dref(coll, id));
    return s.exists() ? (s.data() as Body) : null;
  } catch {
    return undefined;                            // キャッシュに無い（分からない）
  }
}
export async function readCollServer(coll: string): Promise<{ id: string; body: Body }[]> {
  return (await getDocsFromServer(cref(coll))).docs.map((d) => ({ id: d.id, body: d.data() as Body }));
}

// ── メンバー制 ─────────────────────────────────────────────
export type Role = 'owner' | 'member' | 'open' | 'none';
export interface Access {
  /** owner＝管理者／member＝メンバー／open＝名簿に無いが、ルールが制限していないので使える／none＝使えない */
  role: Role;
  /** ルールが名簿で制限しているか */
  enforced: boolean;
}

/**
 * このアカウントが共有データを使えるかを、サーバーに確かめる。
 * アプリは、現在のルール（ログインしていれば誰でも可）でも、メンバー制のルールでも動く。
 * email は小文字にそろえたもの（normalizeEmail）。
 */
export async function checkAccess(email: string): Promise<Access> {
  let member: Body | null = null;
  let readable = true;
  try {
    member = await readDocServer(MEMBER_COLL, email);
  } catch (e) {
    if (errorCode(e) !== 'permission-denied') throw e;
    readable = false;                             // 自分の登録状況すら読めない（メールが未確認のアカウントなど）
  }
  let enforced = true;
  try {
    await readDocServer(PROBE_COLL, PROBE_DOC);
    enforced = false;                             // 何も許可されないはずの場所が読めた＝名簿による制限が無い
  } catch (e) {
    if (errorCode(e) !== 'permission-denied') throw e;
  }
  if (member) return { role: member.role === 'owner' ? 'owner' : 'member', enforced };
  return { role: !enforced && readable ? 'open' : 'none', enforced };
}

export interface Member { email: string; role: 'owner' | 'member'; addedAt: number; addedBy: string }
export async function listMembers(): Promise<Member[]> {
  return (await readCollServer(MEMBER_COLL))
    .map((d) => ({
      email: d.id, role: d.body.role === 'owner' ? ('owner' as const) : ('member' as const),
      addedAt: Number(d.body.addedAt) || 0, addedBy: String(d.body.addedBy ?? ''),
    }))
    .sort((a, b) => a.addedAt - b.addedAt || a.email.localeCompare(b.email));
}
/** 「最後の管理者」を、管理者でなくそうとした */
export class LastOwnerError extends Error {
  code = 'last-owner';
  constructor() { super('last-owner'); }
}
/**
 * 名簿の変更（登録・役割の変更・削除）。next が null なら削除。トランザクションで書く。
 *   - つながっていなければその場で失敗し、送信待ちに残らない
 *     （「失敗」と表示したあとで、後日つながったときに適用される、ということが起きない）。
 *   - 有効な管理者を「管理者でなくする」変更（降格・削除）は、**同じトランザクションの中で**、ほかの有効な管理者（others）が
 *     いまも管理者であることを共有側から読んで確かめてから書く。画面が持っている一覧では判定しない。
 *     確かめたドキュメントが書き込みまでに変わると、トランザクションはやり直しになるので、
 *     2 人の管理者が同時に自分を外しても、後から届いたほうは「管理者がいなくなる」として拒否される（LastOwnerError）。
 * others は、呼び出し側がサーバーから読み直した名簿のうち、対象以外の有効な管理者のメールアドレス。
 */
function changeMember(email: string, next: { role: 'owner' | 'member'; addedAt: number; addedBy: string } | null, others: string[]): Promise<void> {
  return withTimeout(runTransaction(db(), async (tx) => {
    const ref = dref(MEMBER_COLL, email);
    const cur = await tx.get(ref);
    // 照合に使われる登録（キーが小文字のメールアドレス）の管理者だけが、実際の管理者
    const wasOwner = cur.exists() && (cur.data() as Body).role === 'owner' && email === normalizeEmail(email) && isValidMemberEmail(email);
    if (wasOwner && next?.role !== 'owner') {
      let remains = false;
      for (const other of others) {
        if (other === email) continue;
        const o = await tx.get(dref(MEMBER_COLL, other));
        if (o.exists() && (o.data() as Body).role === 'owner') { remains = true; break; }
      }
      if (!remains) throw new LastOwnerError();
    }
    if (next) tx.set(ref, next);
    else tx.delete(ref);
  }), 20000);
}
/** 名簿に登録する・役割を変える（email は小文字にそろえたもの） */
export function putMember(email: string, role: 'owner' | 'member', addedBy: string, addedAt: number, others: string[]): Promise<void> {
  return changeMember(email, { role, addedAt, addedBy }, others);
}
export function deleteMember(email: string, others: string[]): Promise<void> {
  return changeMember(email, null, others);
}

// ── 形式の情報（wsMeta/state） ────────────────────────────────
export const readMetaServer = (): Promise<Body | null> => readDocServer(META_COLL, META_DOC);
export const readMetaCache = (): Promise<Body | null | undefined> => readDocCache(META_COLL, META_DOC);
export const watchMeta = (onNext: (body: Body | null) => void, onError: (code: string) => void): Unsub =>
  watchDoc(META_COLL, META_DOC, onNext, onError);

/**
 * 共有データを新しく使い始める（旧形式から移さない場合）。初期値のパーツなどを入れ、「使える状態」の印を付ける。
 * 2 台が同時に始めても 1 回だけ行われる。既にあるものは上書きしない。
 */
// （初期値は 14 件。上の「見てよい回数」の上限に対して、これ以上大きく増やす場合は、分けて書くこと）
export async function initFresh(defaults: PlannedDoc[], source: string, actor: Actor): Promise<'created' | 'exists'> {
  return withTimeout(runTransaction(db(), async (tx) => {
    const meta = dref(META_COLL, META_DOC);
    if ((await tx.get(meta)).exists()) return 'exists' as const;
    const refs = defaults.map((d) => dref(d.coll, d.id));
    const missing: boolean[] = [];
    for (const r of refs) missing.push(!(await tx.get(r)).exists());
    defaults.forEach((d, i) => { if (missing[i]) tx.set(refs[i], d.body); });
    tx.set(meta, { formatVersion: FORMAT_VERSION, status: 'done', source, createdAt: Date.now(), createdBy: actor });
    return 'created' as const;
  }), 30000);
}

// ── 旧形式（V1・V2）からの移行 ─────────────────────────────────
/** 旧形式のデータをすべて読む（読むだけ） */
export async function readLegacy(): Promise<LegacyData> {
  const masters = {} as LegacyData['masters'];
  for (const key of MASTER_KEYS) masters[key] = await readDocServer(LEGACY_DATA_COLL, key);
  const projects = (await readCollServer(LEGACY_PROJECT_COLL)).map((d) => ({ id: d.id, doc: d.body }));
  // 旧形式には並び順が無い（読むたびに ID 順）。作成が古い順に近づけるため、最終更新の古い順にそろえる
  projects.sort((a, b) => (Number(a.doc.updatedAt) || 0) - (Number(b.doc.updatedAt) || 0) || a.id.localeCompare(b.id));
  return { masters, projects };
}

/**
 * 移行の開始を記録する。既に「移行済み」なら何もせず done を返す。
 * やり直しのときは、前回と同じバックアップ名を使う（バックアップが増えていかない）。
 */
export async function beginMigration(newBackupId: string, actor: Actor): Promise<{ backupId: string; attempt: number } | 'done'> {
  return withTimeout(runTransaction(db(), async (tx) => {
    const ref = dref(META_COLL, META_DOC);
    const s = await tx.get(ref);
    if (!s.exists()) {
      tx.set(ref, { formatVersion: FORMAT_VERSION, status: 'running', source: 'legacy', backupId: newBackupId, attempt: 1, startedAt: Date.now(), startedBy: actor });
      return { backupId: newBackupId, attempt: 1 };
    }
    const m = s.data() as Body;
    if (m.status === 'done') return 'done' as const;
    const backupId = typeof m.backupId === 'string' && m.backupId ? m.backupId : newBackupId;
    const attempt = (Number(m.attempt) || 1) + 1;
    tx.update(ref, { status: 'running', backupId, attempt, startedAt: Date.now(), startedBy: actor, error: deleteField() });
    return { backupId, attempt };
  }), 30000);
}
/** この試行が、もう有効でない（ほかの端末がやり直した・完了した・印が無い）ときに投げる */
export class MigrationSuperseded extends Error {
  code = 'superseded';
  constructor() { super('superseded'); }
}
/**
 * 移行の書き込みは、すべて「いまも自分の試行が有効か」を確かめるトランザクションで行う。
 *   - 形式の情報が running で、試行番号が自分のものであるときだけ書く。そうでなければ何も書かずに中止する。
 *     → 古い試行（途中で止まった・時間切れになった）や、並行する別の端末の試行が、
 *       完了後のデータを移行前の内容で上書きすることがない。
 *   - トランザクションは、つながっていなければその場で失敗し、端末内の送信待ちに残らない
 *     （後日つながったときに、古い書き込みが送られることがない）。
 */
function guarded<T>(attempt: number, body: (tx: Transaction, meta: DocumentReference) => T): Promise<T> {
  return runTransaction(db(), async (tx) => {
    const ref = dref(META_COLL, META_DOC);
    const s = await tx.get(ref);
    const m = s.exists() ? (s.data() as Body) : null;
    if (!m || m.status !== 'running' || Number(m.attempt) !== attempt) throw new MigrationSuperseded();
    return body(tx, ref);
  });
}
/** 移行の結果を記録する（done＝移行済みの印／failed＝失敗の記録）。自分の試行が有効なときだけ */
export function endMigration(attempt: number, fields: Body): Promise<void> {
  return withTimeout(guarded(attempt, (tx, ref) => { tx.update(ref, forUpdate(fields)); }), 30000);
}

/**
 * まとめて書き込む（移行用）。置き場所（コレクション）ごとに区切り、さらに 1 回に送る量を抑えて分割する。
 * 途中の 1 回が拒否されたら、そこで止まって例外を投げる（それより前の分は書かれたまま残る。
 * やり直せば同じ場所に上書きされるだけなので、重複しない）。
 */
export async function writeAllGuarded(attempt: number, docs: PlannedDoc[], onProgress?: (done: number, total: number) => void): Promise<void> {
  // 1 回に書く件数は少なくする。メンバー制のルールは、書き込み 1 件ごとに名簿を見る（最大 2 回）。
  // ルールが 1 回のまとめ書きで「ほかのドキュメントを見てよい回数」には上限（20 回）があり、
  // 同じ名簿を何度見ても 1 回と数えられるかどうかは保証されていないので、最悪の場合でも収まる件数にしておく
  const MAX_DOCS = 8, MAX_BYTES = 1_500_000;
  let i = 0;
  while (i < docs.length) {
    const chunk: PlannedDoc[] = [];
    const coll = docs[i].coll;
    let bytes = 0;
    while (i < docs.length && chunk.length < MAX_DOCS && docs[i].coll === coll) {
      const size = JSON.stringify(docs[i].body).length * 2;
      if (chunk.length > 0 && bytes + size > MAX_BYTES) break;
      chunk.push(docs[i]);
      bytes += size; i += 1;
    }
    await withTimeout(guarded(attempt, (tx) => { for (const d of chunk) tx.set(dref(d.coll, d.id), d.body); }), 45000);
    onProgress?.(i, docs.length);
  }
}

// ── 検証用（ローカルのエミュレータにつないでいるときだけ） ───────────────────
// 「古い試行は書けない」ことを、e2e/sync のテストが実物の Firestore（エミュレータ）で確かめるための入口。
// 本番・プレビューのビルドには含まれない（isEmulator が常に false になり、この部分は取り除かれる）。
if (isEmulator) {
  const w = window as unknown as { __kkl?: Record<string, unknown> };
  w.__kkl = { ...(w.__kkl ?? {}), migration: { begin: beginMigration, end: endMigration, writeAll: writeAllGuarded } };
}
