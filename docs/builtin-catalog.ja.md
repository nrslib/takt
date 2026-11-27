# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されるワークフローとペルソナの一覧です。まず用途に合わせてワークフローを選び、詳細な流れは [ワークフローガイド](./workflows.ja.md) で確認してください。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `default` | 通常の実装。計画、実装、テスト、レビューと修正、要件の最終確認まで進める。 |
| `maintenance` | 既存コードの保守。依頼に関係する箇所を中心に調べて修正する。 |
| `simple` | 小さな開発。変更内容に応じた専門知識を使い、短い手順で実装とレビューを進める。 |
| `pure` | 最小構成の開発。モデルに関連するスキルの選択を任せて進める。 |
| `takt-default` | TAKT 自体の開発。TAKT 固有の知識を加えて実装、レビュー、検証する。 |
| `takt-default-team` | TAKT 自体の開発。固定した担当構成で実装と修正を進める。 |
| `review` | 変更内容に応じた複数の観点でレビューする。 |
| `review-fix` | 複数の観点でレビューし、妥当な指摘を修正して再確認する。 |

`default` と `takt-default` は変更内容に応じてレビュー観点を選びます。選択の仕組みは[ワークフローガイド](./workflows.ja.md)を参照してください。

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🛠️ 開発 | `default` | 通常の実装から要件の最終確認まで進める。 |
|  | `maintenance` | 既存コードを依頼に沿って保守する。 |
|  | `simple` | 小さな変更を短い手順で実装・レビューする。 |
|  | `pure` | 最小構成で実装・レビューする。 |
| 🔍 レビュー | `review` | 変更内容に応じた複数の観点でレビューする。 |
|  | `review-fix` | レビューの指摘を修正して再確認する。 |
|  | `caccia` | CodeRabbit レビューの1反復。渡されたスレッドを判断し、妥当な指摘を修正して判断レポートを出力する。 |
|  | `merge-review` | review、Caccia、CI 待ちの後、評価をコメントして終了する。 |
|  | `merge-review-fix` | 同期し、AIで競合を解消した場合は review-fix を実行する。その後、push → Caccia → 最新 head の CI・レビュー判定 → マージと進める。 |
|  | `merge-review-fix-simple` | `takt merge` の既定。同期し、AIで競合を解消した場合は1体でレビューし、裁定・修正・検証する。その後、push → Caccia → CI・レビュー判定 → マージと進める。 |
|  | `merge-prepare` | 同期し、AIで競合を解消した場合は1体でレビューし、裁定・修正・検証する。push、Caccia、CI 待ちまで進め、人のマージを待つ。 |
|  | `audit-unit` | ユニットテストの全件監査。振る舞いとカバレッジの不足を列挙し、コードを変更せずに、そのまま Issue に貼れるレポートを作成する |
|  | `audit-e2e` | E2E の全件監査。ユーザーフローとカバレッジの不足を列挙し、コードを変更せずに、そのまま Issue に貼れるレポートを作成する |
|  | `audit-security` | セキュリティ全件監査。プロジェクトの全ファイルを1つずつ読んでセキュリティレビューする |
|  | `audit-architecture` | アーキテクチャの全件監査。モジュールと境界を列挙し、コードを変更せずに、そのまま Issue に貼れるレポートを作成する |
| 🏗️ インフラストラクチャ | `terraform` | Terraform IaC 開発ワークフロー（plan → implement → 並列レビュー → 最終ゲート → 修正 → 完了） |
| 🎵 TAKT開発 | `takt-default` | TAKT 固有の知識を使い、実装から最終確認まで進める。 |
|  | `takt-default-team` | 固定した担当構成で TAKT の実装と修正を進める。 |
|  | `auto-improvement-loop` | PR、Issue、新規改善を繰り返し確認し、次のタスクを追加し続けるワークフロー。 |
|  | `review-takt-default` | TAKT開発向け多角レビュー（AIアンチパターン・コーディングレビューを含む） |
|  | `review-fix-takt-default` | レビュー対象を集め、TAKT固有のファセットを使って共通の開発フローを進めるワークフロー。 |
| 📦 レガシー | `cli` | CLI開発向けのファセットを使って共通の開発フローを進めるワークフロー。 |
| 📦 レガシー > ✨ Simple | `simple-mini` | 強いモデルの判断力を信頼する軽量な開発ワークフロー（plan → implement → review ⇄ fix → COMPLETE）。独立したテスト作成と要件充足の最終確認を省き、利用可能な関連SKILLをモデル自身が選ぶ。 |
|  | `simple-frontend` | 強いモデルの判断力に任せ、simple-core にフロントエンド向けナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-backend` | 強いモデルの判断力に任せ、simple-core にバックエンド向けナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-dual` | 強いモデルの判断力に任せ、simple-core にフロントエンドとバックエンドのナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-cqrs` | 強いモデルの判断力に任せ、simple-core にバックエンドと CQRS+ES のナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-dual-cqrs` | 強いモデルの判断力に任せ、simple-core にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
| 📦 レガシー > ⚡ Mini | `simple-mini` | 強いモデルの判断力を信頼する軽量な開発ワークフロー（plan → implement → review ⇄ fix → COMPLETE）。独立したテスト作成と要件充足の最終確認を省き、利用可能な関連SKILLをモデル自身が選ぶ。 |
|  | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。両分野のナレッジを使う。 |
|  | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESのナレッジを使う。 |
| 📦 レガシー > 🎨 フロントエンド | `simple-frontend` | 強いモデルの判断力に任せ、simple-core にフロントエンド向けナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `frontend` | フロントエンド向けファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `frontend-maintenance` | 既存フロントエンドの保守向けファセットを使って共通の開発フローを進めるワークフロー。 |
| 📦 レガシー > ⚙️ バックエンド | `simple-backend` | 強いモデルの判断力に任せ、simple-core にバックエンド向けナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-cqrs` | 強いモデルの判断力に任せ、simple-core にバックエンドと CQRS+ES のナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `backend` | バックエンド向けファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-maintenance` | 既存バックエンドの保守向けファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `backend-cqrs` | バックエンドとCQRS+ESのファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
| 📦 レガシー > 🔧 デュアル | `simple-dual` | 強いモデルの判断力に任せ、simple-core にフロントエンドとバックエンドのナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `simple-dual-cqrs` | 強いモデルの判断力に任せ、simple-core にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを組み合わせたシンプルな開発ワークフロー。 |
|  | `dual` | フロントエンドとバックエンドのファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。両分野のナレッジを使う。 |
|  | `dual-cqrs` | フロントエンド、バックエンド、CQRS+ESのファセットを使って共通の開発フローを進めるワークフロー。 |
|  | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESのナレッジを使う。 |
| 📦 レガシー > 🔍 レビュー | `review-frontend` | フロントエンド特化レビュー（構造・モジュール化・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-fix-frontend` | フロントエンド特化レビュー＋修正ループ（構造・モジュール化・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-backend` | バックエンド特化レビュー（構造・モジュール化・ヘキサゴナルアーキテクチャ・セキュリティ・コーディング） |
|  | `review-fix-backend` | バックエンド特化レビュー＋修正ループ（構造・モジュール化・ヘキサゴナルアーキテクチャ・セキュリティ・コーディング） |
|  | `review-dual` | フロントエンド＋バックエンド特化レビュー（構造・モジュール化・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-fix-dual` | フロントエンド＋バックエンド特化レビュー＋修正ループ（構造・モジュール化・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-dual-cqrs` | フロントエンド＋CQRS+ES特化レビュー（構造・モジュール化・ドメインモデル・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-fix-dual-cqrs` | フロントエンド＋CQRS+ES特化レビュー＋修正ループ（構造・モジュール化・ドメインモデル・コンポーネント設計・セキュリティ・コーディング） |
|  | `review-backend-cqrs` | CQRS+ES特化レビュー（構造・モジュール化・ドメインモデル・セキュリティ・コーディング） |
|  | `review-fix-backend-cqrs` | CQRS+ES特化レビュー＋修正ループ（構造・モジュール化・ドメインモデル・セキュリティ・コーディング） |
|  | `audit-architecture-frontend` | フロントエンド特化のアーキテクチャ監査。UIモジュールと境界を列挙し、コードを変更せずに Issue 化しやすいレポートを作成する |
|  | `audit-architecture-backend` | バックエンド特化のアーキテクチャ監査。サービスモジュールと境界を列挙し、コードを変更せずに Issue 化しやすいレポートを作成する |
|  | `audit-architecture-dual` | フルスタックのアーキテクチャ監査。フロントエンドとバックエンドの境界や、それらをまたぐ接続を列挙し、コードを変更せずに Issue 化しやすいレポートを作成する |
| その他 | `research` | 質問せずに自律的に調査するワークフロー。 |
|  | `deep-research` | 調査で得た情報から新たな問いを見つけ、複数の観点で調べるワークフロー。 |
|  | `magi` | MAGI合議システム。3つの観点から分析し、多数決で判定する。 |
|  | `compound-eye` | 同じ指示を独立した2つの eye へ同時に渡し、両者の回答を統合する複眼レビュー。各 eye のプロバイダーは `runtime.yaml`（`provider.targets.steps` → `eye1` / `eye2`）で割り当てる。ワークフロー自体にはプロバイダー名を書かない。 |

ローカルモデルだけで既存ワークフローを動かす場合は、`runtime.yaml` の `provider.defaults` または `provider.targets` でプロバイダーとモデルを割り当てます。カスタムのハイブリッド構成では通常の `review` ステップをローカルのプロバイダーへ振り分け、高信頼のプロバイダーへ戻す後段のステップに `final-gate` タグを付けます。ワークフロー YAML 自体にはプロバイダー・モデル・プロバイダーオプションのフィールドはありません。

`takt` を実行すると workflow をインタラクティブに選択できます。

マージ用ビルトインは Caccia を明示的に実行します。`merge-review` は `review → caccia → wait_ci → 評価コメント`、`merge-review-fix` と `merge-review-fix-simple` は `sync → commit_and_push → caccia → wait_ci → merge_pr` の順です。AIで競合を解消した場合は、初回・再同期とも `commit_and_push` の前にレビュー・修正を行います。`success` と `skipped` は返された head の CI 待ちへ進みます。`limit` は未解決件数をコメントして ABORT で終了します。効果の失敗は `error` をコメントして ABORT で終了します。Git の push 自体は Caccia を起動しません。PR 公開後の自動 Caccia は[設定リファレンス](./configuration.ja.md#caccia-レビューループ)の有効化条件・除外条件・実行順序に従います。

`merge-review-fix` と `merge-review-fix-simple` は、CIの失敗が確定するたびに、失敗したチェック、run・attempt・jobの参照先、ログ本文、PRの累積差分、関連コードを調査します。フレークやmainでも失敗する欠陥はPRの作業ツリーで原因から修正し、読み取り専用のレビューを経て push → Caccia → CI待ちへ戻ります。修正は最大2周です。

証拠から外部要因と判断した場合だけ、修正回数とは別にCIを1回再実行できます。この再実行をまだ使っていなければ、修正2周後にも使えます。同じHEADの新しいattemptを待ち、すべてのチェックと既存のマージ条件を再確認します。証拠が足りない場合、2周修正しても欠陥が残る場合、修正のレビューがREJECTされた場合、再実行後も失敗する場合は、修正・再実行の回数、最後に失敗したチェックと参照先、調査の要点をPRへコメントしてABORTします。調査・修正レポートは実行記録に残ります。CI待ちがタイムアウトした場合も未解決としてABORTします。`merge-review` はコメントのみ行います。GitHub Actionsのログ取得・再実行に必要な権限がない場合や、プロバイダーが未対応の場合は、その旨を明示します。

## ビルトイン Persona 一覧

| Persona | 説明 |
|---------|-------------|
| **planner** | タスク分析、仕様調査、実装計画 |
| **coder** | 機能実装、バグ修正 |
| **ai-antipattern-reviewer** | AI 固有のアンチパターンレビュー（存在しない API、誤った前提、スコープクリープ） |
| **architecture-reviewer** | アーキテクチャとコード品質のレビュー、仕様準拠の検証 |
| **coding-reviewer** | 実装レベルのコードレビュー: タスク意図と差分に対する具体的なバグ、リグレッション、セキュリティリスク、テスト不足 |
| **frontend-reviewer** | フロントエンド (React/Next.js) のコード品質とベストプラクティスのレビュー |
| **cqrs-es-reviewer** | CQRS+Event Sourcing のアーキテクチャと実装のレビュー |
| **security-reviewer** | セキュリティ脆弱性の評価 |
| **conductor** | Phase 3 判定スペシャリスト: レポート/レスポンスを読み取りステータスタグを出力 |
| **supervisor** | 要件が満たされたか、指摘が解消されたか、再発の記録が引き継がれたかを最終判断 |
| **dual-supervisor** | 複数専門レビューの統合検証とリリース可否判断 |
| **research-planner** | リサーチタスクの計画とスコープ定義 |
| **research-analyzer** | リサーチ結果の解釈と追加調査計画 |
| **research-digger** | 深掘り調査と情報収集 |
| **research-supervisor** | リサーチ品質の検証と完全性の評価 |
| **test-planner** | テスト戦略の分析と、対象全体のテスト計画 |
| **testing-reviewer** | テストを重視したコードレビューと、インテグレーションテストの要件分析 |
| **review-adjudicator** | 証拠に基づいてレビューの指摘を裁定し、修正対象を確定する |
| **terraform-coder** | Terraform IaC の実装 |
| **terraform-reviewer** | Terraform IaC のレビュー |
| **melchior** | MAGI 合議システム: MELCHIOR-1（科学者の観点） |
| **balthasar** | MAGI 合議システム: BALTHASAR-2（母親の観点） |
| **casper** | MAGI 合議システム: CASPER-3（女性の観点） |

`exec-assistant` と `exec-worker` もビルトイン persona ファイルとして存在しますが、これらは `exec` 生成ワークフロー用の内部ペルソナであり、カスタム workflow から直接使うことは想定されていません。

## カスタム Persona

`~/.takt/personas/` に Markdown ファイルとして persona プロンプトを作成できます。

```markdown
# ~/.takt/personas/my-reviewer.md

