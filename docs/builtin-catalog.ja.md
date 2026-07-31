# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン workflow と persona の総合カタログです。

## おすすめワークフロー

| Workflow | 推奨用途 |
|----------|-----------------|
| `simple` | 強いモデルの判断力を信頼するシンプルな開発 workflow です。モデル自身が関連 SKILL を選び、計画 → テスト作成 → 実装 → コードレビュー → 修正ループ → 最終監督 → 完了。 |
| `simple-mini` | 強いモデルの判断力を信頼する軽量版です。独立したテスト作成と最終監督を省き、計画 → 実装 → コードレビュー → 修正ループ → 完了。 |
| `default` | 共通開発コアを使う標準テスト先行 workflow です。計画 → テスト作成 → 実装 → 専門ピアレビュー → 修正計画 → 修正 → 検証 → merge-readiness・監督 → 完了。 |
| `default-mini` | テストなしのミニ開発 workflow です。`default` から `write_tests` を抜き、軽量に回したいタスク向けの構成です。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| `default-high` | 共通開発コアを直接実装で使い、専門ピアレビュー、収束修正、merge-readiness、監督まで行うフルスペック workflow です。 |
| `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| `dual` | フロントエンド＋バックエンド開発 workflow。直接実装、architecture、frontend、security、QA レビューと修正ループ付き。 |

## 全ビルトイン Workflow 一覧

カテゴリ順に並べています。

| カテゴリ | Workflow | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `simple` | 強いモデルの判断力を信頼するシンプルな開発 workflow。モデル自身が関連 SKILL を選び、計画 → テスト作成 → 実装 → コードレビュー → 修正ループ → 最終監督 → 完了。 |
| | `default` | 共通開発コアを使い、専門ピアレビュー、収束修正、merge-readiness、監督まで行う標準テスト先行 workflow です。 |
| | `default-mini` | テストなしのミニ開発 workflow。`default` から `write_tests` を抜いた軽量版。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| | `default-high` | 共通開発コアを直接実装で使い、専門ピアレビュー、収束修正、merge-readiness、監督まで行うフルスペック workflow です。 |
| | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `dual` | フロントエンド＋バックエンド開発 workflow: architecture、frontend、security、QA レビューと修正ループ付き。 |
| ✨ Simple | `simple` | 強いモデルの判断力を信頼する汎用版。モデル自身が関連 SKILL を選び、最小限の構成で開発を進める。 |
| | `simple-mini` | 強いモデルの判断力を信頼し、独立したテスト作成と最終監督を省いた軽量版。 |
| | `simple-frontend` | 強いモデル向けの簡潔なフロントエンド版。frontend、React、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-backend` | 強いモデル向けの簡潔なバックエンド版。backend、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-dual` | 強いモデル向けの簡潔なデュアル版。frontend、React、backend、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-cqrs` | 強いモデル向けの簡潔な CQRS+ES 版。backend、CQRS+ES、security、architecture、testing のナレッジとポリシーを注入する。 |
| | `simple-dual-cqrs` | 強いモデル向けの簡潔なデュアル CQRS+ES 版。frontend、React、backend、CQRS+ES、security、architecture、testing のナレッジとポリシーを注入する。 |
| ⚡ Mini | `simple-mini` | 強いモデルの判断力を信頼する軽量版。独立したテスト作成と最終監督を省き、計画 → 実装 → コードレビュー → 修正ループ → 完了。 |
| | `default-mini` | テストなしのミニ開発 workflow。`default` から `write_tests` を抜いた軽量版。計画 → 実装 → AIアンチパターンレビュー → 並列レビュー → 完了。 |
| | `backend-cqrs-mini` | ミニ CQRS+ES workflow: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。CQRS+ES ナレッジ注入付き。 |
| | `dual-mini` | ミニデュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。フロントエンド＋バックエンドナレッジ注入付き。 |
| | `dual-cqrs-mini` | ミニ CQRS+ES デュアル workflow: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。CQRS+ES ナレッジ注入付き。 |
| 🎨 フロントエンド | `simple-frontend` | 強いモデル向け。`simple-core` にフロントエンド向けナレッジとポリシーを注入するシンプル版。 |
| | `frontend` | フロントエンド特化開発 workflow。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| | `frontend-maintenance` | （実験的）既存プロダクト改修向けのフロントエンド workflow。現行の規約を尊重し変更をスコープ内に収める、保守スコープの plan/implement/test/fix/supervise。現状はやや過剰に動くことがあるため、出発点として使い調整する。 |
| ⚙️ バックエンド | `simple-backend` | 強いモデル向け。`simple-core` にバックエンド向けナレッジとポリシーを注入するシンプル版。 |
| | `simple-cqrs` | 強いモデル向け。`simple-core` にバックエンドと CQRS+ES のナレッジとポリシーを注入するシンプル版。 |
| | `backend` | バックエンド特化開発 workflow。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-cqrs` | CQRS+ES 特化バックエンド開発 workflow。CQRS+ES、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-maintenance` | バックエンド本番保守向け厳密 workflow。専門並列レビュー（アーキテクチャ、テスト、セキュリティ、QA、コーディングレビュー）の後に merge-readiness ゲートを実行し、ループモニターとデュアルスーパーバイザー最終承認を行う。 |
| 🔧 デュアル | `simple-dual` | 強いモデル向け。`simple-core` にフロントエンドとバックエンドのナレッジとポリシーを注入するシンプル版。 |
| | `simple-dual-cqrs` | 強いモデル向け。`simple-core` にフロントエンド、バックエンド、CQRS+ES のナレッジとポリシーを注入するシンプル版。 |
| | `dual` | フロントエンド＋バックエンド開発 workflow: architecture、frontend、security、QA レビューと修正ループ付き。 |
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
| 🎵 TAKT開発 | `takt-default` | 計画、テスト、実装、レビュー、修正へ TAKT 固有知識を注入して共通開発コアを実行する workflow です。 |
| | `takt-default-team-high` | takt-default-high の Team Leader 版。実装・修正を Team Leader が分解して member へ委譲し、同じ6観点の compact 専門レビュー、Finding Contract、最終ゲートを実行する。provider/model は固定しない。 |
| | `takt-default-localllm` | 共通開発コアと Finding Contract stage を合成し、通常レビューをローカルLLMへ、integrity・配線・資源所有権・失敗境界・最終準備状況の再検査を高信頼モデルへ割り当てる。`review`、`boundary-review`、`final-gate` のタグで経路を分離し、provider/model 自体は固定しない。 |
| | `takt-default-high` | takt-default の高コスト強化構成。直接実装・直接修正、6観点の compact 専門レビュー、Finding Contract、merge-readiness/supervisor 最終ゲートで構成する。 |
| | `review-fix-takt-default` | レビュー対象を収集してから、TAKT向け共通開発コアで実装、レビュー、収束修正、最終ゲートまで実行します。 |
| その他 | `research` | リサーチ workflow: planner -> digger -> supervisor。質問せずに自律的にリサーチを実行。 |
| | `deep-research` | ディープリサーチ workflow: plan -> dig -> analyze -> supervise。発見駆動型の調査で、浮上した疑問を多角的に分析。 |
| | `magi` | エヴァンゲリオンにインスパイアされた合議システム。3つの AI persona (MELCHIOR, BALTHASAR, CASPER) が分析・投票。 |

ローカルモデルだけで既存workflowを動かす場合は、各workflowへ provider/model を設定してください。ハイブリッド構成では、`review` をローカル provider へ、`boundary-review` と `final-gate` を commercial provider へルーティングしてください。タグは step の記載順に適用されるため、`merge-readiness-review` と `supervise` では後ろの `final-gate` が先の `review` を上書きします。`finding-contract-local-review` の integrity gate と `finding-contract-boundary-review` の final gate は同じ `merge-readiness-finding-contract-final-gate` subworkflow を呼ぶため、この1つの routing で両 stage を保証でき、workflow 自体へ provider/model を固定する必要はありません。

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
| **contract-lifecycle-reviewer** | 契約の定義・生成・利用・検証・移行経路を横断して確認するレビュー |
| **robustness-reviewer** | 障害処理、境界条件、運用上の耐性を確認する堅牢性レビュー |
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

Finding Contract manager のルーティングには、workflow 内の `finding_contract.manager.provider` と `finding_contract.manager.model` を優先してください。台帳裁定者専用の明示設定であり、`persona_providers.findings-manager` より優先されます。
