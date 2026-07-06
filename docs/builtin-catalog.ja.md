# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン workflow と persona の総合カタログです。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `default` | 標準の開発 workflow です。テスト先行、ドラフト実装、AIアンチパターン自己レビュー、専門ピアレビュー、merge-readiness ゲート、監督の構成です。計画 → テスト作成 → draft → peer-review（専門レビュー → merge-readiness → 修正ループ）→ 監督 → 完了。 |
| `default-mini` | テストなしのミニ開発 workflow です。`default` から `write_tests` を抜き、軽量に回したいタスク向けの構成です。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| `default-high` | フルスペック開発 workflow です。テスト先行、チームリーダー実装、AIアンチパターンレビュー（仲裁付き）、専門ピアレビュー、merge-readiness ゲート、監督の構成です。計画 → テスト作成 → team-leader draft → peer-review（専門レビュー → merge-readiness → 修正ループ）→ 監督 → 完了。 |
| `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| `dual` | フロントエンド＋バックエンド開発 workflow。チームリーダー実装、architecture、frontend、security、QA レビューと修正ループ付き。 |

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `default` | 標準の開発 workflow です。テスト先行、ドラフト実装、AIアンチパターン自己レビュー、専門ピアレビュー、merge-readiness ゲート、監督の構成です。計画 → テスト作成 → draft → peer-review（専門レビュー → merge-readiness → 修正ループ）→ 監督 → 完了。 |
| | `default-mini` | テストなしのミニ開発 workflow。`default` から `write_tests` を抜いた軽量版。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| | `default-high` | フルスペック開発 workflow。テスト先行、チームリーダー実装、AIアンチパターンレビュー（仲裁付き）、専門ピアレビュー、merge-readiness ゲート、監督。計画 → テスト作成 → team-leader draft → peer-review（専門レビュー → merge-readiness → 修正ループ）→ 監督 → 完了。 |
| | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `dual` | フロントエンド＋バックエンド開発 workflow: architecture、frontend、security、QA レビューと修正ループ付き。 |
| ⚡ Mini | `default-mini` | テストなしのミニ開発 workflow。`default` から `write_tests` を抜いた軽量版。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| | `backend-cqrs-mini` | ミニ CQRS+ES workflow: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。CQRS+ES ナレッジ注入付き。 |
| | `dual-mini` | ミニデュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。フロントエンド＋バックエンドナレッジ注入付き。 |
| | `dual-cqrs-mini` | ミニ CQRS+ES デュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。CQRS+ES ナレッジ注入付き。 |
| 🎨 フロントエンド | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `frontend-maintenance` | （実験的）既存プロダクト改修向けのフロントエンド workflow。現行の規約を尊重し変更をスコープ内に収める、保守スコープの plan/implement/test/fix/supervise。現状はやや過剰に動くことがあるため、出発点として使い調整する。 |
| ⚙️ バックエンド | `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-cqrs` | CQRS+ES 特化バックエンド開発 workflow。CQRS+ES、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-maintenance` | バックエンド本番保守向け厳密 workflow。専門並列レビュー（アーキテクチャ、テスト、セキュリティ、QA、コーディングレビュー）の後に merge-readiness ゲートを実行し、ループモニターとデュアルスーパーバイザー最終承認を行う。 |
| 🔧 デュアル | `dual` | フロントエンド＋バックエンド開発 workflow: architecture、frontend、security、QA レビューと修正ループ付き。 |
| | `dual-cqrs` | フロントエンド＋バックエンド開発 workflow (CQRS+ES 特化): CQRS+ES、frontend、security、QA レビューと修正ループ付き。 |
| 🏗️ インフラストラクチャ | `terraform` | Terraform IaC 開発 workflow: plan → implement → 並列レビュー → 監督検証 → 修正 → 完了。 |
| 🔍 レビュー | `review-default` | 多角コードレビュー: PR/ブランチ/作業中の差分を自動判定し、architecture、security、QA、testing、coding を専門並列レビューした後、merge-readiness ゲートを実行して統合結果を出力。 |
| | `review-fix-default` | 多角レビュー＋修正ループ（architecture/security/QA/testing/coding の専門並列レビュー後に merge-readiness review）。 |
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
| 🎵 TAKT開発 | `takt-default` | TAKT 開発 workflow: 計画 → テスト作成 → draft（実装 + AI セルフレビュー）→ peer-review（専門レビュー + merge-readiness + 修正）→ 監督 → 完了。 |
| | `takt-default-refresh-all` | TAKT 開発 workflow の全ステップ `session: refresh` 比較版。Codex/Claude の会話継承影響を切り分ける実験向け。 |
| | `takt-default-refresh-fast` | TAKT 開発 workflow の refresh 最適化版。`reasoning_effort` や loop 条件は変えず、`write_tests`・`ai-antipattern-review-1st`・各 reviewer・`fix` のような文脈肥大しやすい step にだけ `session: refresh` を追加する。 |
| | `takt-default-team-leader` | TAKT 開発 workflow（チームリーダー版）: 計画 → テスト作成 → team-leader draft → peer-review（専門レビュー + merge-readiness + 修正）→ 監督 → 完了。 |
| | `review-fix-takt-default` | TAKT 開発コードレビュー＋修正ループ: gather → plan → tests → draft → peer-review（専門レビュー + merge-readiness + 修正）→ supervise。 |
| | `peer-review-for-local-llm` | peer-review に実装意味論レビュアーを加えた for-local-llm 系譜のレビュー編成。専門並列レビュー ⇄ 修正ループの後、merge-readiness と supervise の並列最終ゲートを実行する。 |
| 🖥️ ローカルLLM | `takt-default-for-local-llm` | ローカルLLM向け TAKT 開発 workflow。観点別レビュー4並列（アーキテクチャ / AIアンチパターン / コーディング / 実装意味論）+ Finding Contract（台帳・解消確認・異議裁定）で弱いモデルの規律を構造で作る。 |
| | `frontend-for-local-llm` | ローカルLLM向けフロントエンド開発 workflow。観点別レビュー4並列 + Finding Contract。 |
| | `backend-for-local-llm` | ローカルLLM向けバックエンド開発 workflow。観点別レビュー4並列 + Finding Contract。 |
| | `backend-cqrs-for-local-llm` | ローカルLLM向け CQRS+ES バックエンド開発 workflow。観点別レビュー4並列 + Finding Contract。 |
| | `dual-for-local-llm` | ローカルLLM向けフルスタック開発 workflow。観点別レビュー5並列 + Finding Contract。 |
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
| **merge-readiness-reviewer** | 今後保守する前提で、品質面から受け入れ可能かを確認する横断レビュー |
| **terraform-coder** | Terraform IaC の実装 |
| **terraform-reviewer** | Terraform IaC のレビュー |
| **melchior** | MAGI 合議システム: MELCHIOR-1（科学者の観点） |
| **balthasar** | MAGI 合議システム: BALTHASAR-2（母親の観点） |
| **casper** | MAGI 合議システム: CASPER-3（女性の観点） |
| **findings-manager** | 複数レビュアーの生の指摘をライフサイクル追跡付きの統合台帳に照合 |
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
