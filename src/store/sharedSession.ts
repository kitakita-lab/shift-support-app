// 共有データ（ログイン中）の同期。1 回のログイン＝1 セッション。画面（React）には依存しない。
//
// 原則（docs/02_新アプリ設計書.md の「共有データの同期」を参照）:
//   1. 共有データは Firestore を正とする。端末に「もう 1 つのコピー」は持たない
//      （画面の内容 ＝ Firestore から届いた内容 ＋ まだ届いた内容に反映されていない自分の変更）。
//   2. 既にあるものへの変更は「更新」として、自分が変えた項目だけを送る。
//      → 削除されたものは復活しない。別々の項目を同時に変えても、互いを上書きしない。
//   3. 入力中の内容は、届いた古い内容で巻き戻さない（自分が変えた項目だけ手元を優先する）。
//   4. 送れなかった変更は黙って捨てない（表示する。案件は「この端末だけのデータ」に控えを残す）。
//   5. メンバーでないアカウントには、共有データを読ませない（購読を始めない）。
import { defaultComposites, defaultPartTypes, emptyData } from '../domain/seed';
import { genId } from '../domain/util';
import { resetDb } from '../firebase';
import { AppData, Project } from '../types';
import { hydrateItem, hydrateProject } from './localData';
import { clearOutbox, countOutbox, orphans, putOutbox, removeOutbox } from './outbox';
import { BACKUP_COLL, FORMAT_VERSION, MASTER_COLL, MASTER_KEYS, MasterKey, PROJECT_COLL, TEAM_ID } from './paths';
import {
  Access, Actor, DocChange, Member, Role, SnapInfo, beginMigration, checkAccess, createDoc, deleteMember, endMigration,
  errorCode, initFresh, listMembers, patchDoc, putMember, readCollServer, readLegacy, readMetaCache, readMetaServer,
  removeDoc, waitPending, watchCollection, watchMeta, withTimeout, writeAllServer,
} from './remote';
import {
  Body, LegacyData, MASTER_LABEL, MigrationReport, Overlay, PlannedDoc, ProjectCopy, ServerDoc, applyOverlay, changedFields,
  composeDocs, diffById, emptyOverlay, isValidMemberEmail, legacyHasData, nextOrder, normalizeEmail, planMigration,
  sameContent, settleOverlay, stripMeta, verifyMigration,
} from './sharedLogic';

export type { Member, Role };

/** 入力が止まってから送るまでの待ち時間 */
const SAVE_DELAY_MS = 700;
/** つながっているはずなのに、これ以上送信が終わらなければ「送信待ち」と表示する */
const STALL_MS = 10000;

export type Phase =
  | 'off'              // 未ログイン・Firebase 未設定
  | 'checking'         // 使えるかどうかを確認中
  | 'unregistered'     // このアカウントはチームに登録されていない
  | 'needs-init'       // 共有データがまだ用意されていない（管理者の初期設定待ち）
  | 'needs-migration'  // 以前の版の形式のデータがある（移行が必要）
  | 'migrating'        // この端末で移行を実行中
  | 'too-new'          // 共有データが、このアプリより新しい形式
  | 'ready'            // 使える
  | 'error';           // 確認できなかった（圏外など）

export interface SharedView {
  phase: Phase;
  role: Role;
  /** ルールが名簿で制限しているか（false＝ログインできる人は誰でも読み書きできる状態） */
  enforced: boolean;
  email: string;
  /** phase が ready のときだけ中身がある */
  data: AppData;
  online: boolean;
  /** まだ共有に届いたと確認できていない変更があるもの（案件・マスタ 1 件単位）の数 */
  unsent: number;
  stalled: boolean;
  /** サーバーの最新の内容をまだ受け取っていない（端末内の控えを表示中） */
  fromCache: boolean;
  /** 形式の情報（wsMeta/state） */
  meta: Body | null;
  /** 旧形式のデータの件数（移行の案内に表示） */
  legacyCounts: Record<string, number> | null;
  /** 実行中の処理の説明（無ければ空） */
  job: string;
  report: MigrationReport | null;
  error: string;
}

const EMPTY = emptyData();
export const OFF_VIEW: SharedView = {
  phase: 'off', role: 'none', enforced: true, email: '', data: EMPTY, online: true, unsent: 0, stalled: false,
  fromCache: false, meta: null, legacyCounts: null, job: '', report: null, error: '',
};

export interface SessionUser { uid: string; email: string; displayName: string }
export interface SessionHooks {
  /** 共有に反映できなかった案件を「この端末だけのデータ」に控えとして残す。残した案件の名前を返す */
  stash: (p: Project, shared: AppData) => string;
  notify: (kind: 'warn' | 'info', text: string) => void;
  /** ファイルとして端末に保存する（移行前のバックアップ） */
  download: (filename: string, json: unknown) => void;
}

// ── 端末内キャッシュの持ち主 ─────────────────────────────────────
// Firestore の端末内キャッシュ（閲覧用の控えと送信待ち）は、アカウントをまたいで残してはいけない。
// 「いま誰のキャッシュか」を覚えておき、違うアカウント・ログアウトのときは、使う前に消す。
const CACHE_UID_KEY = 'kkl_shared_cache_uid';
const ACCESS_KEY = 'kkl_shared_access_v1';
let gate: Promise<void> = Promise.resolve();
export function claimCache(uid: string | null): Promise<void> {
  gate = gate.then(async () => {
    let cur: string | null = null;
    try { cur = localStorage.getItem(CACHE_UID_KEY); } catch { /* 使えない */ }
    if (cur && cur !== uid) {
      await resetDb();
      try { localStorage.removeItem(ACCESS_KEY); } catch { /* 何もしない */ }
    }
    try {
      if (uid) localStorage.setItem(CACHE_UID_KEY, uid);
      else localStorage.removeItem(CACHE_UID_KEY);
    } catch { /* 何もしない */ }
  }).catch(() => { /* 消せなくても、未登録のアカウントには購読を始めない */ });
  return gate;
}
/** ログアウトで未送信の変更を破棄するとき */
export function discardUnsent(uid: string): void { clearOutbox(uid); }

