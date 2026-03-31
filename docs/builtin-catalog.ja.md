# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン workflow と persona の総合カタログです。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `default` | 標準の開発 workflow です。テスト先行＋AIアンチパターンレビュー＋並列レビュー（アーキテクチャ＋スーパーバイザー）の構成です。計画 → テスト作成 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| `frontend-mini` | フロントエンド向けの mini 構成です。 |
| `backend-mini` | バックエンド向けの mini 構成です。 |
| `dual-mini` | フロントエンド＋バックエンド向けの mini 構成です。 |

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `default` | 標準の開発 workflow です。テスト先行＋AIアンチパターンレビュー＋並列レビュー（アーキテクチャ＋スーパーバイザー）の構成です。計画 → テスト作成 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| | `frontend-mini` | ミニフロントエンド workflow: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。フロントエンドナレッジ注入付き。 |
| | `backend-mini` | ミニバックエンド workflow: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。バックエンドナレッジ注入付き。 |
| | `compound-eye` | マルチモデルレビュー: 同じ指示を Claude と Codex に同時送信し、両方のレスポンスを統合。 |
| ⚡ Mini | `backend-cqrs-mini` | ミニ CQRS+ES workflow: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。CQRS+ES ナレッジ注入付き。 |
| | `dual-mini` | ミニデュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。フロントエンド＋バックエンドナレッジ注入付き。 |
| | `dual-cqrs-mini` | ミニ CQRS+ES デュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。CQRS+ES ナレッジ注入付き。 |
| 🎨 フロントエンド | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| ⚙️ バックエンド | `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-cqrs` | CQRS+ES 特化バックエンド開発 workflow。CQRS+ES、セキュリティ、QA エキスパートレビュー付き。 |
| 🔧 デュアル | `dual` | フロントエンド＋バックエンド開発 workflow: architecture、frontend、security、QA レビューと修正ループ付き。 |
| | `dual-cqrs` | フロントエンド＋バックエンド開発 workflow (CQRS+ES 特化): CQRS+ES、frontend、security、QA レビューと修正ループ付き。 |
| 🏗️ インフラストラクチャ | `terraform` | Terraform IaC 開発 workflow: plan → implement → 並列レビュー → 監督検証 → 修正 → 完了。 |
| 🔍 レビュー | `review-default` | 多角コードレビュー: PR/ブランチ/作業中の差分を自動判定し、5つの並列観点（arch/security/QA/testing/requirements）からレビューして統合結果を出力。 |
| | `review-fix-default` | 多角レビュー＋修正ループ（architecture/security/QA/testing/requirements — 5並列レビュー＋反復修正）。 |
| | `review-frontend` | フロントエンド特化レビュー（構造、モジュール化、コンポーネント設計、セキュリティ、QA）。 |
| | `review-fix-frontend` | フロントエンド特化レビュー＋修正ループ（構造、モジュール化、コンポーネント設計、セキュリティ、QA）。 |
| | `review-backend` | バックエンド特化レビュー（構造、モジュール化、ヘキサゴナルアーキテクチャ、セキュリティ、QA）。 |
| | `review-fix-backend` | バックエンド特化レビュー＋修正ループ（構造、モジュール化、ヘキサゴナルアーキテクチャ、セキュリティ、QA）。 |
| | `review-dual` | フロントエンド＋バックエンド特化レビュー（構造、モジュール化、コンポーネント設計、セキュリティ、QA）。 |
| | `review-fix-dual` | フロントエンド＋バックエンド特化レビュー＋修正ループ（構造、モジュール化、コンポーネント設計、セキュリティ、QA）。 |
| | `review-dual-cqrs` | フロントエンド＋CQRS+ES 特化レビュー（構造、モジュール化、ドメインモデル、コンポーネント設計、セキュリティ、QA）。 |
| | `review-fix-dual-cqrs` | フロントエンド＋CQRS+ES 特化レビュー＋修正ループ（構造、モジュール化、ドメインモデル、コンポーネント設計、セキュリティ、QA）。 |
| | `review-backend-cqrs` | CQRS+ES 特化レビュー（構造、モジュール化、ドメインモデル、セキュリティ、QA）。 |
| | `review-fix-backend-cqrs` | CQRS+ES 特化レビュー＋修正ループ（構造、モジュール化、ドメインモデル、セキュリティ、QA）。 |
| | `audit-unit` | ユニットテスト監査。振る舞いとカバレッジギャップを列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-e2e` | E2E テスト監査。ユーザーフローとカバレッジギャップを列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-security` | セキュリティ監査。プロジェクトの全ファイルを読み取ってセキュリティレビュー。 |
| | `audit-architecture` | アーキテクチャ監査。モジュールと境界を列挙し、コードを変更せずに Issue 作成可能なレポートを出力。 |
| | `audit-architecture-frontend` | フロントエンド特化アーキテクチャ監査。UI モジュールと境界を列挙。 |
| | `audit-architecture-backend` | バックエンド特化アーキテクチャ監査。サービスモジュールと境界を列挙。 |
| | `audit-architecture-dual` | フルスタックアーキテクチャ監査。フロントエンド/バックエンドの境界とクロスレイヤー配線を列挙。 |
| 🧪 テスト | `unit-test` | ユニットテスト特化 workflow: テスト分析 -> テスト実装 -> レビュー -> 修正。 |
| | `e2e-test` | E2E テスト特化 workflow: E2E 分析 -> E2E 実装 -> レビュー -> 修正 (Vitest ベースの E2E フロー)。 |
| 🎵 TAKT開発 | `takt-default` | TAKT 開発 workflow: 計画 → テスト作成 → 実装 → AIアンチパターンレビュー → 5並列レビュー → 修正 → 監督 → 完了。 |
| | `takt-default-team-leader` | TAKT 開発 workflow（チームリーダー版）: 計画 → テスト作成 → チームリーダー実装 → AIアンチパターンレビュー → 5並列レビュー → 修正 → 監督 → 完了。 |
| | `review-fix-takt-default` | TAKT 開発コードレビュー＋修正ループ（5並列レビュー: architecture/security/QA/testing/requirements — 反復修正付き）。 |
| その他 | `research` | リサーチ workflow: planner -> digger -> supervisor。質問せずに自律的にリサーチを実行。 |
| | `deep-research` | ディープリサーチ workflow: plan -> dig -> analyze -> supervise。発見駆動型の調査で、浮上した疑問を多角的に分析。 |
| | `magi` | エヴァンゲリオンにインスパイアされた合議システム。3つの AI persona (MELCHIOR, BALTHASAR, CASPER) が分析・投票。 |

