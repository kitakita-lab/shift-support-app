import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInError: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,        setUser]        = useState<User | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) { setLoading(false); return; }
    const _auth = auth;

    // Safari Private モード対策: localStorage が利用できない場合 sessionStorage にフォールバック
    setPersistence(_auth, browserLocalPersistence)
      .catch(() => setPersistence(_auth, browserSessionPersistence))
      .catch(() => {});

    // signInWithRedirect からの戻りを処理
    getRedirectResult(_auth)
      .then((result) => {
        if (result) console.debug('[Auth] redirect result user:', result.user.email);
      })
      .catch((err: unknown) => {
        console.debug('[Auth] getRedirectResult error:', (err as { code?: string })?.code, err);
      });

    const unsubscribe = onAuthStateChanged(_auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async () => {
    if (!auth || !googleProvider) return;
    setSignInError(null);

    // デバッグ: 認証開始時の URL を記録
    console.debug('[Auth] signIn start — origin:', window.location.origin, '| href:', window.location.href);

    try {
      await signInWithPopup(auth, googleProvider);
      console.debug('[Auth] signInWithPopup success');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      console.debug('[Auth] signInWithPopup error — code:', code, err);

      // ユーザー自身がポップアップを閉じた場合はエラー表示しない
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;

      if (code === 'auth/popup-blocked') {
        // Safari Private 等でポップアップがブロックされた場合 → redirect にフォールバック
        // redirect 前に sessionStorage ベースの永続化へ切り替え（Safari ITP 対策）
        await setPersistence(auth, browserSessionPersistence).catch(() => {});
        console.debug('[Auth] popup blocked → signInWithRedirect — href:', window.location.href);
        await signInWithRedirect(auth, googleProvider);
        return;
      }

      setSignInError(`ログインに失敗しました（${code}）`);
    }
  };

  const signOut = async () => {
    if (!auth) return;
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInError, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
