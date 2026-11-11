# activityLogs の TTL（自動削除）設定手順

操作ログ（`teams/intention-dev/activityLogs`）は `addDoc` で増え続けるため、
Firestore の TTL ポリシーで自動削除する。

## 仕組み

- Firestore の TTL ポリシーは **Timestamp 型フィールド**にのみ設定できる
- 既存の `timestamp` フィールドは number（ミリ秒）のため TTL に使えない
- そのためアプリ側で書き込み時に `expireAt: Timestamp`（**90日後**）を付与している
  （`src/services/activityLogService.ts` の `LOG_RETENTION_DAYS`）
- 表示・並び替えは従来どおり `timestamp` を使用。`expireAt` は削除専用

## Console 側の設定（1回だけ・手動）

### 方法A: Firebase / Google Cloud Console

1. https://console.cloud.google.com/firestore/databases → 対象プロジェクトを選択
2. 左メニュー「時間対応値（TTL）」（英語版: Time-to-live）を開く
3. 「ポリシーを作成」で以下を入力:
   - コレクショングループ: `activityLogs`
   - タイムスタンプ フィールド: `expireAt`
4. 作成 → ステータスが「有効」になるまで待つ（数分〜）

### 方法B: gcloud CLI

```bash
gcloud firestore fields ttls update expireAt \
  --collection-group=activityLogs \
  --project=<project-id> \
  --enable-ttl
```

## 注意事項

- **TTL 設定前に作成された既存ログには `expireAt` が無いため自動削除されない**。
  件数が少なければ放置で実害なし。消したい場合は Console から手動削除する
- TTL の削除は期限から最大72時間程度遅延することがある（Google の仕様）。
  正確なリアルタイム削除ではなく「ストレージが際限なく増えない」ための仕組み
- 削除された分は通常のドキュメント削除としてカウントされる（コストは微小）
- 保持日数を変えたい場合は `LOG_RETENTION_DAYS` を変更する
  （既存ドキュメントの expireAt は変わらない。新規ログから適用）
