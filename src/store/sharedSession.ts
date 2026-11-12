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
import {
  OutboxEntry, aliveTabs, allEntries, clearOutbox, countOutbox, exclusive, leftovers, otherTabsOpen, putOutbox, removeEntry,
  removeOutbox, retireOwn,
} from './outbox';
import { BACKUP_COLL, FORMAT_VERSION, MASTER_COLL, MASTER_KEYS, MasterKey, PROJECT_COLL, TEAM_ID } from './paths';
import {
  Access, Actor, DocChange, Member, Role, SnapInfo, beginMigration, checkAccess, createDoc, deleteMember, endMigration,
  errorCode, initFresh, listMembers, patchDoc, putMember, readCollServer, readDocServer, readLegacy, readMetaCache, readMetaServer,
  removeDoc, waitPending, watchCollection, watchMeta, withTimeout, writeAllGuarded,
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
/**
 * これより長く送信待ちのままだった変更が送信されたときは、利用者に知らせる。
 * 送信待ちは、つながった時点でそのまま送られる（後から届いた変更が残る）。長く圏外だった端末の変更が届くと、
 * その間にほかの人が同じ項目に行った変更を、古い内容で上書きしてしまう。防ぐ仕組みは無いので、せめて気付けるようにする。
 */
const LATE_MS = 12 * 60 * 60 * 1000;
/** 開いている画面を見分けられない環境（Web Locks が無い）で、これより長く更新の無い控えを「前回の残り」とみなす */
const ORPHAN_AGE_MS = 60 * 1000;

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
// 「いま誰のキャッシュか」を localStorage の印で覚えておき、違うアカウント・ログアウトのときは、使う前に消す。
// キャッシュは、同じブラウザで開いている画面（タブ）すべてが共有しているので、消すのは次のときだけ:
//   - 別のアカウントでログインした
//   - ログアウトした。ただし、この画面がそのキャッシュを使っていたとき、または、ほかに開いている画面が無いとき
//     （処理が遅れた別の画面が、入り直したあとの新しいキャッシュを消してしまわないようにする）
//   どちらの場合も、共有データを 1 度も受け取っていないキャッシュ（登録されていないアカウントのもの）は消さない。
//   消すものが無いうえ、消すたびにほかの画面が読み込み直されるため（2 つの画面が、交互に読み込み直しを続けてしまう）。
// 消すと、ほかの画面の接続は使えなくなるので、消し終えたら知らせる（firebase.ts。知らされた画面は読み込み直す）。
const CACHE_KEY = 'kkl_shared_cache_v2';
const ACCESS_KEY = 'kkl_shared_access_v1';
/** この画面が「このキャッシュを使っている」と認識している印（ログインのたびに変わる） */
let myToken: string | null = null;
let gate: Promise<void> = Promise.resolve();
/** uid＝誰のキャッシュか／token＝そのログインの印／used＝共有データを受け取り始めたか（＝消すべき中身があるか） */
interface Mark { uid: string; token: string; used: boolean }
function readMark(): Mark | null {
  try {
    const m = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Partial<Mark> | null;
    return m && typeof m.uid === 'string' && typeof m.token === 'string' ? { uid: m.uid, token: m.token, used: m.used !== false } : null;
  } catch { return null; }
}
function writeMark(m: Mark | null): void {
  try {
    if (m) localStorage.setItem(CACHE_KEY, JSON.stringify(m));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* 何もしない */ }
}
/** 共有データを受け取り始める（＝端末内キャッシュに入り始める）ときに呼ぶ */
function markCacheUsed(uid: string): void {
  const cur = readMark();
  if (cur && cur.uid === uid && !cur.used) writeMark({ ...cur, used: true });
}
function forgetAccess(): void { try { localStorage.removeItem(ACCESS_KEY); } catch { /* 何もしない */ } }

/** 持ち主の印の確認と消去を、同じブラウザの画面の間で 1 つずつ行う（2 つの画面が同時にログアウトを処理して、二重に消さないため） */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  let locks: LockManager | undefined;
  try { locks = typeof navigator !== 'undefined' ? navigator.locks : undefined; } catch { locks = undefined; }
  return locks?.request ? (locks.request('kkl-shared-cache', fn) as Promise<T>) : fn();
}
export function claimCache(uid: string | null): Promise<void> {
  gate = gate.then(() => oneAtATime(async () => {
    const cur = readMark();
    if (uid === null) {
      if (cur && (cur.token === myToken || !(await otherTabsOpen()))) {
        // 共有データを 1 度も受け取っていないキャッシュ（登録されていないアカウントなど）には、消すものが無い。
        // 消さなければ、ほかの画面を読み込み直させることもない。
        // 消せなかったときは、印を残す（次に開いたときに、もう一度消す）
        if (!cur.used || (await resetDb())) {
          writeMark(null);
          forgetAccess();
        }
      }
      myToken = null;
      return;
    }
    if (cur && cur.uid === uid) { myToken = cur.token; return; }           // 同じアカウントのキャッシュを使う
    if (cur) {                                                             // 別のアカウントの印が残っている
      forgetAccess();
      if (cur.used && !(await resetDb())) { myToken = null; return; }      // 消せなかった: 印は前のアカウントのまま（次に開いたときに、もう一度消す）
    }
    myToken = genId();
    writeMark({ uid, token: myToken, used: false });
  })).catch(() => { /* 消せなくても、未登録のアカウントには購読を始めない */ });
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
/**
 * 前回（この画面を開く前）から引き取った、送信前だった変更の情報。変更そのものは overlay.adopted にある。
 * これがある間は、そのドキュメントへの変更を送らない（先に、共有側の状態を確かめる）。
 */
interface Adopted {
  /** create＝共有側に無かったものを作っていた（届いていなければ、共有側には無い） */
  kind: 'create' | 'update';
  /** 控えに残っていた、変更後の中身。partial なら変えた項目だけ */
  body: Body;
  partial: boolean;
  /** 一連の変更を始めたときの、共有側の印。null＝共有側に無かった */
  baseRev: string | null;
  /** 共有側の印がこのどれかなら、その後だれも触っていない（自分が送った書き込みの印など） */
  revs: string[];
  /** 送信待ちに渡したことがある（＝端末内の送信待ちから、後で送られた可能性がある） */
  sent: boolean;
  /** 控えが書かれた時刻（複数あれば最も古いもの）／引き取った時刻 */
  at: number;
  takenAt: number;
  label: string;
}
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
  /**
   * 届いたと確認できていない一連の変更を始めたときの、共有側の印（rev）。
   * undefined＝一連の変更は無い／null＝共有側に無かった（この画面で作った）／''＝印の無いドキュメント
   */
  baseRev: string | null | undefined;
  /** この一連の変更で送信した書き込みの印（送った順） */
  revs: string[];
  adopted: Adopted | null;
  /** 前回から引き取った「削除」。送り直しはしない。共有側に残っていたら、知らせる */
  adoptedDelete: { label: string; at: number; takenAt: number } | null;
}

