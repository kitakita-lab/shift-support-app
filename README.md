# KitaKita Lab ワークショップ運営プランナー

ワークショップ案件（会場 × 期間 × 実施コンテンツ）の **スタッフ配置・収支試算・ブースレイアウト** を1か所で計画・管理する Web アプリ。

- 設計書: [docs/02_新アプリ設計書.md](docs/02_新アプリ設計書.md)
- 旧アプリ調査: [docs/01_旧アプリ調査.md](docs/01_旧アプリ調査.md)
- 判断待ち事項・作業ログ: [docs/作業ログ.md](docs/作業ログ.md)
- 出力サンプル: [docs/sample/](docs/sample/)
- 旧アプリ（シフト作成サポート）: [archive/shift-app-v1/](archive/shift-app-v1/)

## 起動

```bash
npm install
npm run dev      # 開発サーバー
npm test         # 計算・レイアウト・警告・PDF のテスト
npm run build    # 型チェック + ビルド
```

Firebase の設定（`.env`。`.env.example` 参照）が無い場合は、ブラウザ内（localStorage）だけで動く。
まず触ってみるには「データ」タブ →「サンプルデータを読み込む」。

## 構成

```
src/
  types.ts            データモデル
  domain/             純関数（calc=試算, layout=レイアウト操作・番号・版, warnings=入力警告, seed=初期値）
  store/              localStorage + Firestore 同期
  export/pdf.ts       配置図の PDF 出力
  components/         Grid（表計算風グリッド）, LayoutEditor, LayoutSvg, ProjectView, Masters
archive/shift-app-v1/ 旧アプリ一式
```
