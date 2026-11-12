import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth, connectAuthEmulator, signInWithCredential } from 'firebase/auth';
import {
  Firestore, clearIndexedDbPersistence, connectFirestoreEmulator, getFirestore, initializeFirestore,
  persistentLocalCache, persistentMultipleTabManager, terminate,
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
function createDb(app: FirebaseApp): Firestore {
  let d: Firestore;
  try {
    d = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
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

/**
 * 端末内キャッシュを消して、Firestore への接続を作り直す。
 * ログアウト・アカウントの切り替え時に呼ぶ（前のアカウントで読んだ共有データを端末に残さない。
 * 未送信の変更も破棄されるので、呼ぶ前に利用者へ確認すること）。
 */
export async function resetDb(): Promise<void> {
  if (!_app || !_db) return;
  const old = _db;
  try { await terminate(old); } catch { /* 既に終了している */ }
  try { await clearIndexedDbPersistence(old); } catch { /* 別のタブが開いている等。消せなくても、未登録のアカウントには読ませない（useSharedData） */ }
  _db = createDb(_app);
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
