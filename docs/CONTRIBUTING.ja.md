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

`npm test` は fast unit gate です。4シャードを並列実行し、除外した高負荷unitファイルを出力で通知します。変更範囲が該当する場合は `npm run test:unit:heavy` を実行してください。integration・regression・performance テストは `npm run test:it`、決定的な OpenCode prompt smoke suite は `npm run test:prompt-evals` で実行します。`npm test -- <test-file>` は、指定した各 source test を fast unit、heavy unit、parallel integration、serial Git、serial workflow のいずれか1つへ振り分けます。選択されたrunnerは並列実行され、最初に失敗した子プロセスの終了コードを返します。リリース担当者は、fast unit 4シャード、heavy unit、integration、prompt smoke、全providerのE2E suiteを含む完全なrelease pathを `npm run check:release` で検証できます。

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

コメントコマンドは有料の AI API クレジットを消費するため、権限で制限しています。`/review` はリポジトリオーナー・組織メンバー・コラボレーターのコメントに反応し、`/resolve`・`/ci`・`@takt` はオーナーのみに反応します。外部コントリビューターの PR ではこれらのコマンドは反応しません（ワークフローが起動しません）が、バグではなく想定どおりの挙動です。通常の CI はすべての PR で自動実行されます。追加の実行が必要だと思う場合は、コメントで依頼してください。

## コードスタイル

- TypeScript strict mode
- ESLint によるリンティング
- 巧妙なコードより、シンプルで読みやすいコードを優先

## Instruction / facet 変更時の canary

`InstructionBuilder` や `builtins/{lang}/facets/instructions` などプロンプト組み立てに影響する変更は、ユニットテストでは捕まらない「弱いモデルのツール呼び出し不安定化」を引き起こすことがある（実例: 台帳が空の段階への異議申告ガイド注入で implement が連続失敗）。変更時は実プロバイダでの canary 実行を推奨する。

```bash
npm run build
npm run canary:coder -- --provider opencode --model ollama-cloud/qwen3-coder-next
```

小さな implement 1走を現行の指示組み立てで実行し、完走とツールエラー数を確認する。PR の必須ゲートではない（実プロバイダのコストがかかるため）。

## ライセンス

貢献いただいたコードは MIT ライセンスの下でライセンスされることに同意したものとみなされます。