/** 中身の比較から除く、付随的な項目（並び順・更新時刻・印・最後に書いた人） */
const BOOKKEEPING = ['order', 'updatedAt', 'rev', 'updatedBy'];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/** 「約 ◯ 時間前」「約 ◯ 日前」 */
function ago(at: number): string {
  const h = Math.max(1, Math.round((Date.now() - at) / 3600000));
  return h < 48 ? `約 ${h} 時間前` : `約 ${Math.round(h / 24)} 日前`;
}
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
  private adopting = false;
  private resolving = false;
  private storageWarned = false;
  /** 長く送信待ちだった変更が送信されたことの知らせ（まとめて 1 件にする） */
  private late: { label: string; at: number }[] = [];
  private lateTimer: ReturnType<typeof setTimeout> | null = null;
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
    // この画面が以前のログインで書いた控えは「前回の残り」に回す（いまのログインで書くものと取り違えないため）
    retireOwn(this.user.uid);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('pagehide', this.onHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    // 表示（未送信の件数など）の更新と、前回の残り（送る前に閉じられた画面の変更）の引き取り
    let n = 0;
    this.ticker = setInterval(() => { this.refreshStatus(); if (++n % 4 === 0) void this.adopt(); }, 3000);
    void this.check();
  }
  stop(): void {
    this.flushLate();
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
    if (this.lateTimer) clearTimeout(this.lateTimer);
    for (const ds of this.docs.values()) if (ds.timer) clearTimeout(ds.timer);
  }
  private onOnline = () => {
    this.refreshStatus();
    if (this.view.phase === 'error') void this.check();
    else void this.adopt();
  };
  private onOffline = () => this.refreshStatus();
  private onFocus = () => { void this.adopt(); };
  // 画面を離れる・閉じるときは、待たずに送る（閉じられても、控え（outbox）が残る）
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
    this.lastMeta = null;
    // 確かめ終わるまでは、前に受け取った内容を持ち続けない（使えなくなっていた場合に、残さないため）
    this.emit({ phase: 'checking', error: '', online: isOnline(), data: EMPTY });
    try {
      await claimCache(this.user.uid);
      if (this.dead(gen)) return;
      // メールアドレスの無いアカウントは、名簿と照合できない（メンバー制では通さない）
      if (!this.email) { this.emit({ phase: 'unregistered', role: 'none' }); return; }
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
        this.emit({ phase: 'unregistered', ...this.status() });
        return;
      }
      let meta: Body | null | undefined;
      if (confirmed) {
        try { meta = await withTimeout(readMetaServer(), 12000); } catch { meta = undefined; }
      }
      // 端末内の控えから読む（接続が使えなくなっていると返ってこないことがあるので、待つ時間を区切る）
      if (meta === undefined) meta = await withTimeout(readMetaCache(), 5000).catch(() => undefined);
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
    // 旧形式を読んでいる間に、ほかの端末が用意を終えていた
    const latest = this.lastMeta;
    if (latest && Number(latest.formatVersion) > FORMAT_VERSION) { this.emit({ phase: 'too-new', meta: latest }); return; }
    if (latest && latest.status === 'done') { this.emit({ meta: latest }); this.attach(); return; }
    if (latest) meta = latest;
    // ログインしただけでは、共有側に何も書き込まない。初期設定も移行も、画面のボタンを押したときだけ行う
    if (!meta && !legacyHasData(legacy)) { this.emit({ phase: 'needs-init', meta, legacyCounts: null }); return; }
    this.emit({ phase: 'needs-migration', meta, legacyCounts: countLegacy(legacy) });
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
      // 「使える状態」の印が外れた（通常は起きない）: 使い続けずに、状態を確かめ直す
      if (!body || body.status !== 'done') void this.check();
    }
  }

  // ── 購読 ──
  private attach(): void {
    if (this.attached || this.stopped) return;
    this.attached = true;
    markCacheUsed(this.user.uid);                    // ここから、共有データが端末内キャッシュに入る
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
  /** 共有側の最新の内容を、いま受け取れているか（圏外・端末内の控えを表示中なら false） */
  private inSync(): boolean {
    return this.attached && isOnline() && COLLS.every((c) => this.cached[c.coll] === false);
  }
  private status(): Pick<SharedView, 'unsent' | 'online' | 'stalled' | 'fromCache'> {
    const keys = new Set<string>();
    let oldest = Infinity;
    for (const [k, ds] of this.docs) {
      if (!ds.overlay.pending && ds.inflight.length === 0 && !ds.adopted && !ds.adoptedDelete) continue;
      keys.add(k);
      for (const f of ds.inflight) oldest = Math.min(oldest, f.at);
      if (ds.adopted) oldest = Math.min(oldest, ds.adopted.takenAt);
      if (ds.adoptedDelete) oldest = Math.min(oldest, ds.adoptedDelete.takenAt);
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
      ds = {
        overlay: emptyOverlay(), timer: null, inflight: [], fields: new Set(), fresh: false, label: '', lost: null,
        baseRev: undefined, revs: [], adopted: null, adoptedDelete: null,
      };
      this.docs.set(key, ds);
    }
    return ds;
  }
  /** 何も抱えていない状態になったら片付ける */
  private gc(key: string): void {
    const ds = this.docs.get(key);
    if (!ds) return;
    const o = ds.overlay;
    if (ds.timer || ds.inflight.length || ds.lost || ds.adopted || ds.adoptedDelete) return;
    if (o.pending || o.issued.length || o.created || o.deleted || o.adopted) return;
    this.docs.delete(key);
  }
  private serverBody(coll: string, id: string): Body | undefined { return this.server[coll]?.get(id)?.body; }
  /** 控え（outbox）に、いまの「届いたと確認できていない変更」を書く */
  private persist(coll: string, id: string, ds: DocState, kind: 'create' | 'update' | 'delete'): void {
    const a = ds.adopted;
    let body: Body | null = null;
    let partial = false;
    if (kind !== 'delete') {
      const full = applyOverlay(this.serverBody(coll, id), ds.overlay);
      if (full) {
        body = { ...full };
      } else {
        // 画面に出せる元の中身が無い（共有側にも手元にも無い）: 変えた項目だけを残す
        body = { ...(a?.body ?? {}), ...(ds.overlay.adopted ?? {}) };
        for (const i of ds.overlay.issued) Object.assign(body, i.patch);
        Object.assign(body, ds.overlay.pending ?? {});
        partial = true;
      }
      delete body.rev;
      delete body.updatedBy;
    }
    const ok = putOutbox({
      uid: this.user.uid, coll, id,
      kind: kind !== 'delete' && a?.kind === 'create' ? 'create' : kind,
      fields: [...ds.fields], body, ...(partial ? { partial: true } : {}), label: ds.label,
      // 引き取った変更を抱えている間は、その「誰も触っていないと分かる印」も一緒に残す
      baseRev: a ? a.baseRev : ds.baseRev ?? null,
      revs: a ? [...a.revs, ...(typeof ds.baseRev === 'string' ? [ds.baseRev] : []), ...ds.revs] : [...ds.revs],
      dirty: !!ds.overlay.pending || !!a,
    });
    if (!ok) this.storageFull();
  }
  private storageFull(): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    this.hooks.notify('warn', 'このブラウザの保存領域がいっぱいのため、送信前の変更の控えを端末に残せませんでした。共有データへの送信は続けます。画面を閉じる前に、右上の表示が「保存済み」になっていることを確認してください。');
  }
  /** このドキュメントについて、届いたと確認できていないものが無くなっていたら、一連の変更を閉じる（控えを消す） */
  private finishIfIdle(coll: string, id: string, ds: DocState): void {
    if (ds.inflight.length || ds.overlay.pending || ds.adopted) return;
    ds.fields.clear();
    ds.baseRev = undefined;
    ds.revs = [];
    if (ds.adoptedDelete) {
      // まだ確かめていない「前回の削除」は、控えに残しておく
      putOutbox({ uid: this.user.uid, coll, id, kind: 'delete', fields: [], body: null, label: ds.adoptedDelete.label, baseRev: null, revs: [], dirty: false });
    } else {
      removeOutbox(this.user.uid, coll, id);
    }
  }

  private create(coll: string, id: string, body: Body, label: string): void {
    const ds = this.ds(coll, id);
    if (ds.timer) { clearTimeout(ds.timer); ds.timer = null; }
    const rev = genId();
    ds.overlay = { ...emptyOverlay(), created: { ...body, rev } };
    ds.adopted = null;
    ds.adoptedDelete = null;
    ds.fresh = true;
    ds.baseRev = null;
    ds.revs = [rev];
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
    const server = this.serverBody(coll, id);
    if (ds.baseRev === undefined) ds.baseRev = server ? (typeof server.rev === 'string' ? server.rev : '') : null;
    ds.overlay = { ...o, base: o.base ?? o.created ?? server, pending: { ...(o.pending ?? {}), ...patch } };
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
    ds.adopted = null;                               // 削除するので、前回の残りを送る必要は無くなった
    ds.adoptedDelete = null;
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
    // 前回の残りを引き取ったままのドキュメントには、まだ送らない（共有側の状態を確かめたあとで、まとめて送る）
    if (ds.adopted) { void this.resolveAdopted(); return; }
    const patch = ds.overlay.pending;
    const rev = genId();
    const body = applyOverlay(this.serverBody(coll, id), ds.overlay);          // 送ったあとの中身の全体（拒否されたときの控え用）
    ds.overlay = { ...ds.overlay, pending: null, issued: [...ds.overlay.issued, { rev, patch }] };
    ds.revs.push(rev);
    this.persist(coll, id, ds, ds.fresh ? 'create' : 'update');
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
      // 長く送信待ちだった変更（作成は、ほかの人の変更を上書きしないので除く）
      if (f.kind !== 'create' && Date.now() - f.at > LATE_MS) this.noteLate(f.kind === 'delete' ? `${f.label}の削除` : f.label, f.at);
    }
    ds.overlay = o;
    if (ds.inflight.length === 0 && !ds.overlay.pending) {
      // このドキュメントについて、この画面から送るものが無くなった
      if (ds.lost) this.report(coll, ds.lost, code === null);
      ds.lost = null;
      this.finishIfIdle(coll, id, ds);
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
  /** 長く送信待ちのままだった変更が送信されたことを、まとめて知らせる */
  private noteLate(label: string, at: number): void {
    this.late.push({ label, at });
    if (this.lateTimer) return;
    this.lateTimer = setTimeout(() => { this.lateTimer = null; this.flushLate(); }, 1500);
  }
  private flushLate(): void {
    const list = this.late;
    this.late = [];
    if (list.length === 0 || this.stopped) return;
    const names = [...new Set(list.map((x) => x.label))];
    const shown = `${names.slice(0, 5).join('、')}${names.length > 5 ? ` ほか ${names.length - 5} 件` : ''}`;
    this.hooks.notify('warn', `この端末で${ago(Math.min(...list.map((x) => x.at)))}に行い、送信待ちのまま残っていた変更が、共有データに送信されました（${shown}）。その間にほかの人が同じ項目を変更していた場合、その変更は上書きされています（後から届いた変更が残る仕組みのため）。心当たりがあれば、内容を確認してください。`);
  }

  // ── 前回の残りの引き取り ──
  /**
   * 前回の残り（書いた画面がもう無い控え）を引き取る。圏外でも行う（画面に重ね、未送信として数えるところまで）。
   * 共有へ送るかどうかは、つながってから、共有側のいまの状態を確かめて決める（resolveAdopted）。
   */
  private async adopt(): Promise<void> {
    if (this.stopped || this.adopting || this.view.phase !== 'ready') return;
    this.adopting = true;
    try {
      await exclusive(async () => {
        const alive = await aliveTabs();
        if (this.stopped || this.view.phase !== 'ready') return;
        const now = Date.now();
        for (const e of leftovers(this.user.uid)) {
          // 書いた画面がまだ開いている控えは、その画面のもの。見分けられない環境では、しばらく更新の無いものだけを引き取る
          if (alive ? alive.has(e.sid) : now - e.at < ORPHAN_AGE_MS) continue;
          this.takeOver(e);
        }
      });
      this.rebuild();
    } catch { /* 引き取れなくても、控えは残っている（次の機会に引き取る） */ } finally {
      this.adopting = false;
    }
    void this.resolveAdopted();
  }
  /** 控えを 1 件、この画面のものとして引き取る（画面に重ね、未送信として数える。まだ送らない） */
  private takeOver(e: OutboxEntry): void {
    removeEntry(e);                                    // 以後は、この画面の控えとして持つ（下で書き直す）
    if (!COLLS.some((c) => c.coll === e.coll)) return;
    const key = `${e.coll}/${e.id}`;
    const ds = this.ds(e.coll, e.id);
    const o = ds.overlay;
    if (o.deleted) return;                             // この画面で削除した（削除を送信中）: 前回の変更は不要
    const now = Date.now();
    if (e.kind === 'delete') {
      ds.adoptedDelete = { label: e.label, at: Math.min(e.at, ds.adoptedDelete?.at ?? e.at), takenAt: ds.adoptedDelete?.takenAt ?? now };
      this.finishIfIdle(e.coll, e.id, ds);             // ほかに送るものが無ければ、「前回の削除」を控えに残す
      return;
    }
    const patch: Body = {};
    if (e.body) for (const f of e.fields) if (f !== 'rev' && f !== 'updatedBy') patch[f] = e.body[f];
    if (!e.body || Object.keys(patch).length === 0) { this.gc(key); return; }   // 中身の無い控え（送るものが分からない）
    const server = this.serverBody(e.coll, e.id);
    const prev = ds.adopted;
    ds.overlay = {
      ...o,
      adopted: { ...(o.adopted ?? {}), ...patch },
      // 共有側に無い（届いていない・削除された）場合も、確かめ終わるまでは画面に出す
      base: o.base ?? o.created ?? server ?? (e.partial ? undefined : e.body),
    };
    ds.adopted = {
      kind: prev?.kind === 'create' || e.kind === 'create' ? 'create' : 'update',
      body: { ...(prev?.body ?? {}), ...e.body },
      partial: (prev ? prev.partial : true) && !!e.partial,
      baseRev: prev ? prev.baseRev : e.baseRev,
      revs: [...(prev?.revs ?? []), ...(prev && e.baseRev !== null ? [e.baseRev] : []), ...e.revs],
      sent: (prev?.sent ?? false) || e.revs.length > 0,
      at: Math.min(prev?.at ?? e.at, e.at),
      takenAt: prev?.takenAt ?? now,
      label: e.label || prev?.label || ds.label,
    };
    for (const f of Object.keys(patch)) ds.fields.add(f);
    if (!ds.label) ds.label = e.label;
    this.persist(e.coll, e.id, ds, ds.fresh ? 'create' : 'update');
    this.dirty.add(e.coll);
  }
  /**
   * 引き取った変更を、共有側のいまの状態を確かめて片付ける（古い内容で、ほかの人の新しい変更を巻き戻さないため）:
   *   - 既に届いていた・内容が同じ → 何もしない
   *   - 誰も触っていない           → 送る（必ず「既にあるものの更新」として。削除されたものは復活しない）
   *   - ほかの人が変更していた・削除されていた → 上書きしない。表示し、案件は控えを残す
   */
  private async resolveAdopted(): Promise<void> {
    if (this.stopped || this.resolving || this.view.phase !== 'ready' || !isOnline()) return;
    const keys = [...this.docs].filter(([, ds]) => ds.adopted || ds.adoptedDelete).map(([k]) => k);
    if (keys.length === 0) return;
    this.resolving = true;
    const gen = this.gen;
    try {
      // 端末内に送信待ちで残っている前回の書き込みが、先にサーバーへ届く（または拒否される）のを待つ
      await Promise.race([waitPending().catch(() => { /* 待てなくても、下で 1 件ずつ確かめる */ }), sleep(8000)]);
      for (const key of keys) {
        if (this.dead(gen) || this.view.phase !== 'ready') return;
        const ds = this.docs.get(key);
        if (!ds || (!ds.adopted && !ds.adoptedDelete)) continue;
        const i = key.indexOf('/');
        const coll = key.slice(0, i);
        const id = key.slice(i + 1);
        let server: Body | null;
        try { server = await withTimeout(readDocServer(coll, id), 10000); } catch { break; }   // 確かめられない → 次の機会に
        if (this.dead(gen) || this.view.phase !== 'ready') return;
        if (this.docs.get(key) !== ds) continue;
        this.decideAdopted(coll, id, ds, server);
      }
    } finally {
      this.resolving = false;
      this.rebuild();
    }
  }
  private decideAdopted(coll: string, id: string, ds: DocState, server: Body | null): void {
    const key = `${coll}/${id}`;
    this.dirty.add(coll);
    const del = ds.adoptedDelete;
    if (del) {
      ds.adoptedDelete = null;
      if (server) this.hooks.notify('warn', `${del.label}の削除が、共有データに反映されていませんでした。必要な場合は、もう一度削除してください。`);
      else if (Date.now() - del.at > LATE_MS) this.noteLate(`${del.label}の削除`, del.at);
    }
    const a = ds.adopted;
    if (!a) { this.finishIfIdle(coll, id, ds); this.gc(key); return; }
    if (!server) { this.leftBehind(coll, id, ds, a.kind === 'create' && a.baseRev === null ? 'missing' : 'deleted', null); return; }
    const patch = ds.overlay.adopted ?? {};
    const rev = typeof server.rev === 'string' ? server.rev : '';
    const differing = Object.keys(patch).filter((f) => !BOOKKEEPING.includes(f) && !sameContent(server[f], patch[f]));
    if (differing.length === 0) {
      // 既に届いていた（または、内容が同じ）。長く送信待ちだったものが届いた場合は、知らせる
      if (a.sent && a.kind !== 'create' && Date.now() - a.at > LATE_MS) this.noteLate(a.label, a.at);
      ds.overlay = { ...ds.overlay, adopted: null };
      ds.adopted = null;
      if (ds.overlay.pending) {
        if (ds.timer) this.persist(coll, id, ds, ds.fresh ? 'create' : 'update');   // 入力中: 止まるのを待ってから送る
        else this.issue(coll, id);
      } else {
        this.finishIfIdle(coll, id, ds);
      }
      this.gc(key);
      return;
    }
    // 共有側の印が「変更を始めたときのもの」か「自分が送ったもの」なら、その後だれも触っていない
    const safe = new Set<string>([...a.revs, ...ds.revs]);
    if (a.baseRev !== null) safe.add(a.baseRev);
    if (typeof ds.baseRev === 'string') safe.add(ds.baseRev);
    if (!safe.has(rev)) { this.leftBehind(coll, id, ds, 'changed', server); return; }
    // 引き取った変更を、今回の変更の下に重ねて送る
    const o = ds.overlay;
    ds.overlay = { ...o, adopted: null, pending: { ...patch, ...(o.pending ?? {}) } };
    ds.adopted = null;
    ds.baseRev = rev;
    this.issue(coll, id);
  }
  /** 引き取った変更を、共有に反映しない場合の表示（上書きしない。案件は「この端末だけのデータ」に控えを残す） */
  private leftBehind(coll: string, id: string, ds: DocState, why: 'deleted' | 'missing' | 'changed', server: Body | null): void {
    const a = ds.adopted;
    if (!a) return;
    const o = ds.overlay;
    const also = !!o.pending;                          // この画面で、その上に重ねた変更もある
    // 控えにする中身: 共有側のいまの内容（無ければ前回の中身）に、反映しなかった変更を重ねたもの
    const content = applyOverlay(server ?? undefined, o) ?? (a.partial ? null : a.body);
    let kept = '';
    if (coll === PROJECT_COLL && content) {
      const name = this.hooks.stash(hydrateProject(stripMeta(content) as unknown as Project), this.view.data);
      kept = `その内容は、「この端末だけのデータ」に「${name}」として残しました${also ? '（今回この画面で行った変更も含みます）' : ''}。`;
    } else if (why !== 'deleted') {
      kept = `必要な場合は、もう一度入力してください${also ? '（今回この画面で行った変更も、反映されていません）' : ''}。`;
    }
    const text = why === 'deleted' ? `${a.label}は、ほかの端末で削除されていたため、前回送信前だった変更を共有データに反映できませんでした。`
      : why === 'missing' ? `前回作成した${a.label}は、共有データに保存されていませんでした（保存の前に画面が閉じられたか、その後に削除されています）。`
      : `${a.label}には、前回送信前だった変更が残っていましたが、その後に共有側で内容が変更されていたため、自動では反映していません（新しい内容を、古い内容で上書きしないため）。`;
    this.hooks.notify('warn', `${text}${kept}`);
    if (ds.timer) { clearTimeout(ds.timer); ds.timer = null; }
    ds.overlay = { ...o, adopted: null, pending: null, base: undefined };
    ds.adopted = null;
    this.finishIfIdle(coll, id, ds);
    this.gc(`${coll}/${id}`);
  }
  /** 共有を使えなくなったとき（名簿から外された）: 送れずに残っている変更を手放す。案件は「この端末だけのデータ」に控えを残す */
  private salvage(why: string): void {
    for (const ds of this.docs.values()) if (ds.timer) clearTimeout(ds.timer);
    this.docs.clear();
    void exclusive(() => {
      let kept = 0;
      let dropped = 0;
      for (const e of allEntries(this.user.uid)) {
        if (e.coll === PROJECT_COLL && e.kind !== 'delete' && e.body && !e.partial) {
          this.hooks.stash(hydrateProject(stripMeta(e.body) as unknown as Project), EMPTY);
          kept += 1;
        } else {
          dropped += 1;
        }
        removeEntry(e);
      }
      if (kept + dropped === 0) return;
      this.hooks.notify('warn', [
        `${why}、送信前だった変更 ${kept + dropped} 件を共有データに反映できませんでした。`,
        kept ? `案件の変更 ${kept} 件は、「この端末だけのデータ」に控えとして残しました。` : '',
        dropped ? `そのほかの ${dropped} 件（スタッフ・会場などの変更や、削除）は、控えを残せないため破棄しました。` : '',
      ].join(''));
    }).catch(() => { /* 控えは残っている */ });
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
      if (this.serverBody(coll, x.id) || this.docs.has(`${coll}/${x.id}`)) continue;
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
  /**
   * 「この端末だけのデータ」からコピーしてきた案件と、一緒に足すマスタを共有に入れる（既にあるものは上書きしない）。
   * 共有側の最新の内容を受け取れていないとき（圏外・端末内の控えを表示中）は、何もせず false を返す
   * （「共有側に無い」と判断したものが実際にはあった場合に、上書きしてしまうため）。
   */
  importCopy(copy: ProjectCopy): boolean {
    if (this.view.phase !== 'ready' || !this.inSync()) return false;
    for (const key of MASTER_KEYS) {
      const coll = MASTER_COLL[key];
      let order = nextOrder(composeDocs(this.server[coll] ?? new Map(), this.overlaysOf(coll)));
      for (const x of (copy.add[key] ?? []) as unknown as (Body & { id: string })[]) {
        if (this.serverBody(coll, x.id) || this.docs.has(`${coll}/${x.id}`)) continue;
        this.create(coll, x.id, { ...x, order: order++ }, labelOf(coll, x));
      }
    }
    this.addProject(copy.project);
    return true;
  }

  // ── 初期設定・移行 ──
  /**
   * 共有データを、空の状態から使い始める（形式の印と、パーツ・組み合わせ配置の初期値を作る）。
   * 以前の形式のデータがある場合も、それには触れない（移さずに始める。以前のデータはそのまま残る）。
   */
  async startFresh(): Promise<void> {
    if (this.busy || !this.canAdmin()) return;
    this.busy = true;
    this.emit({ job: '共有データを用意しています…', error: '' });
    try {
      const result = await initFresh(defaultDocs(), this.view.phase === 'needs-migration' ? 'fresh-skip-legacy' : 'fresh', this.actor);
      this.busy = false;
      this.emit({ job: '' });
      // 既に形式の情報があった（ほかの端末が、用意または移行を始めていた）: 自分では何も作っていない。状態を確かめ直す
      if (result === 'exists') { await this.check(); return; }
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
   * 2〜5 の書き込みは、どれも「いまも自分の試行が有効か」を確かめてから行う（remote.ts）。
   * ほかの端末がやり直した・完了したあとは、古い試行は 1 件も書けない（完了後のデータを、移行前の内容で上書きしない）。
   */
  async migrate(): Promise<void> {
    if (this.busy || !this.canAdmin()) return;
    this.busy = true;
    const gen = this.gen;
    this.emit({ phase: 'migrating', job: '以前の形式のデータを読み込んでいます…', report: null, error: '' });
    let attempt = 0;
    try {
      const legacy = await withTimeout(readLegacy(), 30000);
      const started = await beginMigration(`b${stamp()}`, this.actor);
      if (started !== 'done') {
        attempt = started.attempt;
        const plan = planMigration(legacy, started.backupId, { partTypes: defaultPartTypes(), composites: defaultComposites() });
        this.hooks.download(`workshop-planner-移行前バックアップ-${stamp()}.json`, legacyAsBackup(legacy));
        this.emit({ job: `移行前のバックアップを保存しています…（${plan.backups.length} 件）` });
        await writeAllGuarded(attempt, plan.backups);
        this.emit({ job: `新しい形式で保存しています…（0 / ${plan.docs.length} 件）` });
        await writeAllGuarded(attempt, plan.docs, (n, total) => this.emit({ job: `新しい形式で保存しています…（${n} / ${total} 件）` }));
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
          await endMigration(attempt, { status: 'failed', error: '照合で一致しないデータがありました', report: record, failedAt: Date.now() });
          this.busy = false;
          if (gen === this.gen) this.emit({ phase: 'needs-migration', job: '', report, meta: this.lastMeta, error: '保存した内容が移行元と一致しなかったため、移行を完了していません。以前の形式のデータは変わっていません。' });
          return;
        }
        await endMigration(attempt, { status: 'done', finishedAt: Date.now(), finishedBy: this.actor, report: record });
        this.emit({ report });
      }
      this.busy = false;
      if (gen !== this.gen) return;
      this.emit({ job: '共有データを読み込んでいます…', meta: await readMetaServer().catch(() => this.lastMeta) });
      this.attach();
    } catch (e) {
      const code = errorCode(e);
      if (code === 'superseded') {
        // ほかの端末が移行をやり直した・完了した: この端末の試行は、もう何も書けない。状態を確かめ直す
        this.busy = false;
        this.hooks.notify('info', 'ほかの端末で移行が進められた（または完了した）ため、この端末での移行は中止しました。この端末からは、それ以上書き込んでいません。');
        if (gen === this.gen) { this.emit({ job: '' }); await this.check(); }
        return;
      }
      const why = reason(code);
      if (attempt) { try { await endMigration(attempt, { status: 'failed', error: why, failedAt: Date.now() }); } catch { /* 記録できなくても、印が付かないので未完了のまま */ } }
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
    if (existing && existing.role === 'owner' && role !== 'owner' && effectiveOwners(current).length <= 1) {
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
    const owners = effectiveOwners(current);
    if (owners.some((x) => x.email === email) && owners.length <= 1) {
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

/**
 * 名簿のうち、実際に管理者として通るもの。
 * キーが「小文字にそろえたメールアドレス」でない登録（コンソールから手で作ったものなど）は、ルールの照合に一致しないので数えない。
 */
export function effectiveOwners(members: Member[]): Member[] {
  return members.filter((m) => m.role === 'owner' && m.email === normalizeEmail(m.email) && isValidMemberEmail(m.email));
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
