// 日報を読むための Google の認証（アクセストークン）を得る。
//
// - アプリにログイン中の Google アカウントで、読み取り専用の権限（spreadsheets.readonly）を、同期のときだけ追加で求める。
//   ふだんのログイン（AuthContext）には、この権限を付けない。
// - 得たアクセストークンは、このタブのメモリにだけ置く（localStorage・Firestore には保存しない）。
//   有効期限（約 1 時間）が切れたら、次の同期でもう一度 Google の画面を通る。
// - サーバー側の鍵・サービスアカウントは使わない（このアプリにサーバーは無い）。
import { GoogleAuthProvider, reauthenticateWithPopup } from 'firebase/auth';
import { auth, isEmulator } from '../firebase';
import { ReportError } from './sheets';

/** スプレッドシートの読み取り専用の権限。書き込みはできない */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
/** 取得してから、この時間まで使い回す（Google のアクセストークンの有効期限は 60 分） */
const KEEP_MS = 50 * 60 * 1000;

let cached: { uid: string; token: string; until: number } | null = null;

export function forgetSheetsToken(): void { cached = null; }

/**
 * 認証を得る。覚えているものが無ければ、Google の画面（ポップアップ）を開く。
 * ポップアップは、利用者の操作（タップ）の中で開く必要がある（Safari は、そうでないものを止める）。
 * そのため、この関数は「タップの処理の中で、何も待たずに」呼ぶこと。
 */
export function requestSheetsToken(): Promise<string> {
  const user = auth?.currentUser;
  if (!auth || !user) {
    return Promise.reject(new ReportError('sign-in', '日報の同期には、Google でのログインが必要です。画面右上の「Googleでログイン」からログインしてください。'));
  }
  if (cached && cached.uid === user.uid && cached.until > Date.now()) return Promise.resolve(cached.token);
  cached = null;

  // 自動テスト（エミュレータ）では、Google の画面を出さずに、テストが用意した値を使う
  if (isEmulator) {
    const hook = (window as unknown as { __kkl?: { sheetsToken?: () => string | Promise<string> } }).__kkl?.sheetsToken;
    if (hook) return Promise.resolve(hook());
  }

  const provider = new GoogleAuthProvider();
  provider.addScope(SHEETS_SCOPE);
  // ログイン中のアカウントをあらかじめ選んでおく（別のアカウントを選ぶと、日報を読めないことがあるため）
  if (user.email) provider.setCustomParameters({ login_hint: user.email });

  return reauthenticateWithPopup(user, provider).then((result) => {
    const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
    if (!token) throw new ReportError('sign-in', 'Google から認証を受け取れませんでした。もう一度「日報を同期」を押してください。');
    cached = { uid: user.uid, token, until: Date.now() + KEEP_MS };
    return token;
  }, (e: unknown) => {
    const code = (e as { code?: string })?.code ?? '';
    if (code === 'auth/popup-blocked') {
      throw new ReportError('popup-blocked', 'Google の確認画面（ポップアップ）を開けませんでした。ブラウザの設定でポップアップを許可してから、もう一度「日報を同期」を押してください。');
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') {
      throw new ReportError('popup-closed', 'Google の確認画面が閉じられたため、同期していません（実績は前回のままです）。');
    }
    if (code === 'auth/user-mismatch') {
      throw new ReportError('wrong-account', `Google の確認画面で、ログイン中とは別のアカウントが選ばれました。${user.email ? `「${user.email}」を選んで、` : ''}もう一度お試しください。`);
    }
    if (code === 'auth/network-request-failed') {
      throw new ReportError('network', 'Google の認証に接続できませんでした。接続を確認して、もう一度お試しください。');
    }
    throw new ReportError('sign-in', `Google の認証に失敗しました（${code || '不明なエラー'}）。もう一度お試しください。`);
  });
}