`takt` を実行すると workflow をインタラクティブに選択できます。

## ビルトイン Persona 一覧

| Persona | 説明 |
|---------|-------------|
| **planner** | タスク分析、仕様調査、実装計画 |
| **architect-planner** | タスク分析と設計計画: コード調査、不明点の解消、実装計画の作成 |
| **coder** | 機能実装、バグ修正 |
| **ai-antipattern-reviewer** | AI 固有のアンチパターンレビュー（存在しない API、誤った前提、スコープクリープ） |
| **architecture-reviewer** | アーキテクチャとコード品質のレビュー、仕様準拠の検証 |
| **frontend-reviewer** | フロントエンド (React/Next.js) のコード品質とベストプラクティスのレビュー |
| **cqrs-es-reviewer** | CQRS+Event Sourcing のアーキテクチャと実装のレビュー |
| **qa-reviewer** | テストカバレッジと品質保証のレビュー |
| **security-reviewer** | セキュリティ脆弱性の評価 |
| **conductor** | Phase 3 判定スペシャリスト: レポート/レスポンスを読み取りステータスタグを出力 |
| **supervisor** | 最終検証、承認 |
| **dual-supervisor** | 複数専門レビューの統合検証とリリース可否判断 |
| **research-planner** | リサーチタスクの計画とスコープ定義 |
| **research-analyzer** | リサーチ結果の解釈と追加調査計画 |
| **research-digger** | 深掘り調査と情報収集 |
| **research-supervisor** | リサーチ品質の検証と完全性の評価 |
| **test-planner** | テスト戦略の分析と包括的なテスト計画 |
| **testing-reviewer** | テスト重視のコードレビューとインテグレーションテスト要件分析 |
| **requirements-reviewer** | 要件仕様と準拠性のレビュー |
| **terraform-coder** | Terraform IaC の実装 |
| **terraform-reviewer** | Terraform IaC のレビュー |
| **melchior** | MAGI 合議システム: MELCHIOR-1（科学者の観点） |
| **balthasar** | MAGI 合議システム: BALTHASAR-2（母親の観点） |
| **casper** | MAGI 合議システム: CASPER-3（女性の観点） |
| **pr-commenter** | レビュー結果を GitHub PR コメントとして投稿 |

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

## Persona 別 Provider オーバーライド

`~/.takt/config.yaml` の `persona_providers` を使用して、workflow を複製せずに特定の persona を異なる provider にルーティングできます。これにより、例えばコーディングは Codex で実行し、レビューアーは Claude に維持するといった構成が可能になります。

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # coder を Codex で実行
  ai-antipattern-reviewer: claude   # レビューアーは Claude を維持
```

この設定はすべての workflow にグローバルに適用されます。指定された persona を使用する step は、実行中の workflow に関係なく、対応する provider にルーティングされます。