function loadAccess(uid: string): Access | null {
  try {
    const a = JSON.parse(localStorage.getItem(ACCESS_KEY) ?? 'null') as (Access & { uid: string; team: string }) | null;
    return a && a.uid === uid && a.team === TEAM_ID ? { role: a.role, enforced: a.enforced } : null;
  } catch { return null; }
}
function saveAccess(uid: string, a: Access | null): void {
  try {
    if (a && a.role !== 'none') localStorage.setItem(ACCESS_KEY, JSON.stringify({ ...a, uid, team: TEAM_ID }));
    else localStorage.removeItem(ACCESS_KEY);
  } catch { /* 何もしない */ }
}

// ── セッション ───────────────────────────────────────────────
type CollKey = MasterKey | 'projects';
const COLLS: { coll: string; key: CollKey }[] = [
  ...MASTER_KEYS.map((key) => ({ coll: MASTER_COLL[key], key: key as CollKey })),
  { coll: PROJECT_COLL, key: 'projects' },
];
const KIND_LABEL: Record<string, string> = Object.fromEntries([
  ...MASTER_KEYS.map((k) => [MASTER_COLL[k], MASTER_LABEL[k]] as [string, string]), [PROJECT_COLL, '案件'],
]);
const labelOf = (coll: string, item: unknown): string => {
  const name = (item as { name?: unknown } | null | undefined)?.name;
  return `${KIND_LABEL[coll] ?? ''}「${(typeof name === 'string' && name) || '名称未設定'}」`;
};

interface Inflight { rev: string; kind: 'create' | 'update' | 'delete'; body: Body | null; label: string; at: number }
interface DocState {
  overlay: Overlay;
  timer: ReturnType<typeof setTimeout> | null;
  /** 送信済みで、結果がまだ分からない書き込み（送った順） */
  inflight: Inflight[];
  /** 共有に届いたと確認できていない項目の名前 */
  fields: Set<string>;
  /** この画面で作り、まだ届いたと確認できていない */
  fresh: boolean;
  label: string;
  /** 拒否された書き込みのうち、まだ利用者に知らせていないもの */
  lost: (Inflight & { code: string }) | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function reason(code: string): string {
  if (code === 'permission-denied') return '権限がありません';
  if (code === 'timeout' || code === 'unavailable') return '通信できませんでした（時間切れ）';
  if (code === 'resource-exhausted') return '利用量の上限に達しました';
  return `理由: ${code}`;
}

export class SharedSession {
  private view: SharedView;
  private listeners = new Set<() => void>();
  private stopped = false;
  private gen = 0;
  private unsubs: (() => void)[] = [];
  private metaUnsub: (() => void) | null = null;
  private attached = false;
  private server: Record<string, Map<string, ServerDoc>> = {};
  private first: Record<string, boolean> = {};
  private cached: Record<string, boolean> = {};
  private composed: Record<string, { id: string; body: Body }[]> = {};
  private dirty = new Set<string>();
  private docs = new Map<string, DocState>();
  private items = new WeakMap<Body, unknown>();
  private busy = false;
  /** 最後に届いた形式の情報（この端末で移行・初期設定を実行している間は画面に反映しないので、覚えておく） */
  private lastMeta: Body | null = null;
  private lastCheck = 0;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 購読の失敗が続いた回数（使える状態になったら 0 に戻す。繰り返すようなら止める） */
  private listenFailures = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly actor: Actor;
  private readonly email: string;

  constructor(private readonly user: SessionUser, private readonly hooks: SessionHooks) {
    this.actor = { uid: user.uid, displayName: user.displayName || user.email || '不明' };
    this.email = normalizeEmail(user.email);
    this.view = { ...OFF_VIEW, phase: 'checking', email: this.email, online: isOnline() };
  }

