import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth, connectAuthEmulator, signInWithCredential } from 'firebase/auth';
import { getFirestore, Firestore, connectFirestoreEmulator } from 'firebase/firestore';

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
export const db:             Firestore      | null = _app ? getFirestore(_app)      : null;

// ── 検証用: ローカルの Firebase エミュレータにつなぐ ─────────────────────
// VITE_FIREBASE_EMULATOR=1 を付けて起動したときだけ有効（e2e/sync の自動テストが使う）。
// 本番・プレビューのビルドでは設定しないこと。設定しなければ、この部分はビルドに含まれない。
// 念のため、架空のプロジェクト（ID が demo- で始まる）かつ自分の PC 上（localhost）でしか有効にしない。
export const isEmulator =
  import.meta.env.VITE_FIREBASE_EMULATOR === '1' &&
  String(import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '').startsWith('demo-') &&
  typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

if (isEmulator && auth && db) {
  const _auth = auth;
  connectAuthEmulator(_auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  // テストからログイン・ログアウトするための入口（エミュレータは署名なしの身元情報を受け付ける）
  (window as unknown as { __kkl: unknown }).__kkl = {
    emulator: true,
    signInAs: (email: string, opts: { verified?: boolean; name?: string } = {}) =>
      signInWithCredential(_auth, GoogleAuthProvider.credential(JSON.stringify({
        sub: `uid-${email.toLowerCase()}`, email, email_verified: opts.verified ?? true, name: opts.name ?? email.split('@')[0],
      }))),
    signOut: () => _auth.signOut(),
  };
}
