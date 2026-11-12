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
  /** 共有データの置き場所（チーム名）。未設定なら intention-dev */
  readonly VITE_TEAM_ID?:                     string;
}