  // ── 画面との接続 ──
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getView = (): SharedView => this.view;
  private emit(patch: Partial<SharedView>): void {
    if (this.stopped) return;
    this.view = { ...this.view, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // ── 開始・終了 ──
  start(): void {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('pagehide', this.onHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    // 表示（未送信の件数など）の更新と、ほかの画面（タブ）が送る前に閉じられた変更の引き取り
    let n = 0;
    this.ticker = setInterval(() => { this.refreshStatus(); if (++n % 4 === 0) void this.adopt(); }, 3000);
    void this.check();
  }
  stop(): void {
    this.stopped = true;
    this.gen += 1;
    this.detach();
    this.unwatchMeta();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('pagehide', this.onHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.ticker) clearInterval(this.ticker);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    for (const ds of this.docs.values()) if (ds.timer) clearTimeout(ds.timer);
  }
  private onOnline = () => {
    this.refreshStatus();
    if (this.view.phase === 'error') void this.check();
    else void this.adopt();
  };
  private onOffline = () => this.refreshStatus();
  private onFocus = () => { void this.adopt(); };
  // 画面を離れる・閉じるときは、待たずに送る（閉じられても、控え（outbox）から次回送り直せる）
  private onHide = () => this.flush();
  private onVisibility = () => { if (document.visibilityState === 'hidden') this.flush(); };
  private dead(gen: number): boolean { return this.stopped || gen !== this.gen; }

  // ── 使えるかどうかの確認 ──
  /** アカウントの登録状況と、共有データの形式を確かめて、状態を決める */
  async check(): Promise<void> {
    const gen = ++this.gen;
    this.lastCheck = Date.now();
    this.detach();
    this.unwatchMeta();
    this.emit({ phase: 'checking', error: '', online: isOnline() });
    try {
      await claimCache(this.user.uid);
      if (this.dead(gen)) return;
      let access: Access | null = null;
      if (isOnline()) {
        try {
          access = await withTimeout(checkAccess(this.email), 12000);
          saveAccess(this.user.uid, access);
        } catch { access = null; }                  // 圏外・時間切れ → 前回の確認結果を使う
      }
      if (this.dead(gen)) return;
      const confirmed = !!access;
      access ??= loadAccess(this.user.uid);
      if (!access) {
        this.emit({ phase: 'error', error: '接続できないため、このアカウントで共有データを使えるか確認できませんでした。' });
        return;
      }
      this.emit({ role: access.role, enforced: access.enforced });
      if (access.role === 'none') {
        // 登録されていない（外された）アカウントの端末には、共有データの控えを残さない
        this.salvage('このアカウントはチームに登録されていないため');
        await claimCache(null);
        if (this.dead(gen)) return;
        this.emit({ phase: 'unregistered' });
        return;
      }
      let meta: Body | null | undefined;
      if (confirmed) {
        try { meta = await withTimeout(readMetaServer(), 12000); } catch { meta = undefined; }
      }
      if (meta === undefined) meta = await readMetaCache();
      if (this.dead(gen)) return;
      if (meta === undefined) {
        this.emit({ phase: 'error', error: '接続できないため、共有データの状態を確認できませんでした。' });
        return;
      }
      this.unwatchMeta();
      this.metaUnsub = watchMeta((body) => this.onMeta(body), () => { /* 権限の問題は、データの購読側で扱う */ });
      await this.decide(meta, gen);
    } catch (e) {
      if (!this.dead(gen)) this.emit({ phase: 'error', error: `共有データを確認できませんでした（${reason(errorCode(e))}）。` });
    }
  }

  /**
   * 使っている最中に、登録状況を確かめ直す（名簿が変わった・書き込みが権限不足で拒否された、など）。
   * 画面はそのままにして、結果が変わったときだけ反映する（確かめ直すたびに画面が切り替わらないようにする）。
   */
  async recheck(): Promise<void> {
    if (this.stopped) return;
    if (this.view.phase !== 'ready') { await this.check(); return; }
    const gen = this.gen;
    this.lastCheck = Date.now();
    let access: Access;
    try { access = await withTimeout(checkAccess(this.email), 12000); } catch { return; }   // 確かめられないときは、そのまま
    if (this.dead(gen)) return;
    saveAccess(this.user.uid, access);
    if (access.role === 'none') { await this.check(); return; }                            // 使えなくなった → 未登録の表示へ
    if (access.role !== this.view.role || access.enforced !== this.view.enforced) this.emit({ role: access.role, enforced: access.enforced });
  }
  /** 確かめ直しを予約する（短い間に何度も確かめない） */
  private scheduleRecheck(): void {
    if (this.stopped || this.recheckTimer) return;
    const wait = Math.max(0, 5000 - (Date.now() - this.lastCheck));
    this.recheckTimer = setTimeout(() => { this.recheckTimer = null; void this.recheck(); }, wait);
  }

  private canAdmin(): boolean { return this.view.role === 'owner' || this.view.role === 'open'; }

  private async decide(meta: Body | null, gen: number): Promise<void> {
    this.emit({ meta });
    if (meta && Number(meta.formatVersion) > FORMAT_VERSION) { this.detach(); this.emit({ phase: 'too-new' }); return; }
    if (meta && meta.status === 'done') { this.attach(); return; }
    // まだ使える状態になっていない: 旧形式のデータがあるかを見る
    let legacy: LegacyData;
    try {
      legacy = await withTimeout(readLegacy(), 20000);
    } catch (e) {
      if (!this.dead(gen)) this.emit({ phase: 'error', error: `共有データの状態を確認できませんでした（${reason(errorCode(e))}）。` });
      return;
    }
    if (this.dead(gen)) return;
    if (!meta && !legacyHasData(legacy)) {
      if (!this.canAdmin()) { this.emit({ phase: 'needs-init' }); return; }
      try {
        await initFresh(defaultDocs(), 'fresh', this.actor);
      } catch (e) {
        if (!this.dead(gen)) this.emit({ phase: 'error', error: `共有データの初期設定ができませんでした（${reason(errorCode(e))}）。` });
        return;
      }
      if (this.dead(gen)) return;
      this.attach();
      return;
    }
    this.emit({ phase: 'needs-migration', legacyCounts: countLegacy(legacy) });
  }

  private onMeta(body: Body | null): void {
    this.lastMeta = body;
    if (this.stopped || this.busy) return;
    const p = this.view.phase;
    if (body && Number(body.formatVersion) > FORMAT_VERSION) {
      if (p !== 'too-new' && p !== 'checking') { this.detach(); this.emit({ phase: 'too-new', meta: body }); }
      return;
    }
    if (p === 'needs-init' || p === 'needs-migration') {
      this.emit({ meta: body });
      if (body && body.status === 'done') this.attach();   // 管理者（ほかの端末）が用意を終えた
    } else if (p === 'ready') {
      this.emit({ meta: body });
    }
  }

  // ── 購読 ──
  private attach(): void {
    if (this.attached || this.stopped) return;
    this.attached = true;
    for (const { coll } of COLLS) {
      this.server[coll] = new Map();
      this.first[coll] = false;
      this.cached[coll] = true;
      this.unsubs.push(watchCollection(coll, (changes, info) => this.onDocs(coll, changes, info), (code) => this.onListenError(code)));
    }
  }
  private unwatchMeta(): void {
    try { this.metaUnsub?.(); } catch { /* 接続を作り直したあとは、解除するものが無い */ }
    this.metaUnsub = null;
  }
  private detach(): void {
    for (const u of this.unsubs) { try { u(); } catch { /* 同上 */ } }
    this.unsubs = [];
    this.attached = false;
    this.server = {};
    this.first = {};
    this.composed = {};
  }
  private onListenError(code: string): void {
    if (this.stopped || !this.attached) return;
    // 読む権限が無くなった（名簿から外された・ルールが変わった）など。購読は止まっているので、状態を確かめ直す
    this.detach();
    this.listenFailures += 1;
    if (this.listenFailures > 3) {
      this.emit({ phase: 'error', error: `共有データを読み込めませんでした（${reason(code)}）。` });
      return;
    }
    this.emit({ phase: 'checking' });
    const wait = Math.max(0, 5000 - (Date.now() - this.lastCheck));
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => { this.recheckTimer = null; void this.check(); }, wait);
  }
  private onDocs(coll: string, changes: DocChange[], info: SnapInfo): void {
    if (this.stopped || !this.attached) return;
    const map = this.server[coll];
    if (!map) return;
    for (const c of changes) {
      if (c.body === null) map.delete(c.id);
      else {
        const old = map.get(c.id);
        map.set(c.id, { body: old && sameContent(old.body, c.body) ? old.body : c.body, pending: c.pending });
      }
      const key = `${coll}/${c.id}`;
      const ds = this.docs.get(key);
      if (ds) { ds.overlay = settleOverlay(ds.overlay, map.get(c.id)) ?? emptyOverlay(); this.gc(key); }
    }
    this.first[coll] = true;
    this.cached[coll] = info.fromCache;
    this.dirty.add(coll);
    if (this.view.phase !== 'ready' && COLLS.every((c) => this.first[c.coll])) {
      for (const c of COLLS) this.dirty.add(c.coll);
      this.listenFailures = 0;
      this.view = { ...this.view, phase: 'ready', error: '', job: '' };
      this.rebuild(true);
      void this.adopt();
      return;
    }
    this.rebuild();
  }

  // ── 画面に出す内容の組み立て ──
  private overlaysOf(coll: string): Map<string, Overlay> {
    const out = new Map<string, Overlay>();
    const prefix = `${coll}/`;
    for (const [k, ds] of this.docs) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), ds.overlay);
    return out;
  }
  private item(key: CollKey, body: Body): unknown {
    let it = this.items.get(body);
    if (!it) {
      const raw = stripMeta(body);
      it = key === 'projects' ? hydrateProject(raw as unknown as Project) : (hydrateItem[key] as (x: unknown) => unknown)(raw);
      this.items.set(body, it);
    }
    return it;
  }
  private status(): Pick<SharedView, 'unsent' | 'online' | 'stalled' | 'fromCache'> {
    const keys = new Set<string>();
    let oldest = Infinity;
    for (const [k, ds] of this.docs) {
      if (!ds.overlay.pending && ds.inflight.length === 0) continue;
      keys.add(k);
      for (const f of ds.inflight) oldest = Math.min(oldest, f.at);
    }
    for (const { coll } of COLLS) for (const [id, d] of this.server[coll] ?? []) if (d.pending) keys.add(`${coll}/${id}`);
    const online = isOnline();
    return {
      unsent: keys.size, online, stalled: online && oldest < Date.now() - STALL_MS,
      fromCache: this.attached && COLLS.some((c) => this.cached[c.coll] !== false),
    };
  }
  private refreshStatus(): void {
    if (this.stopped) return;
    const s = this.status();
    const v = this.view;
    if (s.unsent !== v.unsent || s.online !== v.online || s.stalled !== v.stalled || s.fromCache !== v.fromCache) this.emit(s);
  }
  private rebuild(force = false): void {
    if (this.stopped || this.view.phase !== 'ready') return;
    const data = { ...this.view.data } as Record<CollKey, unknown[]>;
    let changed = force;
    for (const { coll, key } of COLLS) {
      if (!this.dirty.has(coll) || !this.server[coll]) continue;
      const docs = composeDocs(this.server[coll], this.overlaysOf(coll));
      this.composed[coll] = docs;
      const items = docs.map((d) => this.item(key, d.body));
      const prev = data[key];
      if (prev.length !== items.length || items.some((x, i) => x !== prev[i])) { data[key] = items; changed = true; }
    }
    this.dirty.clear();
    const s = this.status();
    const v = this.view;
    if (changed || s.unsent !== v.unsent || s.online !== v.online || s.stalled !== v.stalled || s.fromCache !== v.fromCache) {
      this.emit({ data: data as unknown as AppData, ...s });
    }
  }

