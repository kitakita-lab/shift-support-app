/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY:             string;
  readonly VITE_FIREBASE_AUTH_DOMAIN:         string;
  readonly VITE_FIREBASE_PROJECT_ID:          string;
  readonly VITE_FIREBASE_STORAGE_BUCKET:      string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID:              string;
  /** '1' のとき、ローカルの Firebase エミュレータにつなぐ（自動テスト専用。本番では設定しない） */
  readonly VITE_FIREBASE_EMULATOR?:           string;
  /**
   * 共有データの置き場所（チーム名）。未設定のとき、通常のチーム（intention-dev）になるのは、本番のビルドだけ。
   * 本番以外で、実際の Firebase につなぐビルドには、通常とは別の名前が必ず要る（無ければ止まる。store/team.ts）
   */
  readonly VITE_TEAM_ID?:                     string;
}

/** ビルドのときの VERCEL_ENV（vite.config.ts が埋め込む。Vercel の外では空文字。埋め込みの無い実行では未定義） */
declare const __KKL_VERCEL_ENV__: string | undefined;
