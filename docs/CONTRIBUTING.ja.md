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
npm run test:e2e:mock
```

Nix flakes を使う場合は`nix develop` でこのプロジェクト用の Node.js ランタイムと Bun が入ったシェルを開けます:

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
npm run test:opencode-probe
npm run test:e2e:mock
```

`npm test` は開発中に反復する fast unit gate です。ローカルの unit は `availableParallelism()` を基にした適応型（最大8）シャードで実行し、10並列のマシンでは8シャードを維持します。メインの Pull Request CI は8つの独立 runner に固定分割します。CIでは wall-clock 短縮を優先するため、各 runner で `npm ci` と `npm run build` の固定コストが繰り返され、runner minutes は増加します。実装完了時は `npm run test:it` を実行し、実 filesystem・bounded storage・複数コンポーネント契約を扱う軽いITを確認してください。重いITはローカルでは1 workerで実行し、Pull Request の CI では独立 runner にシャード分割して、実 child process・Git・完全な engine・integration/regression/performance suite・計測済みの高負荷 serial group を確認します。ITを追加・変更した場合は `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単体実行してください。重いITの場合はPRへ渡す前に `npm test -- <test-file>` でそのファイルも自分で実行し、PR全件実行を初回確認にしてはいけません。決定的なOpenCode prompt smoke suiteは `npm run test:opencode-probe` で実行します。リリース担当者は `npm run check:release` で、adaptive local fast unit、軽いIT、重いIT、全providerのE2E suiteを含む完全なローカル release pathを検証できます。8シャードの unit matrix はメインの Pull Request CI の別経路であり、ローカルの `check:release` はその matrix を実行しません。

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

CodeRabbit が PR をレビューした場合は各コメントについて対応すべきかどうかを判断し、対応すべきものに対応してください。**すべてのスレッドを Resolve してください** — 変更を加えた場合も、対応しないと判断した場合も（その場合は理由を一言残す）Resolve します。未対応・未 Resolve のまま放置しないでください。

## PR コメントコマンド（権限制限あり）

コメントコマンドは有料の AI API クレジットを消費するため、権限で制限しています。`/review` はリポジトリオーナー・組織メンバー・コラボレーターのコメントに反応し、`/resolve`・`/ci`・`@takt` はオーナーのみに反応します。外部コントリビューターの PR ではこれらのコマンドは反応しません（ワークフローが起動しません）が、バグではなく想定どおりの挙動です。通常の CI はすべての PR で自動実行されます。追加の実行が必要だと思う場合はコメントで依頼してください。

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