  // ── 手元の変更 ──
  private ds(coll: string, id: string): DocState {
    const key = `${coll}/${id}`;
    let ds = this.docs.get(key);
    if (!ds) {
      ds = { overlay: emptyOverlay(), timer: null, inflight: [], fields: new Set(), fresh: false, label: '', lost: null };
      this.docs.set(key, ds);
    }
    return ds;
  }
  /** 何も抱えていない状態になったら片付ける */
  private gc(key: string): void {
    const ds = this.docs.get(key);
    if (!ds) return;
    const o = ds.overlay;
    if (ds.timer || ds.inflight.length || ds.lost || o.pending || o.issued.length || o.created || o.deleted) return;
    this.docs.delete(key);
  }
  private serverBody(coll: string, id: string): Body | undefined { return this.server[coll]?.get(id)?.body; }
  /** 控え（outbox）に、いまの「届いたと確認できていない変更」を書く */
  private persist(coll: string, id: string, ds: DocState, kind: 'create' | 'update' | 'delete'): void {
    const body = kind === 'delete' ? null : applyOverlay(this.serverBody(coll, id), ds.overlay);
    const content = body ? { ...body } : null;
    if (content) { delete content.rev; delete content.updatedBy; }
    putOutbox({ uid: this.user.uid, coll, id, kind, fields: [...ds.fields], body: content, label: ds.label });
  }

