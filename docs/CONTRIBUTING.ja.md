# TAKT への貢献

[English](../CONTRIBUTING.md)

TAKT への貢献に興味を持っていただきありがとうございます。このプロジェクトでは TAKT のレビュー用ワークフローを使って PR の品質を確認しています。

## 開発環境のセットアップ

```bash
git clone https://github.com/your-username/takt.git
cd takt
npm install
npm run build
npm run lint
npm test
npm run test:it
npm run test:prompt-evals
npm run test:e2e:mock
```

Nix flakes を使う場合は、`nix develop` でこのプロジェクト用の Node.js ランタイムと Bun が入ったシェルを開けます:

```bash
nix develop
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
npm run test:it
npm run test:prompt-evals
npm run test:e2e:mock
```

`npm test` は unit gate です。integration・regression・performance テストは `npm run test:it`、決定的な OpenCode prompt smoke suite は `npm run test:prompt-evals` で実行します。`npm test -- <test-file>` は、指定した各 source test を unit、parallel integration、serial Git、serial workflow のいずれか1つへ振り分けます。選択された runner は順番にすべて実行され、最初に失敗した子プロセスの終了コードを返します。リリース担当者は、全 provider の E2E suite を含む完全な release path を `npm run check:release` で検証できます。

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

## PR コメントコマンド（権限制限あり）

このリポジトリの PR にはコメント起動の自動化があります（`.github/workflows/pr-comment-commands.yml`）。これらは有料の AI API クレジットを消費するため、起動できるロールを意図的に制限しています。

| コマンド | 動作 | 起動できるロール |
|---------|------|------------------|
| `/review` | PR に対して TAKT レビューを実行 | OWNER / MEMBER / COLLABORATOR |
| `/resolve` | マージコンフリクトを AI 支援で解決 | OWNER のみ |
| `/ci` | provider E2E スイートを実行（実 API 呼び出し） | OWNER のみ |
| `@takt` | コメント内容を TAKT タスクとして実行 | OWNER のみ |

必要なロールを持たない状態でこれらのコマンドをコメントしても、**何も起きません（ワークフローが起動しない）**。これはバグではなく想定どおりの挙動です。通常の CI（build / lint / unit / integration / mock E2E）はすべての PR で自動実行されます。provider E2E は必要に応じてメンテナーが `/ci` で実行します。provider E2E や TAKT レビューが必要だと思う場合は、コメントでメンテナーに依頼してください。

## コードスタイル

- TypeScript strict mode
- ESLint によるリンティング
- 巧妙なコードより、シンプルで読みやすいコードを優先

## ライセンス

貢献いただいたコードは MIT ライセンスの下でライセンスされることに同意したものとみなされます。
