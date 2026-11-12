// sharedSession.test.ts 用の部品（アプリ本体からは使わない）。
//
// 実際の Firestore の代わりに、次のものをメモリ上で模擬する:
//   - サーバー（ドキュメントの集まり）
//   - 端末内の送信待ち（圏外では溜まり、つながると順に送られる。同じブラウザの画面（タブ）で共有される）
//   - 購読（サーバーの内容に、送信待ちを重ねたものが届く）
//   - サーバーからの読み取り（圏外では返ってこない）、トランザクション（圏外ではその場で失敗する）
// 画面（タブ）は「モジュールを読み込み直した別の実体」として模擬する。状態は globalThis に置き、実体の間で共有する。
//
// これは Firestore そのものではない。実物での確認は e2e/sync（エミュレータ）で行う。
import { FORMAT_VERSION, MEMBER_COLL, META_COLL, META_DOC } from './paths';
import type { Access, Actor, DocChange, Member, SnapInfo } from './remote';
import type { Body, LegacyData, PlannedDoc } from './sharedLogic';

interface Write { kind: 'set' | 'update' | 'delete'; path: string; data?: Body; resolve: () => void; reject: (e: unknown) => void; settled: boolean }
interface Listener { coll: string; onNext: (c: DocChange[], i: SnapInfo) => void; last: Map<string, string>; first: boolean; fromCache?: boolean }
interface MetaListener { onNext: (b: Body | null) => void; last?: string }
interface Waiter { targets: Write[]; resolve: () => void }
export interface FakeState {
  server: Map<string, Body>;
  queue: Write[];
  listeners: Set<Listener>;
  metaListeners: Set<MetaListener>;
  waiters: Set<Waiter>;
  /** ネットワークがつながっているか（アプリが見る navigator.onLine とは別） */
  online: boolean;
  writeDelay: number;
  readDelay: number;
  access: Access;
  /** 端末内の控えにある形式の情報（undefined＝控えに無い） */
  metaCache: Body | null | undefined;
  /** 書き込みを拒否させる（拒否の理由を返す） */
  rejectWrite: ((w: { kind: string; path: string; data?: Body }) => string | null) | null;
  legacy: LegacyData;
  /** 起きたことの記録 */
  log: string[];
  processing: boolean;
  emitScheduled: boolean;
  resetOk: boolean;
  resets: number;
}

const META = `${META_COLL}/${META_DOC}`;
const emptyLegacy = (): LegacyData => ({ masters: { staff: null, venues: null, contents: null, partTypes: null, composites: null }, projects: [] });
function fresh(): FakeState {
  return {
    server: new Map([[META, { formatVersion: FORMAT_VERSION, status: 'done' }]]), queue: [], listeners: new Set(), metaListeners: new Set(),
    waiters: new Set(), online: true, writeDelay: 40, readDelay: 40, access: { role: 'open', enforced: false }, metaCache: undefined,
    rejectWrite: null, legacy: emptyLegacy(), log: [], processing: false, emitScheduled: false, resetOk: true, resets: 0,
  };
}
const G = globalThis as unknown as { __kklFake?: FakeState };
export const fake: FakeState = (G.__kklFake ??= fresh());
/** 模擬環境を初期状態に戻す（テストごと） */
export function resetFake(): void { Object.assign(fake, fresh()); }

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const err = (code: string) => Object.assign(new Error(code), { code });
const never = <T>() => new Promise<T>(() => { /* 返ってこない */ });