  private create(coll: string, id: string, body: Body, label: string): void {
    const ds = this.ds(coll, id);
    if (ds.timer) { clearTimeout(ds.timer); ds.timer = null; }
    const rev = genId();
    ds.overlay = { ...emptyOverlay(), created: { ...body, rev } };
    ds.fresh = true;
    ds.label = label;
    for (const k of Object.keys(body)) ds.fields.add(k);
    this.persist(coll, id, ds, 'create');
    this.dirty.add(coll);
    this.send(coll, id, 'create', rev, body, () => createDoc(coll, id, { ...body, rev, updatedBy: this.actor }));
  }
  private patch(coll: string, id: string, patch: Body, label: string): void {
    if (Object.keys(patch).length === 0) return;
    const ds = this.ds(coll, id);
    const o = ds.overlay;
    if (o.deleted) return;
    ds.overlay = { ...o, base: o.base ?? o.created ?? this.serverBody(coll, id), pending: { ...(o.pending ?? {}), ...patch } };
    for (const k of Object.keys(patch)) ds.fields.add(k);
    ds.label = label;
    this.persist(coll, id, ds, ds.fresh ? 'create' : 'update');
    if (ds.timer) clearTimeout(ds.timer);
    ds.timer = setTimeout(() => { ds.timer = null; this.issue(coll, id); this.rebuild(); }, SAVE_DELAY_MS);
    this.dirty.add(coll);
  }
  private remove(coll: string, id: string, label: string): void {
    const ds = this.ds(coll, id);
    if (ds.timer) { clearTimeout(ds.timer); ds.timer = null; }
    ds.overlay = { ...emptyOverlay(), deleted: true };
    ds.fields.clear();
    ds.fresh = false;
    ds.label = label;
    this.persist(coll, id, ds, 'delete');
    this.dirty.add(coll);
    this.send(coll, id, 'delete', genId(), null, () => removeDoc(coll, id));
  }
  /** 待っている変更を送る */
  private issue(coll: string, id: string): void {
    const ds = this.docs.get(`${coll}/${id}`);
    if (!ds || !ds.overlay.pending) return;
    if (ds.timer) { clearTimeout(ds.timer); ds.timer = null; }
    const patch = ds.overlay.pending;
    const rev = genId();
    const body = applyOverlay(this.serverBody(coll, id), ds.overlay);          // 送ったあとの中身の全体（拒否されたときの控え用）
    ds.overlay = { ...ds.overlay, pending: null, issued: [...ds.overlay.issued, { rev, patch }] };
    this.dirty.add(coll);
    this.send(coll, id, 'update', rev, body, () => patchDoc(coll, id, { ...patch, rev, updatedBy: this.actor }));
  }
  private send(coll: string, id: string, kind: Inflight['kind'], rev: string, body: Body | null, fn: () => Promise<void>): void {
    const ds = this.ds(coll, id);
    ds.inflight.push({ rev, kind, body, label: ds.label, at: Date.now() });
    let p: Promise<void>;
    try { p = fn(); } catch (e) { p = Promise.reject(e); }
    p.then(() => this.settled(coll, id, rev, null), (e) => this.settled(coll, id, rev, errorCode(e)));
  }
  /** 書き込みの結果が分かった（code が null なら受理、そうでなければ拒否） */
  private settled(coll: string, id: string, rev: string, code: string | null): void {
    if (this.stopped) return;
    const key = `${coll}/${id}`;
    const ds = this.docs.get(key);
    if (!ds) return;
    const f = ds.inflight.find((x) => x.rev === rev);
    if (!f) return;
    ds.inflight = ds.inflight.filter((x) => x !== f);
    const at = ds.overlay.issued.findIndex((i) => i.rev === rev);
    let o = ds.overlay;
    if (code) {
      // 拒否: 送った変更を手元からも外す（Firestore 側も、送る前の内容に戻している）
      if (at >= 0) o = { ...o, issued: o.issued.filter((i) => i.rev !== rev) };
      if (f.kind === 'create') { o = { ...o, created: undefined }; ds.fresh = false; }
      if (f.kind === 'delete') o = { ...o, deleted: false };
      ds.lost = { ...f, code };
    } else {
      if (at >= 0) o = { ...o, issued: o.issued.slice(at + 1) };
      if (f.kind === 'create') ds.fresh = false;
    }
    ds.overlay = o;
    if (ds.inflight.length === 0 && !ds.overlay.pending) {
      // このドキュメントについて、送るものが無くなった
      if (ds.lost) this.report(coll, ds.lost, code === null);
      ds.lost = null;
      ds.fields.clear();
      removeOutbox(this.user.uid, coll, id);
    }
    this.gc(key);
    this.dirty.add(coll);
    this.rebuild();
    if (code === 'permission-denied' || code === 'unauthenticated') this.scheduleRecheck();
  }
  /** 共有に反映できなかった変更を、利用者に知らせる（案件は控えを残す） */
  private report(coll: string, lost: Inflight & { code: string }, partly: boolean): void {
    if (lost.kind === 'delete') {
      this.hooks.notify('warn', `${lost.label}の削除は、共有データに反映されませんでした（${reason(lost.code)}）。`);
      return;
    }
    let kept = '';
    if (coll === PROJECT_COLL && lost.body) {
      const name = this.hooks.stash(hydrateProject(stripMeta(lost.body) as unknown as Project), this.view.data);
      kept = `編集していた内容は、「この端末だけのデータ」に「${name}」として残しました。`;
    }
    const what = partly ? `${lost.label}への変更の一部` : `${lost.label}への変更`;
    const why = lost.code === 'not-found' ? `${lost.label}は、ほかの端末で削除されていたため、変更を共有データに反映できませんでした。`
      : lost.code === 'permission-denied' ? `${what}は、共有データに書き込む権限がないため、反映されませんでした。`
      : `${what}を、共有データに保存できませんでした（${reason(lost.code)}）。`;
    this.hooks.notify('warn', `${why}${kept}`);
  }

