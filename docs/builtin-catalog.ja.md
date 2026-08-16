# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン workflow と persona の総合カタログです。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `simple` | 強いモデルの判断力を信頼するシンプルな開発 workflow です。モデル自身が関連 SKILL を選び、計画 → テスト作成 → 実装 → コードレビュー → 修正ループ → 要件充足の最終確認 → 完了。 |
| `simple-mini` | 強いモデルの判断力を信頼する軽量版です。独立したテスト作成と要件充足の最終確認を省き、計画 → 実装 → コードレビュー → 修正ループ → 完了。 |
| `default` | 共通開発フローを標準ファセットで実行するテスト先行開発ワークフロー。 |
| `default-mini` | 標準ファセットを共通Mini開発フローへ注入する、テスト作成ステップなしの軽量ワークフロー。 |
| `default-high` | 共通開発コアを直接実装で使い、専門ピアレビュー、収束修正、follow-up review、要件充足の最終確認まで行うフルスペック workflow です。 |
| `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| `backend` | バックエンド向けファセットを共通開発フローへ注入するワークフロー。 |
| `dual` | フロントエンドとバックエンドのファセットを共通開発フローへ注入するワークフロー。 |

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `simple` | 強いモデルの判断力を信頼するシンプルな開発 workflow。モデル自身が関連 SKILL を選び、計画 → テスト作成 → 実装 → コードレビュー → 修正ループ → 要件充足の最終確認 → 完了。 |
| | `default` | 共通開発フローを標準ファセットで実行するテスト先行開発ワークフロー。 |
| | `default-mini` | 標準ファセットを共通Mini開発フローへ注入する、テスト作成ステップなしの軽量ワークフロー。 |
| | `default-high` | 共通開発コアを直接実装で使い、専門ピアレビュー、収束修正、follow-up review、要件充足の最終確認まで行うフルスペック workflow です。 |
| | `cli` | CLI開発向けファセットを共通開発フローへ注入するワークフロー。 |
| | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `backend` | バックエンド向けファセットを共通開発フローへ注入するワークフロー。 |
| | `dual` | フロントエンドとバックエンドのファセットを共通開発フローへ注入するワークフロー。 |
| ✨ Simple | `simple` | 強いモデルの判断力を信頼する汎用版。モデル自身が関連 SKILL を選び、最小限の構成で開発を進める。 |
| | `simple-mini` | 強いモデルの判断力を信頼し、独立したテスト作成と要件充足の最終確認を省いた軽量版。 |
| | `simple-frontend` | 強いモデル向けの簡潔なフロントエンド版。frontend、React、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-backend` | 強いモデル向けの簡潔なバックエンド版。backend、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-dual` | 強いモデル向けの簡潔なデュアル版。frontend、React、backend、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-cqrs` | 強いモデル向けの簡潔な CQRS+ES 版。backend、CQRS+ES、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-dual-cqrs` | 強いモデル向けの簡潔なデュアル CQRS+ES 版。frontend、React、backend、CQRS+ES、security、architecture、testing のナレッジとポリシーを注入する。 |
| ⚡ Mini | `simple-mini` | 強いモデルの判断力を信頼する軽量版。独立したテスト作成と要件充足の最終確認を省き、計画 → 実装 → コードレビュー → 修正ループ → 完了。 |
| | `default-mini` | 標準ファセットを共通Mini開発フローへ注入する、テスト作成ステップなしの軽量ワークフロー。 |
| | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。フロントエンド＋バックエンドのナレッジ注入付き。 |
| | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESナレッジ注入付き。 |
| 🎨 フロントエンド | `simple-frontend` | 強いモデル向け。`simple-core` にフロントエンド向けナレッジとポリシーを注入するシンプル版。 |
| | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| | `frontend-maintenance` | （実験的）既存プロダクト改修向けのフロントエンド workflow。現行の規約を尊重し変更をスコープ内に収める、保守スコープの plan/implement/test/fix/supervise。現状はやや過剰に動くことがあるため、出発点として使い調整する。 |
| ⚙️ バックエンド | `simple-backend` | 強いモデル向け。`simple-core` にバックエンド向けナレッジとポリシーを注入するシンプル版。 |
| | `simple-cqrs` | 強いモデル向け。`simple-core` にバックエンドと CQRS+ES のナレッジとポリシーを注入するシンプル版。 |
| | `backend` | バックエンド向けファセットを共通開発フローへ注入するワークフロー。 |
| | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| | `backend-maintenance` | バックエンド本番保守向け厳密 workflow。専門ピアレビュー、収束修正、follow-up review、要件充足の最終確認を行う。 |
| | `backend-cqrs` | CQRS+ES 特化バックエンド開発 workflow。CQRS+ES 知識を注入した専門ピアレビューと収束修正付き。 |
| | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。 |
| 🔧 デュアル | `simple-dual` | 強いモデル向け。`simple-core` にフロントエンドとバックエンドのナレッジとポリシーを注入するシンプル版。 |
| | `simple-dual-cqrs` | 強いモデル向け。`simple-core` にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを注入するシンプル版。 |
| | `dual` | フロントエンドとバックエンドのファセットを共通開発フローへ注入するワークフロー。 |
| | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。フロントエンド＋バックエンドのナレッジ注入付き。 |
| | `dual-cqrs` | フロントエンド＋バックエンド開発 workflow (CQRS+ES 特化)。CQRS+ES、frontend、security、testing レビューと収束修正付き。 |
| | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESナレッジ注入付き。 |
| 🏗️ インフラストラクチャ | `terraform` | Terraform IaC 開発 workflow: plan → implement → 並列レビュー → 監督検証 → 修正 → 完了。 |
| 🔍 レビュー | `review-default` | 多角コードレビュー: PR/ブランチ/作業中の差分を自動判定し、architecture、security、testing、coding を専門並列レビューした後、supervisor が統合結果を出力。 |
| | `review-fix-default` | 多角レビュー＋修正ループ（architecture/security/testing/coding の専門並列レビュー後に supervisor が最終判定）。 |
| | `review-frontend` | フロントエンド特化レビュー（architecture、frontend、security、coding）。 |
| | `review-fix-frontend` | フロントエンド特化レビュー＋修正ループ（architecture、frontend、security、coding）。 |
| | `review-backend` | バックエンド特化レビュー（architecture、security、coding）。 |
| | `review-fix-backend` | バックエンド特化レビュー＋修正ループ（architecture、security、coding）。 |
| | `review-dual` | フロントエンド＋バックエンド特化レビュー（architecture、frontend、security、coding）。 |
| | `review-fix-dual` | フロントエンド＋バックエンド特化レビュー＋修正ループ（architecture、frontend、security、coding）。 |
| | `review-dual-cqrs` | フロントエンド＋CQRS+ES 特化レビュー（architecture、CQRS+ES、frontend、security、coding）。 |
| | `review-fix-dual-cqrs` | フロントエンド＋CQRS+ES 特化レビュー＋修正ループ（architecture、CQRS+ES、frontend、security、coding）。 |
| | `review-backend-cqrs` | CQRS+ES 特化レビュー（architecture、CQRS+ES、security、coding）。 |
| | `review-fix-backend-cqrs` | CQRS+ES 特化レビュー＋修正ループ（architecture、CQRS+ES、security、coding）。 |
| | `review-takt-default` | TAKT開発向け多角レビュー（AIアンチパターン・コーディングレビュー含む5観点レビュー）。 |
| | `review-fix-takt-default` | レビュー対象を収集してから、TAKT固有ファセットを共通開発フローへ注入するワークフロー。 |
| | `audit-unit` | ユニットテスト監査。振る舞いとカバレッジギャップを列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-e2e` | E2E テスト監査。ユーザーフローとカバレッジギャップを列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-security` | セキュリティ監査。プロジェクトの全ファイルを読み取ってセキュリティレビュー。 |
| | `audit-architecture` | アーキテクチャ監査。モジュールと境界を列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-architecture-frontend` | フロントエンド特化アーキテクチャ監査。UI モジュールと境界を列挙。 |
| | `audit-architecture-backend` | バックエンド特化アーキテクチャ監査。サービスモジュールと境界を列挙。 |
| | `audit-architecture-dual` | フルスタックアーキテクチャ監査。フロントエンド/バックエンドの境界とクロスレイヤー配線を列挙。 |
| 🎵 TAKT開発 | `takt-default` | 計画、テスト、実装、レビュー、修正へ TAKT 固有知識を注入して共通開発コアを実行する workflow です。 |
| | `takt-experimental` | 共通開発コアの裁定・修正検証・follow-up review・要件充足の最終確認へ、TAKT固有 reviewer と実装 companion を追加する実験的 TAKT 開発 workflow です。 |
| | `auto-improvement-loop` | PR・Issue・新規改善を巡回しながら次の task を積み続ける orchestration loop workflow。 |
| | `review-takt-default` | TAKT開発向け多角レビュー（AIアンチパターン・コーディングレビュー含む5観点レビュー）。 |
| | `review-fix-takt-default` | レビュー対象を収集してから、TAKT固有ファセットを共通開発フローへ注入するワークフロー。 |
| その他 | `research` | リサーチ workflow: planner -> digger -> supervisor。質問せずに自律的にリサーチを実行。 |
| | `deep-research` | ディープリサーチ workflow: plan -> dig -> analyze -> supervise。発見駆動型の調査で、浮上した疑問を多角的に分析。 |
| | `magi` | エヴァンゲリオンにインスパイアされた合議システム。3つの AI persona (MELCHIOR, BALTHASAR, CASPER) が分析・投票。 |
| | `compound-eye` | 複眼レビュー。同じ指示を2つの eye に同時に投げ、両者の回答を統合する。eye ごとのプロバイダーは runtime.yaml（`provider.targets.steps` -> `eye1` / `eye2`）で割り当てる。 |