function applyWrite(body: Body | undefined, w: Write): Body | undefined {
  if (w.kind === 'set') return clone(w.data);
  if (w.kind === 'delete') return undefined;
  if (body === undefined) return undefined;                // 無いものへの「更新」は、手元にも反映されない
  const out: Body = { ...body };
  for (const [k, v] of Object.entries(w.data ?? {})) { if (v === undefined) delete out[k]; else out[k] = clone(v); }
  return out;
}
/** サーバーの内容に、送信待ちを重ねたもの（画面に届く内容） */
function localView(coll: string): Map<string, { body: Body; pending: boolean }> {
  const out = new Map<string, { body: Body; pending: boolean }>();
  for (const [path, body] of fake.server) if (path.startsWith(`${coll}/`)) out.set(path.slice(coll.length + 1), { body, pending: false });
  for (const w of fake.queue) {
    if (!w.path.startsWith(`${coll}/`)) continue;
    const id = w.path.slice(coll.length + 1);
    const next = applyWrite(out.get(id)?.body, w);
    if (next === undefined) { if (w.kind === 'delete') out.delete(id); continue; }
    out.set(id, { body: next, pending: true });
  }
  return out;
}
function emitNow(): void {
  for (const l of [...fake.listeners]) {
    const view = localView(l.coll);
    const changes: DocChange[] = [];
    for (const [id, d] of view) {
      const sig = JSON.stringify(d.body) + (d.pending ? '|p' : '');
      if (l.last.get(id) !== sig) { l.last.set(id, sig); changes.push({ id, body: clone(d.body), pending: d.pending }); }
    }
    for (const id of [...l.last.keys()]) if (!view.has(id)) { l.last.delete(id); changes.push({ id, body: null, pending: false }); }
    const fromCache = !fake.online;
    if (changes.length || !l.first || l.fromCache !== fromCache) { l.first = true; l.fromCache = fromCache; l.onNext(changes, { fromCache }); }
  }
  for (const l of [...fake.metaListeners]) {
    const cur = fake.online ? fake.server.get(META) ?? null : fake.metaCache;
    if (cur === undefined) continue;
    const sig = JSON.stringify(cur);
    if (l.last !== sig) { l.last = sig; l.onNext(clone(cur)); }
  }
}
function scheduleEmit(): void {
  if (fake.emitScheduled) return;
  fake.emitScheduled = true;
  setTimeout(() => { fake.emitScheduled = false; emitNow(); }, 0);
}
async function pump(): Promise<void> {
  if (fake.processing) return;
  fake.processing = true;
  try {
    while (fake.queue.length && fake.online) {
      const w = fake.queue[0];
      await sleep(fake.writeDelay);
      if (!fake.online || fake.queue[0] !== w) continue;
      fake.queue.shift();
      let code = fake.rejectWrite ? fake.rejectWrite(w) : null;
      if (!code && w.kind === 'update' && !fake.server.has(w.path)) code = 'not-found';
      if (!code) {
        const next = applyWrite(fake.server.get(w.path), w);
        if (next === undefined) fake.server.delete(w.path); else fake.server.set(w.path, next);
      }
      fake.log.push(`${code ? `REJECT(${code})` : 'ACK'} ${w.kind} ${w.path}`);
      emitNow();                                            // 先に購読へ届き、そのあとで書き込みの結果が返る（SDK と同じ順）
      w.settled = true;
      if (code) w.reject(err(code)); else w.resolve();
      for (const p of [...fake.waiters]) if (p.targets.every((t) => t.settled)) { fake.waiters.delete(p); p.resolve(); }
    }
  } finally {
    fake.processing = false;
  }
}
function enqueue(kind: Write['kind'], coll: string, id: string, data?: Body): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fake.queue.push({ kind, path: `${coll}/${id}`, data: data === undefined ? undefined : { ...data }, resolve, reject, settled: false });
    scheduleEmit();
    void pump();
  });
}
/** サーバーから読む。圏外では返ってこない（呼び出し側が時間切れにする） */
async function serverRead<T>(fn: () => T): Promise<T> {
  if (!fake.online) return never<T>();
  await sleep(fake.readDelay / 2);
  const v = clone(fn());                                    // 要求が届いた時点でサーバーにあった内容
  await sleep(fake.readDelay / 2);
  if (!fake.online) return never<T>();
  return v;
}
/** トランザクション。圏外では、その場で失敗する（送信待ちには残らない） */
async function transaction<T>(fn: () => T): Promise<T> {
  if (!fake.online) throw err('unavailable');
  await sleep(fake.readDelay);
  if (!fake.online) throw err('unavailable');
  const out = fn();
  scheduleEmit();
  return out;
}
function guarded<T>(attempt: number, fn: () => T): Promise<T> {
  return transaction(() => {
    const m = fake.server.get(META);
    if (!m || m.status !== 'running' || Number(m.attempt) !== attempt) throw err('superseded');
    return fn();
  });
}
const collDocs = (coll: string) => [...fake.server].filter(([p]) => p.startsWith(`${coll}/`)).map(([p, body]) => ({ id: p.slice(coll.length + 1), body }));

// ── テストからの操作 ──
/** サーバーの内容を、ほかの端末が書き換えたことにする */
export function setServer(coll: string, id: string, body: Body | null): void {
  if (body === null) fake.server.delete(`${coll}/${id}`); else fake.server.set(`${coll}/${id}`, body);
  scheduleEmit();
}
export const serverDoc = (coll: string, id: string): Body | undefined => fake.server.get(`${coll}/${id}`);
export function setMeta(m: Body | null): void {
  if (m === null) fake.server.delete(META); else fake.server.set(META, m);
  scheduleEmit();
}
/** ネットワークをつなぐ・切る */
export function setNetwork(v: boolean): void { fake.online = v; scheduleEmit(); void pump(); }