  /** 前回、送る前に閉じられた変更（控え）を引き取って送り直す。必ず「更新」として送る（削除済みなら拒否される） */
  private async adopt(): Promise<void> {
    if (this.stopped || this.view.phase !== 'ready') return;
    const list = await orphans(this.user.uid);
    if (this.stopped || this.view.phase !== 'ready') return;
    for (const e of list) {
      const key = `${e.coll}/${e.id}`;
      const cur = this.docs.get(key);
      if (cur && (cur.inflight.length || cur.overlay.pending)) continue;        // この画面で編集中のものを優先
      if (!COLLS.some((c) => c.coll === e.coll)) { removeOutbox(this.user.uid, e.coll, e.id); continue; }
      const ds = this.ds(e.coll, e.id);
      ds.label = e.label;
      for (const f of e.fields) ds.fields.add(f);
      putOutbox({ uid: e.uid, coll: e.coll, id: e.id, kind: e.kind, fields: e.fields, body: e.body, partial: e.partial, label: e.label });
      const rev = genId();
      if (e.kind === 'delete') {
        this.send(e.coll, e.id, 'delete', rev, null, () => removeDoc(e.coll, e.id));
      } else {
        const patch: Body = {};
        for (const f of e.fields) if (f !== 'rev' && f !== 'updatedBy') patch[f] = e.body ? e.body[f] : undefined;
        this.send(e.coll, e.id, 'update', rev, e.partial ? null : e.body, () => patchDoc(e.coll, e.id, { ...patch, rev, updatedBy: this.actor }));
      }
    }
    if (list.length) this.rebuild();
  }
  /** 共有を使えなくなったとき、送れずに残っている案件の変更を「この端末だけのデータ」に控えとして残す */
  private salvage(why: string): void {
    void orphans(this.user.uid).then((list) => {
      let n = 0;
      for (const e of list) {
        if (e.coll === PROJECT_COLL && e.kind !== 'delete' && e.body && !e.partial) {
          this.hooks.stash(hydrateProject(stripMeta(e.body) as unknown as Project), EMPTY);
          n += 1;
        }
        removeOutbox(e.uid, e.coll, e.id);
      }
      if (n) this.hooks.notify('warn', `${why}、送信前だった案件の変更 ${n} 件を共有データに反映できませんでした。内容は「この端末だけのデータ」に控えとして残しました。`);
    });
  }

  /** 待っている変更を、待たずにすべて送る */
  flush(): void {
    if (this.stopped) return;
    for (const [key, ds] of [...this.docs]) {
      if (!ds.overlay.pending) continue;
      const i = key.indexOf('/');
      this.issue(key.slice(0, i), key.slice(i + 1));
    }
    this.rebuild();
  }
  /** ログアウトの前に呼ぶ。送れるものを送り、それでも残る未送信の件数を返す */
  async settle(): Promise<number> {
    this.flush();
    if (isOnline() && this.status().unsent > 0) await Promise.race([waitPending().catch(() => {}), sleep(4000)]);
    await sleep(50);
    return Math.max(this.status().unsent, this.stopped ? 0 : countOutbox(this.user.uid));
  }

