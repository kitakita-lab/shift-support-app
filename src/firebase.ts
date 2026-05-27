import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';

// 必須 env が未設定の場合（Vercel 等で未定義）は初期化をスキップする
export const isFirebaseConfigured = !!(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID
);

let _app: FirebaseApp | null = null;
if (isFirebaseConfigured) {
  _app = getApps().length === 0
    ? initializeApp({
        apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
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