// ── remote.ts の代わり ──
export const remote = {
  errorCode: (e: unknown): string => (e as { code?: string } | null)?.code ?? 'unknown',
  withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(err('timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  },
  watchCollection(coll: string, onNext: Listener['onNext']): () => void {
    const l: Listener = { coll, onNext, last: new Map(), first: false };
    fake.listeners.add(l);
    scheduleEmit();
    return () => { fake.listeners.delete(l); };
  },
  watchMeta(onNext: MetaListener['onNext']): () => void {
    const l: MetaListener = { onNext };
    fake.metaListeners.add(l);
    scheduleEmit();
    return () => { fake.metaListeners.delete(l); };
  },
  createDoc: (coll: string, id: string, body: Body) => enqueue('set', coll, id, body),
  patchDoc: (coll: string, id: string, patch: Body) => enqueue('update', coll, id, patch),
  removeDoc: (coll: string, id: string) => enqueue('delete', coll, id),
  waitPending(): Promise<void> {
    const targets = [...fake.queue];
    if (targets.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { fake.waiters.add({ targets, resolve }); });
  },
  readDocServer: (coll: string, id: string) => serverRead(() => fake.server.get(`${coll}/${id}`) ?? null),
  readDocCache: async () => undefined,
  readCollServer: (coll: string) => serverRead(() => collDocs(coll)),
  checkAccess: () => serverRead(() => fake.access),
  readMetaServer: () => serverRead(() => fake.server.get(META) ?? null),
  readMetaCache: async () => clone(fake.metaCache),
  readLegacy: () => serverRead(() => fake.legacy),
  async listMembers(): Promise<Member[]> {
    return (await serverRead(() => collDocs(MEMBER_COLL))).map((d) => ({
      email: d.id, role: d.body.role === 'owner' ? ('owner' as const) : ('member' as const), addedAt: Number(d.body.addedAt) || 0, addedBy: String(d.body.addedBy ?? ''),
    }));
  },
  putMember: (email: string, role: 'owner' | 'member', addedBy: string, addedAt = 1) =>
    transaction(() => { fake.server.set(`${MEMBER_COLL}/${email}`, { role, addedAt, addedBy }); }),
  deleteMember: (email: string) => transaction(() => { fake.server.delete(`${MEMBER_COLL}/${email}`); }),
  initFresh(defaults: PlannedDoc[], source: string, actor: Actor): Promise<'created' | 'exists'> {
    return transaction(() => {
      if (fake.server.has(META)) return 'exists' as const;
      for (const d of defaults) if (!fake.server.has(`${d.coll}/${d.id}`)) fake.server.set(`${d.coll}/${d.id}`, clone(d.body));
      fake.server.set(META, { formatVersion: FORMAT_VERSION, status: 'done', source, createdBy: actor });
      return 'created' as const;
    });
  },
  beginMigration(newBackupId: string, actor: Actor): Promise<{ backupId: string; attempt: number } | 'done'> {
    return transaction(() => {
      const m = fake.server.get(META);
      if (!m) {
        fake.server.set(META, { formatVersion: FORMAT_VERSION, status: 'running', source: 'legacy', backupId: newBackupId, attempt: 1, startedBy: actor });
        return { backupId: newBackupId, attempt: 1 };
      }
      if (m.status === 'done') return 'done' as const;
      const backupId = typeof m.backupId === 'string' && m.backupId ? m.backupId : newBackupId;
      const attempt = (Number(m.attempt) || 1) + 1;
      const next: Body = { ...m, status: 'running', backupId, attempt, startedBy: actor };
      delete next.error;
      fake.server.set(META, next);
      return { backupId, attempt };
    });
  },
  endMigration: (attempt: number, fields: Body) => guarded(attempt, () => { fake.server.set(META, { ...fake.server.get(META), ...clone(fields) }); }),
  async writeAllGuarded(attempt: number, docs: PlannedDoc[], onProgress?: (done: number, total: number) => void): Promise<void> {
    for (let i = 0; i < docs.length; i += 2) {
      const chunk = docs.slice(i, i + 2);
      await guarded(attempt, () => {
        for (const d of chunk) {
          const code = fake.rejectWrite ? fake.rejectWrite({ kind: 'set', path: `${d.coll}/${d.id}`, data: d.body }) : null;
          if (code) throw err(code);
        }
        for (const d of chunk) fake.server.set(`${d.coll}/${d.id}`, clone(d.body));
      });
      onProgress?.(Math.min(i + 2, docs.length), docs.length);
    }
  },
};

// ── firebase.ts の代わり ──
export const firebase = {
  isFirebaseConfigured: true,
  isEmulator: false,
  /** 端末内キャッシュを消す＝送信待ちも消える */
  async resetDb(): Promise<boolean> {
    fake.resets += 1;
    if (!fake.resetOk) return false;
    fake.queue.length = 0;
    fake.log.push('resetDb');
    scheduleEmit();
    return true;
  },
  onDbResetElsewhere: () => () => { /* 何もしない */ },
};

// ── ブラウザの代わり（localStorage・window・document・navigator） ──
interface HeldLock { name: string }
type Handlers = Record<string, Set<() => void>>;
export interface FakeBrowser {
  store: Map<string, string>;
  /** 画面（タブ）ごとの、window に登録されたイベントの受け手 */
  windows: Handlers[];
  locks: HeldLock[];
  onLine: boolean;
  /** localStorage への書き込みを失敗させる（容量超過の模擬） */
  storageFull: boolean;
}
const B = globalThis as unknown as { __kklBrowser?: FakeBrowser };
export const browser: FakeBrowser = (B.__kklBrowser ??= { store: new Map(), windows: [], locks: [], onLine: true, storageFull: false });

function define(values: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(values)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
/** 画面（タブ）を 1 つ増やす（以後 window に登録されるイベントは、この画面のもの）。返すのは、この画面だけにイベントを起こす関数 */
export function newWindow(): (type: string) => void {
  const handlers: Handlers = {};
  browser.windows.push(handlers);
  define({
    window: {
      addEventListener: (t: string, f: () => void) => { (handlers[t] ??= new Set()).add(f); },
      removeEventListener: (t: string, f: () => void) => { handlers[t]?.delete(f); },
    },
  });
  return (type) => { for (const f of [...(handlers[type] ?? [])]) f(); };
}
export function installBrowser(): void {
  browser.store.clear();
  browser.windows = [];
  browser.locks = [];
  browser.onLine = true;
  browser.storageFull = false;
  const localStorage = {
    getItem: (k: string) => (browser.store.has(k) ? browser.store.get(k)! : null),
    setItem: (k: string, v: string) => { if (browser.storageFull) throw new Error('QuotaExceededError'); browser.store.set(k, String(v)); },
    removeItem: (k: string) => { browser.store.delete(k); },
    key: (i: number) => [...browser.store.keys()][i] ?? null,
    get length() { return browser.store.size; },
  };
  type LockCb = (lock: HeldLock | null) => unknown;
  const locks = {
    async request(name: string, a: LockCb | { ifAvailable?: boolean }, b?: LockCb): Promise<unknown> {
      const cb = (typeof a === 'function' ? a : b) as LockCb;
      const opts = typeof a === 'function' ? {} : a;
      if (opts.ifAvailable && browser.locks.some((l) => l.name === name)) return cb(null);
      const held: HeldLock = { name };
      browser.locks.push(held);
      try { return await cb(held); } finally { browser.locks = browser.locks.filter((l) => l !== held); }
    },
    query: async () => ({ held: browser.locks.map((l) => ({ name: l.name })) }),
  };
  define({
    localStorage,
    navigator: { get onLine() { return browser.onLine; }, locks },
    document: { visibilityState: 'visible', addEventListener() { /* 使わない */ }, removeEventListener() { /* 使わない */ } },
  });
  newWindow();
}
/** すべての画面に、window のイベント（online・offline）を起こす */
export function dispatch(type: string): void {
  for (const handlers of [...browser.windows]) for (const f of [...(handlers[type] ?? [])]) f();
}
/** アプリから見た接続状態（navigator.onLine）と、ネットワークそのものを、まとめて切り替える */
export function setOnline(v: boolean): void {
  browser.onLine = v;
  setNetwork(v);
  dispatch(v ? 'online' : 'offline');
}
/** 控え（outbox）の中身 */
export function outboxEntries(): { sid: string; coll: string; id: string; kind: string; fields: string[]; body: Body | null; dirty: boolean; revs: string[]; baseRev: string | null; at: number }[] {
  return [...browser.store].filter(([k]) => k.startsWith('kkl_outbox')).map(([, v]) => JSON.parse(v));
}

/** 案件 1 件ぶんのドキュメント（サーバーに置く用） */
export function projectDoc(id: string, extra: Body = {}): Body {
  return {
    id, name: '案件', memo: '', venueId: '', startDate: '', endDate: '', openTime: '', closeTime: '', status: '計画中',
    contents: [], assignments: [], otherCosts: [],
    layout: { width: 1000, height: 800, env: [], items: [], groups: [], version: 1, issued: [], caption: '', notes: '' },
    updatedAt: 1, order: 0, rev: 'r0', ...extra,
  };
}