  // ── 画面からの操作（ready のときだけ有効） ──
  /** マスタの置き換え。shown は画面が表示していた内容、next は操作後の内容（差分＝利用者が変えたところだけを送る） */
  setMaster<K extends MasterKey>(key: K, shown: AppData[K], next: AppData[K]): void {
    if (this.view.phase !== 'ready') return;
    const coll = MASTER_COLL[key];
    const before = shown as unknown as (Body & { id: string })[];
    const after = next as unknown as (Body & { id: string })[];
    const d = diffById(before, after);
    const byId = new Map(before.map((x) => [x.id, x]));
    for (const id of d.removed) this.remove(coll, id, labelOf(coll, byId.get(id)));
    for (const x of d.changed) {
      const patch = changedFields(byId.get(x.id)!, x);
      delete patch.id;
      this.patch(coll, x.id, patch, labelOf(coll, x));
    }
    let order = nextOrder(this.composed[coll] ?? []);
    for (const x of d.added) {
      if (this.serverBody(coll, x.id) || this.docs.get(`${coll}/${x.id}`)?.overlay.created) continue;
      this.create(coll, x.id, { ...x, order: order++ }, labelOf(coll, x));
    }
    this.reorder(coll, after.map((x) => x.id));
    this.rebuild();
  }
  /** 画面での並びが、保存されている並び順と違っていたら、並び順を付け直す */
  private reorder(coll: string, seq: string[]): void {
    const docs = composeDocs(this.server[coll] ?? new Map(), this.overlaysOf(coll));
    const want = new Set(seq);
    const cur = docs.filter((d) => want.has(d.id)).map((d) => d.id);
    const have = new Set(cur);
    const target = seq.filter((id) => have.has(id));
    if (cur.length === target.length && cur.every((id, i) => id === target[i])) return;
    const bodies = new Map(docs.map((d) => [d.id, d.body]));
    seq.forEach((id, i) => {
      const b = bodies.get(id);
      if (b && b.order !== i) this.patch(coll, id, { order: i }, labelOf(coll, b));
    });
  }
  addProject(p: Project): void {
    if (this.view.phase !== 'ready') return;
    const body = { ...(p as unknown as Body), updatedAt: Date.now(), order: nextOrder(this.composed[PROJECT_COLL] ?? []) };
    this.create(PROJECT_COLL, p.id, body, labelOf(PROJECT_COLL, p));
    this.rebuild();
  }
  updateProject(id: string, fn: (p: Project) => Project): void {
    if (this.view.phase !== 'ready') return;
    const cur = this.view.data.projects.find((p) => p.id === id);
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    const patch = changedFields(cur as unknown as Body, next as unknown as Body);
    delete patch.id;
    delete patch.updatedAt;
    if (Object.keys(patch).length === 0) return;
    this.patch(PROJECT_COLL, id, { ...patch, updatedAt: Date.now() }, labelOf(PROJECT_COLL, next));
    this.rebuild();
  }
  removeProject(id: string): void {
    if (this.view.phase !== 'ready') return;
    const cur = this.view.data.projects.find((p) => p.id === id);
    if (!cur) return;
    this.remove(PROJECT_COLL, id, labelOf(PROJECT_COLL, cur));
    this.rebuild();
  }
  /** 「この端末だけのデータ」からコピーしてきた案件と、一緒に足すマスタを共有に入れる（既にあるものは上書きしない） */
  importCopy(copy: ProjectCopy): void {
    if (this.view.phase !== 'ready') return;
    for (const key of MASTER_KEYS) {
      const coll = MASTER_COLL[key];
      let order = nextOrder(composeDocs(this.server[coll] ?? new Map(), this.overlaysOf(coll)));
      for (const x of (copy.add[key] ?? []) as unknown as (Body & { id: string })[]) {
        if (this.serverBody(coll, x.id)) continue;
        this.create(coll, x.id, { ...x, order: order++ }, labelOf(coll, x));
      }
    }
    this.addProject(copy.project);
  }

  // ── 初期設定・移行 ──
  /** 旧形式のデータを移さずに、空の状態から使い始める（旧形式のデータはそのまま残る） */
  async startFresh(): Promise<void> {
    if (this.busy || !this.canAdmin()) return;
    this.busy = true;
    this.emit({ job: '共有データを用意しています…', error: '' });
    try {
      await initFresh(defaultDocs(), 'fresh-skip-legacy', this.actor);
      this.busy = false;
      this.emit({ job: '' });
      this.attach();
    } catch (e) {
      this.busy = false;
      this.emit({ job: '', meta: this.lastMeta, error: `共有データを用意できませんでした（${reason(errorCode(e))}）。` });
    }
  }

