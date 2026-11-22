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
npm run test:opencode-probe
npm run test:e2e:smoke
```

`npm install` で同梱の Ink パッチが自動適用されます。依存関係を変更した後に再適用する場合は `npm run patch:dependencies` を実行してください。

Nix flakes を使う場合は、`nix develop` でこのプロジェクト用の Node.js ランタイムと Bun が使えるシェルを開けます。

```bash
nix develop
```

## 貢献の流れ

Issue とあわせた PR の提出を特に歓迎します。バグ修正や小さな改善は、メンテナーの返信や議論の完了を待たずに PR を提出していただいて構いません。

1. Issue を起票して問題や提案する変更を説明し、PR 本文から参照します。同じ変更を扱う既存の Issue があれば、それを利用してください。
2. 変更は小さく、目的を絞ってまとめてください。バグ修正、ドキュメント改善、誤字修正を歓迎します。
3. 新しい振る舞いにはテストを含めてください。
4. PR 提出前に TAKT レビューを実行することをおすすめします。実行は任意です。手順は以下を参照してください。

大規模なリファクタリングや、プロジェクトの設計・互換性に影響する機能追加は、手戻りを避けるため、実装前に Issue で方針を相談することをおすすめします。

## PR 提出前に

### 1. CI チェックをパスする（必須）

```bash
npm run build
npm run lint
npm test
npm run test:it
npm run test:opencode-probe
npm run test:e2e:smoke
```

`npm test` は高速なユニットテストを実行します。DeepSeek の型契約ステップでは `managed/deepseek-harness` をインストールし、製品側の SDK 境界型と実 managed SDK の適合を確認します。通常の build はこの managed インストールを必要としません。実装を終えたら `npm run test:it` で軽い結合テストも確認してください。結合テストを追加・変更した場合は `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単体で実行します。重い結合テストを変更した場合は、PR を提出する前に `npm test -- <test-file>` で対象ファイルも実行してください。`npm run test:opencode-probe` は OpenCode のプロンプトを使ったスモークテストです。

GitHub Actions ではプルリクエスト時に重い結合テストを全件実行します。ローカルでは対象ファイルを指定してください。ローカルで意図的に全件実行する場合は `TAKT_ALLOW_FULL_HEAVY_IT=1 npm run test:it:heavy` を使います。

E2E テストの実行方法と前提条件は [E2E テスト概要](./testing/e2e.md) を参照してください。

### 2. TAKT レビューを実行する（推奨）

TAKT レビューを実行すると問題を早期に発見でき、サマリーを PR に貼るとレビュアーの助けになります。コードを変更しない読み取り専用の `review-takt-default` の利用をおすすめします。入力内容に応じてレビューモードが自動で選ばれます。

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

CodeRabbit が PR をレビューした場合は、各コメントを確認し、必要な修正を行ってください。修正しないと判断した場合は理由を一言残します。すべてのコメントについて対応を決め、スレッドを Resolve してください。

## PR コメントコマンド（権限制限あり）

コメントコマンドは有料の AI API クレジットを消費するため、利用できるアカウントを制限しています。`/review` はリポジトリオーナー・組織メンバー・コラボレーター、`/resolve`・`/ci`・`@takt` はオーナーのコメントに反応します。通常の CI はすべての PR で自動実行されます。追加の実行が必要な場合はコメントで依頼してください。

## コードスタイル

- TypeScript strict mode
- ESLint によるリンティング
- 巧妙なコードより、シンプルで読みやすいコードを優先

## Instruction / facet 変更の動作確認

`InstructionBuilder` や `builtins/{lang}/facets/instructions` など、プロンプトの組み立てに影響する箇所を変更すると、能力の低いモデルでツール呼び出しが不安定になることがあります。ユニットテストだけでは検出できないため、変更したプロンプトで小さな `implement` タスクを1回、実プロバイダで試すことをおすすめします。完了できるか、ツールエラーが何件あるかを確認してください。実プロバイダの費用がかかるため、PR の必須チェックには含めません。

## ライセンス

コードを提供した場合、そのコードに MIT ライセンスを適用することに同意したものとみなされます。
