# shift-app-v1（旧: シフト作成サポート）— アーカイブ

2026-11-11 に新アプリ（ワークショップ運営プランナー）へ作り替えた際、旧実装をここへ退避した。
ファイルは `git mv` で移動しているため、`git log --follow` で履歴を追える。

- 自動シフト割当て・CSV/Excel 取込などは新アプリに引き継いでいない。
- 旧データ（Firestore `teams/intention-dev/appData/*`）は新アプリからは読み書きしない。

## 単体で動かす場合

```bash
cd archive/shift-app-v1
cp ../../.env .env   # Firebase を使う場合のみ
npm install
npm run dev
```

（`package.json` などの設定ファイルは退避時点のコピー。動作確認は退避後には行っていない）