ローカルモデルだけで既存 workflow を動かす場合は、`runtime.yaml` の
`provider.defaults` または `provider.targets` で provider/model を割り当てます。
カスタムのハイブリッド構成では、通常の `review` step をローカル provider へ
振り分け、高信頼 provider へ戻す step に後ろの `final-gate` タグを付けます。
workflow YAML 自体には provider/model/provider-options field はありません。

`takt` を実行すると workflow をインタラクティブに選択できます。

## ビルトイン Persona 一覧

| Persona | 説明 |
|---------|-------------|
| **planner** | タスク分析、仕様調査、実装計画 |
| **architect-planner** | タスク分析と設計計画: コード調査、不明点の解消、実装計画の作成 |
| **coder** | 機能実装、バグ修正 |
| **ai-antipattern-reviewer** | AI 固有のアンチパターンレビュー（存在しない API、誤った前提、スコープクリープ） |
| **architecture-reviewer** | アーキテクチャとコード品質のレビュー、仕様準拠の検証 |
| **coding-reviewer** | 実装レベルのコードレビュー: タスク意図と差分に対する具体的なバグ、リグレッション、セキュリティリスク、テスト不足 |
| **implementation-semantics-reviewer** | 実装セマンティクスレビュー: データ構造の選択、状態の正規化、命名と意味の整合、境界での fail-fast |
| **frontend-reviewer** | フロントエンド (React/Next.js) のコード品質とベストプラクティスのレビュー |
| **cqrs-es-reviewer** | CQRS+Event Sourcing のアーキテクチャと実装のレビュー |
| **security-reviewer** | セキュリティ脆弱性の評価 |
| **conductor** | Phase 3 判定スペシャリスト: レポート/レスポンスを読み取りステータスタグを出力 |
| **supervisor** | 要件充足、finding 解消、再発台帳引き継ぎの最終判定 |
| **dual-supervisor** | 複数専門レビューの統合検証とリリース可否判断 |
| **research-planner** | リサーチタスクの計画とスコープ定義 |
| **research-analyzer** | リサーチ結果の解釈と追加調査計画 |
| **research-digger** | 深掘り調査と情報収集 |
| **research-supervisor** | リサーチ品質の検証と完全性の評価 |
| **test-planner** | テスト戦略の分析と包括的なテスト計画 |
| **testing-reviewer** | テスト重視のコードレビューとインテグレーションテスト要件分析 |
| **review-adjudicator** | 証拠に基づいてレビュー指摘を裁定し、正式な修正対象セットを確定する |
| **contract-lifecycle-reviewer** | 契約の定義・生成・利用・検証・移行経路を横断して確認するレビュー |
| **robustness-reviewer** | 障害処理、境界条件、運用上の耐性を確認する堅牢性レビュー |
| **terraform-coder** | Terraform IaC の実装 |
| **terraform-reviewer** | Terraform IaC のレビュー |
| **melchior** | MAGI 合議システム: MELCHIOR-1（科学者の観点） |
| **balthasar** | MAGI 合議システム: BALTHASAR-2（母親の観点） |
| **casper** | MAGI 合議システム: CASPER-3（女性の観点） |
| **pr-commenter** | レビュー結果を GitHub PR コメントとして投稿 |

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

この設定はすべての workflow にグローバルに適用されます。指定された persona を使用する step は、実行中の workflow に関係なく、対応する provider にルーティングされます。