You are a code reviewer specialized in security.

## Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

workflow YAML の `personas` セクションマップからカスタム persona を参照します。

```yaml
personas:
  my-reviewer: ~/.takt/personas/my-reviewer.md

steps:
  - name: review
    persona: my-reviewer
    # ...
```

## Legacy Persona 別 Provider オーバーライド

> **Deprecated**: `persona_providers` はレガシー設定です。新しい設定には `runtime.yaml` の `provider.targets.personas`（[Configuration Guide](./configuration.ja.md) 参照）を使用してください。legacy モードでは `provider_routing.personas` が raw persona キー、`provider_routing.tags` が step tag、`provider_routing.steps` が step 名をそれぞれルーティングします。`provider_routing` は `persona_providers` より優先されます。

legacy モードでは `~/.takt/config.yaml` の `persona_providers` を使用して、workflow を複製せずに特定の persona を異なる provider にルーティングできます。runtime モードでは `runtime.yaml` の `provider.targets.personas` を使用してください。

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # coder を Codex で実行
  ai-antipattern-reviewer: claude   # レビューアーは Claude を維持
```

legacy モードでは、この設定をすべてのワークフローで使用します。指定したペルソナを使うステップは、`provider_routing` などの優先度が高い設定で上書きされない限り、対応するプロバイダーで実行されます。
