import { useAuth } from '../contexts/AuthContext';
import { isFirebaseConfigured } from '../firebase';

export default function AuthButton() {
  const { user, loading, signInError, signIn, signOut } = useAuth();

  // Firebase が未設定（Vercel env 未定義等）の場合は何も表示しない
  if (!isFirebaseConfigured) return null;

  if (loading) {
    return <span className="auth-loading">...</span>;
  }

  if (user) {
    return (
      <div className="auth-user">
        {user.photoURL && (
          <img src={user.photoURL} alt="" className="auth-user__avatar" referrerPolicy="no-referrer" />
        )}
        <span className="auth-user__name">{user.displayName ?? user.email}</span>
        <button className="auth-signout-btn" onClick={signOut}>
          ログアウト
        </button>
      </div>
    );
  }

  return (
    <div className="auth-signin-wrap">
      <button className="auth-signin-btn" onClick={signIn}>
        Googleでログイン
      </button>
      {signInError && <span className="auth-error">{signInError}</span>}
    </div>
  );
}