  /**
   * 旧形式（V1・V2）の共有データを、新しい形式へ移す。
   *   1. 旧形式のデータを読む（読むだけ。書き換えも削除もしない）
   *   2. 移行前バックアップを取る（共有側の別の場所と、操作している端末のファイル）
   *   3. 新しい形式で書く（ドキュメント名は元の ID。やり直しても同じ場所に上書きされるだけで、増えない）
   *   4. サーバーから読み直して、件数と 1 件ずつの内容を照合する
   *   5. 一致して初めて「移行済み」の印を付ける（印が付くまで、どの端末も移行先を使わない）
   * 途中で失敗したら、印は付かない。「やり直す」で最初から安全に実行できる。
   */
  async migrate(): Promise<void> {
    if (this.busy || !this.canAdmin()) return;
    this.busy = true;
    const gen = this.gen;
    this.emit({ phase: 'migrating', job: '以前の形式のデータを読み込んでいます…', report: null, error: '' });
    let begun = false;
    try {
      const legacy = await withTimeout(readLegacy(), 30000);
      const started = await beginMigration(`b${stamp()}`, this.actor);
      if (started !== 'done') {
        begun = true;
        const plan = planMigration(legacy, started.backupId, { partTypes: defaultPartTypes(), composites: defaultComposites() });
        this.hooks.download(`workshop-planner-移行前バックアップ-${stamp()}.json`, legacyAsBackup(legacy));
        this.emit({ job: `移行前のバックアップを保存しています…（${plan.backups.length} 件）` });
        await writeAllServer(plan.backups);
        this.emit({ job: `新しい形式で保存しています…（0 / ${plan.docs.length} 件）` });
        await writeAllServer(plan.docs, (n, total) => this.emit({ job: `新しい形式で保存しています…（${n} / ${total} 件）` }));
        this.emit({ job: '保存した内容を、移行元と照合しています…' });
        const back = new Map<string, Body | null>();
        const extras: string[] = [];
        const planned = new Set([...plan.docs, ...plan.backups].map((d) => `${d.coll}/${d.id}`));
        for (const coll of [...COLLS.map((c) => c.coll), BACKUP_COLL]) {
          for (const d of await withTimeout(readCollServer(coll), 30000)) {
            back.set(`${coll}/${d.id}`, d.body);
            if (coll !== BACKUP_COLL && !planned.has(`${coll}/${d.id}`)) extras.push(`${coll}/${d.id}`);
          }
        }
        const report = verifyMigration(plan, back);
        if (extras.length) report.notes.push(`移行先に、移行元に無いデータが ${extras.length} 件ありました（以前の作業の残りの可能性があります。削除はしていません）。`);
        const record = { ok: report.ok, rows: report.rows, mismatches: report.mismatches.slice(0, 50), notes: report.notes.slice(0, 50) };
        if (!report.ok) {
          await endMigration({ status: 'failed', error: '照合で一致しないデータがありました', report: record, failedAt: Date.now() });
          this.busy = false;
          if (gen === this.gen) this.emit({ phase: 'needs-migration', job: '', report, meta: this.lastMeta, error: '保存した内容が移行元と一致しなかったため、移行を完了していません。以前の形式のデータは変わっていません。' });
          return;
        }
        await endMigration({ status: 'done', finishedAt: Date.now(), finishedBy: this.actor, report: record });
        this.emit({ report });
      }
      this.busy = false;
      if (gen !== this.gen) return;
      this.emit({ job: '共有データを読み込んでいます…', meta: await readMetaServer().catch(() => this.lastMeta) });
      this.attach();
    } catch (e) {
      const why = reason(errorCode(e));
      if (begun) { try { await endMigration({ status: 'failed', error: why, failedAt: Date.now() }); } catch { /* 記録できなくても、印が付かないので未完了のまま */ } }
      this.busy = false;
      if (gen === this.gen) this.emit({ phase: 'needs-migration', job: '', meta: this.lastMeta, error: `移行を完了できませんでした（${why}）。以前の形式のデータは変わっていません。「やり直す」で、最初から安全にやり直せます。` });
    }
  }

  // ── メンバー名簿（管理者用） ──
  listMembers(): Promise<Member[]> { return withTimeout(listMembers(), 15000); }
  /** 追加・役割の変更。問題があれば理由を返す（成功なら空文字） */
  async saveMember(raw: string, role: 'owner' | 'member', current: Member[]): Promise<string> {
    const email = normalizeEmail(raw);
    if (!isValidMemberEmail(email)) return 'メールアドレスの形式が正しくありません。';
    const existing = current.find((m) => m.email === email);
    if (existing && existing.role === 'owner' && role !== 'owner' && current.filter((m) => m.role === 'owner').length <= 1) {
      return '管理者が 1 人もいなくなるため、変更できません（先に別の管理者を登録してください）。';
    }
    try {
      await putMember(email, role, this.email, existing?.addedAt || Date.now());
    } catch (e) {
      return `名簿を変更できませんでした（${reason(errorCode(e))}）。`;
    }
    if (email === this.email) void this.recheck();
    return '';
  }
  async removeMember(email: string, current: Member[]): Promise<string> {
    const m = current.find((x) => x.email === email);
    if (m?.role === 'owner' && current.filter((x) => x.role === 'owner').length <= 1) {
      return '管理者が 1 人もいなくなるため、削除できません（先に別の管理者を登録してください）。';
    }
    try {
      await deleteMember(email);
    } catch (e) {
      return `名簿を変更できませんでした（${reason(errorCode(e))}）。`;
    }
    if (email === this.email) void this.recheck();
    return '';
  }
}

/** 共有データを新しく使い始めるときに入れる初期値（パーツと組み合わせ配置） */
function defaultDocs(): PlannedDoc[] {
  return [
    ...defaultPartTypes().map((x, i) => ({ coll: MASTER_COLL.partTypes, id: x.id, body: { ...(x as unknown as Body), order: i } })),
    ...defaultComposites().map((x, i) => ({ coll: MASTER_COLL.composites, id: x.id, body: { ...(x as unknown as Body), order: i } })),
  ];
}
function countLegacy(l: LegacyData): Record<string, number> {
  const out: Record<string, number> = { projects: l.projects.length };
  for (const k of MASTER_KEYS) out[k] = Array.isArray(l.masters[k]?.items) ? (l.masters[k]!.items as unknown[]).length : 0;
  return out;
}
/** 旧形式のデータを、このアプリの「バックアップから復元」で読める形にする（端末に保存するファイル用） */
function legacyAsBackup(l: LegacyData): Record<string, unknown> {
  const out: Record<string, unknown> = { _kind: 'kkl-workshop-legacy-backup', _team: TEAM_ID, _takenAt: new Date().toISOString() };
  for (const k of MASTER_KEYS) if (Array.isArray(l.masters[k]?.items)) out[k] = l.masters[k]!.items;
  out.projects = l.projects.map((p) => ({ ...p.doc, id: p.id }));
  return out;
}
