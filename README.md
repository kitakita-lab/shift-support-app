# KitaKita Lab ワークショップ運営プランナー

ワークショップ案件（会場 × 期間 × 実施コンテンツ）の **スタッフ配置・収支試算・ブースレイアウト** を1か所で計画・管理する Web アプリ。

- 設計書: [docs/02_新アプリ設計書.md](docs/02_新アプリ設計書.md)
- 旧アプリ調査: [docs/01_旧アプリ調査.md](docs/01_旧アプリ調査.md)
- Version 3 の計画と承認の記録: [docs/03_Version3実装計画.md](docs/03_Version3実装計画.md)
- 判断の記録・作業ログ: [docs/作業ログ.md](docs/作業ログ.md)
- 出力サンプル: [docs/sample/](docs/sample/)
- 旧アプリ（シフト作成サポート）: [archive/shift-app-v1/](archive/shift-app-v1/)

## 起動

```bash
npm install
npm run dev      # 開発サーバー
npm test         # 単体テスト（試算・警告・レイアウト・版数・図の指紋・PDF・サンプルデータ・同期の計算部分）
npm run build    # 型チェック + ビルド
node e2e/verify.mjs      # 実ブラウザ（Chromium）での動作確認。playwright が必要（スクリプト先頭の説明を参照）
node e2e/sync/run.mjs    # 共有データの同期・移行・権限の確認（Firebase エミュレータ上）。Java・firebase-tools・playwright が必要
```

Firebase の設定（`.env`。`.env.example` 参照）が無い場合は、ブラウザ内（localStorage）だけで動く。
まず触ってみるには「データ」タブ →「サンプルデータを読み込む」。案件が 2 件入る（デモと、ラソラ札幌 11/13〜17 の土台。数値はすべて仮置き）。

## データの置き場所

- **この端末だけのデータ**: ブラウザ内に保存。同期しない。サンプルの読み込み・バックアップからの復元は、必ずこちらに入る。
- **共有データ**: ログイン中に使える（Firestore が正）。画面上部の帯で切り替える。置き場所をまたぐのは、案件一覧の「共有へコピー」「端末へコピー」だけ。

共有データを誰が読み書きできるかは、Firestore のセキュリティルールで決まる。メンバー制のルール案は `firestore.v3.rules`（**未デプロイ**）。
適用するまでは、ログインできる Google アカウントなら誰でも読み書きできる。適用の手順は設計書 2.6。

## 構成

```
src/
  types.ts            データモデル
  domain/             純関数（calc=試算, layout=レイアウト操作・番号・版, figure=図の内容と指紋, warnings=入力警告, seed=初期値・サンプル）
  store/              データの置き場所（localData=この端末だけ, sharedSession=共有データの同期, remote=Firestore 入出力,
                      sharedLogic=同期の計算, outbox=未送信の控え, paths=Firestore 上の場所, useAppData=画面との接続）
  export/pdf.ts       配置図の PDF 出力
  components/         Grid（表計算風グリッド）, NumInput（数値欄）, LayoutEditor, LayoutSvg, ProjectView, Masters, Shared（置き場所の帯・案内・メンバー）
  **/*.test.ts        単体テスト（domain/testkit.ts はテスト用の部品）
e2e/verify.mjs        実ブラウザでの動作確認（npm test には含めない）
e2e/sync/             共有データの同期・移行・ルールの確認（エミュレータ上。実際の Firebase にはつながない）
firestore.rules       現在のルール（変更していない）
firestore.v3.rules    メンバー制のルール案（未デプロイ）
archive/shift-app-v1/ 旧アプリ一式
```
