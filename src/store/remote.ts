// 共有データ（Firestore）の入出力。置き場所は paths.ts だけが組み立てる（ここには場所の名前を直接書かない）。
//
// 書き込みの原則:
//   - 新しく作るもの … 「作成」（setDoc）
//   - 既にあるものの変更 … 「更新」（updateDoc）。相手が削除済みなら Firestore が拒否するので、消したものが復活しない
//   - 削除 … deleteDoc
// V1・V2 の形式の場所（workshopData・workshopProjects）は読むだけで、書き込む処理は作らない。
import {
  FirestoreError, collection, deleteDoc, deleteField, doc, getDocFromCache, getDocFromServer, getDocsFromServer,
  onSnapshot, runTransaction, setDoc, updateDoc, waitForPendingWrites, writeBatch,
} from 'firebase/firestore';
import { getDb } from '../firebase';
import {
  FORMAT_VERSION, LEGACY_DATA_COLL, LEGACY_PROJECT_COLL, MASTER_KEYS, MEMBER_COLL, META_COLL, META_DOC,
  PROBE_COLL, PROBE_DOC, collPath, docPath,
} from './paths';
import { Body, LegacyData, PlannedDoc } from './sharedLogic';

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
/** 名簿に登録する・役割を変える（email は小文字にそろえたもの） */
export function putMember(email: string, role: 'owner' | 'member', addedBy: string, addedAt = Date.now()): Promise<void> {
  return withTimeout(setDoc(dref(MEMBER_COLL, email), { role, addedAt, addedBy }), 15000);
}
export function deleteMember(email: string): Promise<void> {
  return withTimeout(deleteDoc(dref(MEMBER_COLL, email)), 15000);
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
export function endMigration(fields: Body): Promise<void> {
  return withTimeout(updateDoc(dref(META_COLL, META_DOC), forUpdate(fields)), 30000);
}

/** まとめて書き込み、サーバーが受け付けるまで待つ（移行用）。1 回に送る量を抑えて分割する */
export async function writeAllServer(docs: PlannedDoc[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const MAX_DOCS = 100, MAX_BYTES = 1_500_000;
  let i = 0;
  while (i < docs.length) {
    const batch = writeBatch(db());
    let n = 0, bytes = 0;
    while (i < docs.length && n < MAX_DOCS) {
      const size = JSON.stringify(docs[i].body).length * 2;
      if (n > 0 && bytes + size > MAX_BYTES) break;
      batch.set(dref(docs[i].coll, docs[i].id), docs[i].body);
      bytes += size; n += 1; i += 1;
    }
    await withTimeout(batch.commit(), 45000);
    onProgress?.(i, docs.length);
  }
}
