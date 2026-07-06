# Firestore セキュリティルールの管理・デプロイ手順

ルールは `firestore.rules`（リポジトリルート）でコード管理する。
**Firebase コンソール上でルールを直接編集しないこと**（次回デプロイで上書きされるため）。

## ルールの内容

- Google ログイン済みユーザーのみ `teams/intention-dev` 配下を読み書き可能
- それ以外のパスは全て拒否

## デプロイ手順

前提: Firebase CLI がインストール済みであること（`npm install -g firebase-tools`）

```bash
# 1. ログイン（初回のみ）
firebase login

# 2. デプロイ前に現在コンソールに設定されているルールを必ず確認する
#    https://console.firebase.google.com/ → Firestore Database → ルール
#    現行ルールがこのリポジトリの firestore.rules より厳しい場合（例: メール
#    アドレス制限がある場合）は、その条件を firestore.rules に取り込んでから
#    デプロイすること。

# 3. デプロイ（<project-id> は .env の VITE_FIREBASE_PROJECT_ID と同じ値）
firebase deploy --only firestore:rules --project <project-id>
```

## デプロイ後の動作確認（必須）

1. アプリに Google ログインして、スタッフ一覧・現場一覧が表示されること
2. スタッフを1件追加 → ヘッダーに「保存済み」が表示されること
3. 追加したスタッフを削除して元に戻す
4. 別ブラウザ（または別アカウント）でログインし、同期されることを確認

読み取りに失敗する場合はブラウザの開発者コンソールに
`[FS] error(...): permission-denied` が出力される（firestoreService.ts のデバッグログ）。
その場合はコンソールで直前のルールにロールバックできる
（Firestore → ルール → 履歴タブから以前のバージョンを復元）。

## 将来メンバー制にする場合

`teams/{teamId}/members/{uid}` ドキュメントを作成し、`firestore.rules` の条件を
以下に変更する:

```
allow read, write: if request.auth != null
  && exists(/databases/$(database)/documents/teams/intention-dev/members/$(request.auth.uid));
```

メンバー追加はコンソールから `members/{uid}` に空ドキュメントを作成するだけでよい。
