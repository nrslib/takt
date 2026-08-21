# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン workflow と persona の総合カタログです。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `default` | 動的実装 companion と、共通コアの裁定・修正検証付きピアレビュー収束ループ、要件の最終確認を使う標準コーディングワークフロー。 |
| `maintenance` | 変更範囲外の既存コードと契約を尊重し、因果関係のある差分に限定して進める保守開発ワークフロー。 |
| `simple` | pure と同じ最小構造に、変更内容に応じて TAKT がドメインファセットを自動選択して注入する軽量開発ワークフロー。AI アンチパターンとアーキテクチャの指針は常に含まれる。 |
| `pure` | ドメインファセットを注入せず、強いモデルの判断力を信頼する素の開発ワークフロー。利用可能な関連SKILLをモデル自身が選び、テスト先行の実装、レビュー、修正、要件充足の最終確認を最小限の構成で行う。 |
| `takt-default` | TAKT固有ファセットと実装 companion を、共通コアの裁定・修正検証付きピアレビュー収束ループ、要件の最終確認へ注入する。 |
| `takt-default-team` | takt-default の計画・テスト・レビュー契約を維持し、現行 schema 制約に合わせて実装系の dynamic facets と companion を使わない静的な Team Leader coder execution へ切り替える TAKT 開発 workflow です。 |
| `review` | 多角レビュー - 変更内容に応じて専門レビュアーを自動選択して並列レビューし、supervisor がレビュー結果を統合する |
| `review-fix` | 多角レビューで変更内容に応じたレビュワーを動的に選択し、標準 workflow と同じ裁定・検証付き修正ループと要件の最終確認で収束させる。 |
| `review-fix-default` | 多角レビュー＋修正ループ（アーキテクチャ・セキュリティ・テスト・コーディングを並列レビューした後、supervisor が要件の充足を確認する） |

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `default` | 動的実装 companion と、共通コアの裁定・修正検証付きピアレビュー収束ループ、要件の最終確認を使う標準コーディングワークフロー。 |
|  | `maintenance` | 変更範囲外の既存コードと契約を尊重し、因果関係のある差分に限定して進める保守開発ワークフロー。 |
|  | `simple` | pure と同じ最小構造に、変更内容に応じて TAKT がドメインファセットを自動選択して注入する軽量開発ワークフロー。AI アンチパターンとアーキテクチャの指針は常に含まれる。 |
|  | `pure` | ドメインファセットを注入せず、強いモデルの判断力を信頼する素の開発ワークフロー。利用可能な関連SKILLをモデル自身が選び、テスト先行の実装、レビュー、修正、要件充足の最終確認を最小限の構成で行う。 |
| 🛠️ 開発 | `default` | 動的実装 companion と、共通コアの裁定・修正検証付きピアレビュー収束ループ、要件の最終確認を使う標準コーディングワークフロー。 |
|  | `maintenance` | 変更範囲外の既存コードと契約を尊重し、因果関係のある差分に限定して進める保守開発ワークフロー。 |
|  | `simple` | pure と同じ最小構造に、変更内容に応じて TAKT がドメインファセットを自動選択して注入する軽量開発ワークフロー。AI アンチパターンとアーキテクチャの指針は常に含まれる。 |
|  | `pure` | ドメインファセットを注入せず、強いモデルの判断力を信頼する素の開発ワークフロー。利用可能な関連SKILLをモデル自身が選び、テスト先行の実装、レビュー、修正、要件充足の最終確認を最小限の構成で行う。 |
| 🔍 レビュー | `review` | 多角レビュー - 変更内容に応じて専門レビュアーを自動選択して並列レビューし、supervisor がレビュー結果を統合する |
|  | `review-fix` | 多角レビューで変更内容に応じたレビュワーを動的に選択し、標準 workflow と同じ裁定・検証付き修正ループと要件の最終確認で収束させる。 |
|  | `review-fix-default` | 多角レビュー＋修正ループ（アーキテクチャ・セキュリティ・テスト・コーディングを並列レビューした後、supervisor が要件の充足を確認する） |
|  | `audit-unit` | ユニットテストの全件監査。振る舞いとカバレッジ不足を棚卸しし、コード修正なしで Issue 直貼り可能なレポートを作成する |
|  | `audit-e2e` | E2E の全件監査。ユーザーフローとカバレッジ不足を棚卸しし、コード修正なしで Issue 直貼り可能なレポートを作成する |
|  | `audit-security` | セキュリティ全件監査。プロジェクトの全ファイルを1つずつ読んでセキュリティレビューする |
|  | `audit-architecture` | アーキテクチャの全件監査。モジュールと境界を棚卸しし、コード修正なしで Issue 直貼り可能なレポートを作成する |
| 🏗️ インフラストラクチャ | `terraform` | Terraform IaC 開発ワークフロー（plan → implement → 並列レビュー → 最終ゲート → 修正 → 完了） |
| 🎵 TAKT開発 | `takt-default` | TAKT固有ファセットと実装 companion を、共通コアの裁定・修正検証付きピアレビュー収束ループ、要件の最終確認へ注入する。 |
|  | `takt-default-team` | takt-default の計画・テスト・レビュー契約を維持し、現行 schema 制約に合わせて実装系の dynamic facets と companion を使わない静的な Team Leader coder execution へ切り替える TAKT 開発 workflow です。 |
|  | `auto-improvement-loop` | PR・Issue・新規改善を巡回しながら次の task を積み続ける orchestration loop workflow。 |
|  | `review-takt-default` | TAKT開発向け多角レビュー（AIアンチパターン・コーディングレビューを含む） |
|  | `review-fix-takt-default` | レビュー対象を収集してから、TAKT固有ファセットを共通開発フローへ注入するワークフロー。 |
| 📦 レガシー | `cli` | CLI開発向けファセットを共通開発フローへ注入するワークフロー。 |
| 📦 レガシー > ✨ Simple | `simple-mini` | 強いモデルの判断力を信頼する軽量な開発ワークフロー（plan → implement → review ⇄ fix → COMPLETE）。独立したテスト作成と要件充足の最終確認を省き、利用可能な関連SKILLをモデル自身が選ぶ。 |
|  | `simple-frontend` | 強いモデルの判断力を信頼し、simple-core にフロントエンド向けナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-backend` | 強いモデルの判断力を信頼し、simple-core にバックエンド向けナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-dual` | 強いモデルの判断力を信頼し、simple-core にフロントエンドとバックエンドのナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-cqrs` | 強いモデルの判断力を信頼し、simple-core にバックエンドと CQRS+ES のナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-dual-cqrs` | 強いモデルの判断力を信頼し、simple-core にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
| 📦 レガシー > ⚡ Mini | `simple-mini` | 強いモデルの判断力を信頼する軽量な開発ワークフロー（plan → implement → review ⇄ fix → COMPLETE）。独立したテスト作成と要件充足の最終確認を省き、利用可能な関連SKILLをモデル自身が選ぶ。 |
|  | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。フロントエンド＋バックエンドのナレッジ注入付き。 |
|  | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESナレッジ注入付き。 |
| 📦 レガシー > 🎨 フロントエンド | `simple-frontend` | 強いモデルの判断力を信頼し、simple-core にフロントエンド向けナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `frontend` | フロントエンド向けファセットを共通開発フローへ注入するワークフロー。 |
|  | `frontend-mini` | フロントエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `frontend-maintenance` | 既存フロントエンド保守向けファセットを共通開発フローへ注入するワークフロー。 |
| 📦 レガシー > ⚙️ バックエンド | `simple-backend` | 強いモデルの判断力を信頼し、simple-core にバックエンド向けナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-cqrs` | 強いモデルの判断力を信頼し、simple-core にバックエンドと CQRS+ES のナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `backend` | バックエンド向けファセットを共通開発フローへ注入するワークフロー。 |
|  | `backend-mini` | バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
|  | `backend-maintenance` | 既存バックエンド保守向けファセットを共通開発フローへ注入するワークフロー。 |
|  | `backend-cqrs` | バックエンドとCQRS+ESのファセットを共通開発フローへ注入するワークフロー。 |
|  | `backend-cqrs-mini` | CQRS+ES向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了） |
| 📦 レガシー > 🔧 デュアル | `simple-dual` | 強いモデルの判断力を信頼し、simple-core にフロントエンドとバックエンドのナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `simple-dual-cqrs` | 強いモデルの判断力を信頼し、simple-core にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを注入するシンプルな開発ワークフロー。 |
|  | `dual` | フロントエンドとバックエンドのファセットを共通開発フローへ注入するワークフロー。 |
|  | `dual-mini` | フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。フロントエンド＋バックエンドのナレッジ注入付き。 |
|  | `dual-cqrs` | フロントエンド、バックエンド、CQRS+ESのファセットを共通開発フローへ注入するワークフロー。 |
|  | `dual-cqrs-mini` | CQRS+ES フロントエンド＋バックエンド向けMini開発ワークフロー（plan → implement → 並列レビュー → 修正 → 完了）。CQRS+ESナレッジ注入付き。 |
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
|  | `audit-architecture-dual` | フルスタックのアーキテクチャ監査。frontend/backend の境界と横断配線を列挙し、コードを変更せずに Issue 化しやすいレポートを作成する |
| その他 | `research` | 調査ワークフロー - 質問せずに自律的に調査を実行 |
|  | `deep-research` | 深掘り調査ワークフロー - 発見駆動で新たな問いを追跡し、多角的に調査する |
|  | `magi` | MAGI合議システム - 3つの観点から分析し多数決で判定 |
|  | `compound-eye` | 複眼レビュー - 同じ指示を独立に割り当てた2つの eye へ同時に投げ、両者の回答を統合する。各 eye のプロバイダーは runtime.yaml（provider.targets.steps -> eye1 / eye2）で割り当てる。workflow 自身はプロバイダー名を持たない。 |

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
| **coder** | 機能実装、バグ修正 |
| **ai-antipattern-reviewer** | AI 固有のアンチパターンレビュー（存在しない API、誤った前提、スコープクリープ） |
| **architecture-reviewer** | アーキテクチャとコード品質のレビュー、仕様準拠の検証 |
| **coding-reviewer** | 実装レベルのコードレビュー: タスク意図と差分に対する具体的なバグ、リグレッション、セキュリティリスク、テスト不足 |
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

この設定はすべての workflow にグローバルに適用されます。指定された persona を使用する step は、実行中の workflow に関係なく、対応する provider にルーティングされます。
