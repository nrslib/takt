# TAKT への貢献

[English](../CONTRIBUTING.md)

TAKT への貢献に興味を持っていただきありがとうございます。このプロジェクトでは TAKT のレビュー用ワークフローを使って PR の品質を確認しています。

## 開発環境のセットアップ

```bash
git clone https://github.com/your-username/takt.git
cd takt
npm install
npm run build
npm test
npm run lint
```

## 貢献の流れ

1. **Issue を起票** して変更内容を議論する
2. **小さく焦点を絞った変更** にする — バグ修正、ドキュメント改善、typo 修正を歓迎します
3. 新しい振る舞いには **テストを含める**
4. PR 提出前に **TAKT レビューを実行する** — 必須ではなく推奨（下記参照）

事前議論なしの大規模リファクタリングや機能追加はレビューが困難なため、お断りする場合があります。

## PR 提出前に

### 1. CI チェックをパスする（必須）

```bash
npm run build
npm run lint
npm test
```

E2E テストの実行方法と前提条件は [E2E テスト概要](./testing/e2e.md) を参照してください。

### 2. TAKT レビューを実行する（推奨）

TAKT レビューの実行は**任意ですが推奨**です。問題を早期に発見でき、サマリーを貼るとレビュアーの助けになります。コードを自動改変しない読み取り専用の `review-takt-default` の利用をおすすめします。入力内容からレビューモードを自動判定します:

```bash
# PR モード — PR番号を指定してレビュー
takt -t "#<PR番号>" -w review-takt-default

# ブランチモード — ブランチのmainとの差分をレビュー
takt -t "<ブランチ名>" -w review-takt-default

# 現在の差分モード — 未コミットや直近の変更をレビュー
takt -t "review current changes" -w review-takt-default
```

`.takt/runs/*/reports/review-summary.md` のレビューサマリーを確認してください。結果が **REJECT** の場合は指摘に対応し、誤検知や意図的な設計判断であればその理由を残してください。サマリーの PR への投稿は歓迎しますが必須ではありません。

### 3. CodeRabbit のコメントに対応する

CodeRabbit が PR をレビューした場合は、各コメントについて対応すべきかどうかを判断し、対応すべきものに対応してください。**すべてのスレッドを Resolve してください** — 変更を加えた場合も、対応しないと判断した場合も（その場合は理由を一言残す）Resolve します。未対応・未 Resolve のまま放置しないでください。

## コードスタイル

- TypeScript strict mode
- ESLint によるリンティング
- 巧妙なコードより、シンプルで読みやすいコードを優先

## ライセンス

貢献いただいたコードは MIT ライセンスの下でライセンスされることに同意したものとみなされます。
