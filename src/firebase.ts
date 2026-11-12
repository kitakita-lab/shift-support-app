import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth, connectAuthEmulator, signInWithCredential } from 'firebase/auth';
import {
  Firestore, clearIndexedDbPersistence, connectFirestoreEmulator, getFirestore, initializeFirestore,
  memoryLocalCache, persistentLocalCache, persistentMultipleTabManager, terminate,
} from 'firebase/firestore';

// 必須 env が未設定の場合（Vercel 等で未定義）は初期化をスキップする
export const isFirebaseConfigured = !!(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID
);

let _app: FirebaseApp | null = null;
if (isFirebaseConfigured) {
  // authDomain: https:// プレフィックスを除去し、未設定時は {projectId}.firebaseapp.com にフォールバック
  const rawAuthDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const authDomain = rawAuthDomain
    ? rawAuthDomain.replace(/^https?:\/\//, '')
    : `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`;

  _app = getApps().length === 0
    ? initializeApp({
        apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain,
        projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
        storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId:             import.meta.env.VITE_FIREBASE_APP_ID,
      })
    : getApp();
}

export const auth:           Auth           | null = _app ? getAuth(_app)           : null;
export const googleProvider: GoogleAuthProvider | null = _app ? new GoogleAuthProvider() : null;

// ── 検証用: ローカルの Firebase エミュレータにつなぐ ─────────────────────
// VITE_FIREBASE_EMULATOR=1 を付けて起動したときだけ有効（e2e/sync の自動テストが使う）。
// 本番・プレビューのビルドでは設定しないこと。設定しなければ、この部分はビルドに含まれない。
// 念のため、架空のプロジェクト（ID が demo- で始まる）かつ自分の PC 上（localhost）でしか有効にしない。
export const isEmulator =
  import.meta.env.VITE_FIREBASE_EMULATOR === '1' &&
  String(import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '').startsWith('demo-') &&
  typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

// ── Firestore ───────────────────────────────────────────────
// 共有データは Firestore を正とする（端末側に別のコピーは持たない）。
// 端末内キャッシュを有効にしておくと、圏外で行った変更は送信待ちとして残り、画面を閉じても次に開いたときに送られる。
function createDb(app: FirebaseApp, memoryOnly = false): Firestore {
  let d: Firestore;
  try {
    d = initializeFirestore(app, {
      localCache: memoryOnly ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    // 端末内キャッシュが使えない環境（プライベートブラウズ等）や初期化済みの場合は、メモリ上だけで動かす
    d = getFirestore(app);
  }
  if (isEmulator) connectFirestoreEmulator(d, '127.0.0.1', 8085);
  return d;
}

let _db: Firestore | null = _app ? createDb(_app) : null;
export function getDb(): Firestore | null { return _db; }

// ── 接続の作り直し ─────────────────────────────────────────────
// 端末内キャッシュ（IndexedDB）は、同じブラウザで開いている画面（タブ）すべてが共有している。
// 1 つの画面がキャッシュを消すと、ほかの画面の接続は使えなくなる（読み書きが返ってこなくなる）。
// 消し終えたらほかの画面へ知らせ、知らされた画面は読み込み直す（useAppData.ts）。
const TAB = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('kkl-firestore-v1') : null;
const resetListeners = new Set<() => void>();
/** ほかの画面がキャッシュを消した（＝この画面の接続は使えなくなった）ときに呼ばれる */
export function onDbResetElsewhere(cb: () => void): () => void {
  resetListeners.add(cb);
  return () => { resetListeners.delete(cb); };
}
channel?.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data as { type?: string; from?: string } | null;
  if (m?.type === 'reset' && m.from !== TAB) for (const cb of [...resetListeners]) cb();
});
/** 終わったら true。失敗、または一定時間で終わらなければ false（ほかの画面の都合で、返ってこないことがあるため） */
const done = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

/**
 * 端末内キャッシュ（閲覧用の控えと、送信待ちの書き込み）を消して、Firestore への接続を作り直す。
 * ログアウト・アカウントの切り替え・名簿から外されたときに呼ぶ。
 * 送信待ちの書き込みも消える（送信前だった変更は、控え（outbox）に残っている）。
 * 消せたら true。消せなかった場合は false を返し、この画面は端末内キャッシュを使わずに（メモリ上だけで）動かす
 * （消せなかったキャッシュに残っている、前のアカウントの送信待ちに触れないため）。
 */
export async function resetDb(): Promise<boolean> {
  if (!_app || !_db) return true;
  const old = _db;
  await done(terminate(old), 5000);
  const cleared = await done(clearIndexedDbPersistence(old), 8000);
  _db = createDb(_app, !cleared);
  if (cleared) { try { channel?.postMessage({ type: 'reset', from: TAB }); } catch { /* 知らせられなくても続ける */ } }
  return cleared;
}

if (isEmulator && auth) {
  const _auth = auth;
  connectAuthEmulator(_auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  // テストからログイン・ログアウトするための入口（エミュレータは署名なしの身元情報を受け付ける）
  (window as unknown as { __kkl: unknown }).__kkl = {
    emulator: true,
    format: 'v3',
    signInAs: (email: string, opts: { verified?: boolean; name?: string } = {}) =>
      signInWithCredential(_auth, GoogleAuthProvider.credential(JSON.stringify({
        sub: `uid-${email.toLowerCase()}`, email, email_verified: opts.verified ?? true, name: opts.name ?? email.split('@')[0],
      }))),
    signOut: () => _auth.signOut(),
  };
}
