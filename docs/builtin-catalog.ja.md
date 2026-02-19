# ビルトインカタログ

[English](./builtin-catalog.md)

TAKT に同梱されているすべてのビルトイン piece と persona の総合カタログです。

## おすすめ Piece

| Piece | 推奨用途 |
|----------|-----------------|
| `default-mini` | ちょっとした修正向けです。計画 → 実装 → 並列レビュー → 修正の軽量構成です。 |
| `frontend-mini` | フロントエンド向けの mini 構成です。 |
| `backend-mini` | バックエンド向けの mini 構成です。 |
| `expert-mini` | エキスパート向けの mini 構成です。 |
| `default` | 本格的な開発向けです。並列レビュアーによる多段階レビューが付いています。TAKT 自身の開発にも使用しています。 |

## 全ビルトイン Piece 一覧

カテゴリ順に並べています。

| カテゴリ | Piece | 説明 |
|---------|----------|-------------|
| 🚀 クイックスタート | `default-mini` | ミニ開発 piece: plan -> implement -> 並列レビュー (AI antipattern + supervisor) -> 必要に応じて修正。レビュー付き軽量版。 |
| | `frontend-mini` | ミニフロントエンド piece: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。フロントエンドナレッジ注入付き。 |
| | `backend-mini` | ミニバックエンド piece: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。バックエンドナレッジ注入付き。 |
| | `default` | フル開発 piece: plan -> implement -> AI review -> 並列レビュー (architect + QA) -> supervisor 承認。各レビュー段階に修正ループあり。 |
| | `compound-eye` | マルチモデルレビュー: 同じ指示を Claude と Codex に同時送信し、両方のレスポンスを統合。 |
| ⚡ Mini | `backend-cqrs-mini` | ミニ CQRS+ES piece: plan -> implement -> 並列レビュー (AI antipattern + supervisor)。CQRS+ES ナレッジ注入付き。 |
| | `expert-mini` | ミニエキスパート piece: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。フルスタックナレッジ注入付き。 |
| | `expert-cqrs-mini` | ミニ CQRS+ES エキスパート piece: plan -> implement -> 並列レビュー (AI antipattern + expert supervisor)。CQRS+ES ナレッジ注入付き。 |
| 🎨 フロントエンド | `frontend` | フロントエンド特化開発 piece。React/Next.js に焦点を当てたレビューとナレッジ注入付き。 |
| ⚙️ バックエンド | `backend` | バックエンド特化開発 piece。バックエンド、セキュリティ、QA エキスパートレビュー付き。 |
| | `backend-cqrs` | CQRS+ES 特化バックエンド開発 piece。CQRS+ES、セキュリティ、QA エキスパートレビュー付き。 |
| 🔧 エキスパート | `expert` | フルスタック開発 piece: architecture、frontend、security、QA レビューと修正ループ付き。 |
| | `expert-cqrs` | フルスタック開発 piece (CQRS+ES 特化): CQRS+ES、frontend、security、QA レビューと修正ループ付き。 |
| 🛠️ リファクタリング | `structural-reform` | プロジェクト全体のレビューと構造改革: 段階的なファイル分割による反復的なコードベース再構築。 |
| 🔍 レビュー | `review-fix-minimal` | レビュー特化 piece: review -> fix -> supervisor。レビューフィードバックに基づく反復改善向け。 |
| | `review-only` | 変更を加えない読み取り専用のコードレビュー piece。 |
| 🧪 テスト | `unit-test` | ユニットテスト特化 piece: テスト分析 -> テスト実装 -> レビュー -> 修正。 |
| | `e2e-test` | E2E テスト特化 piece: E2E 分析 -> E2E 実装 -> レビュー -> 修正 (Vitest ベースの E2E フロー)。 |
| その他 | `research` | リサーチ piece: planner -> digger -> supervisor。質問せずに自律的にリサーチを実行。 |
| | `deep-research` | ディープリサーチ piece: plan -> dig -> analyze -> supervise。発見駆動型の調査で、浮上した疑問を多角的に分析。 |
| | `magi` | エヴァンゲリオンにインスパイアされた合議システム。3つの AI persona (MELCHIOR, BALTHASAR, CASPER) が分析・投票。 |
| | `passthrough` | 最薄ラッパー。タスクを coder にそのまま渡す。レビューなし。 |

`takt switch` で piece をインタラクティブに切り替えできます。

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
| **expert-supervisor** | エキスパートレベルの最終検証と包括的なレビュー統合 |
| **research-planner** | リサーチタスクの計画とスコープ定義 |
| **research-analyzer** | リサーチ結果の解釈と追加調査計画 |
| **research-digger** | 深掘り調査と情報収集 |
| **research-supervisor** | リサーチ品質の検証と完全性の評価 |
| **test-planner** | テスト戦略の分析と包括的なテスト計画 |
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

piece YAML の `personas` セクションマップからカスタム persona を参照します。

```yaml
personas:
  my-reviewer: ~/.takt/personas/my-reviewer.md

movements:
  - name: review
    persona: my-reviewer
    # ...
```

## Persona 別 Provider オーバーライド

`~/.takt/config.yaml` の `persona_providers` を使用して、piece を複製せずに特定の persona を異なる provider にルーティングできます。これにより、例えばコーディングは Codex で実行し、レビューアーは Claude に維持するといった構成が可能になります。

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # coder を Codex で実行
  ai-antipattern-reviewer: claude   # レビューアーは Claude を維持
```

この設定はすべての piece にグローバルに適用されます。指定された persona を使用する movement は、実行中の piece に関係なく、対応する provider にルーティングされます。
