# TAKT

**T**AKT **A**gent **K**oordination **T**opology - AIエージェントの協調手順・人の介入ポイント・記録をYAMLで定義する

TAKTは複数のAIエージェント（Claude Code、Codex、OpenCode）をYAMLで定義されたワークフローに従って実行します。各ステップで誰が実行し、何を見て、何を許可し、失敗時にどうするかはピースファイルに宣言され、エージェント任せにしません。

TAKTはTAKT自身で開発されています（ドッグフーディング）。

## メタファ

TAKTはオーケストラをイメージした音楽メタファで用語を統一しています。

- **Piece**: タスク実行定義（何をどう協調させるか）
- **Movement**: ピース内の1ステップ（実行フローの1段階）
- **Orchestration**: ムーブメント間でエージェントを協調させるエンジン

## なぜTAKTか

- AIエージェントは強力だが非決定的 — TAKTはエージェントの判断を可視化し、再現可能にする
- マルチエージェントの協調には構造が必要 — ピースが誰が何をどの順序でどの権限で行うかを定義する
- CI/CD連携にはガードレールが必要 — パイプラインモードが非対話でエージェントを実行し、完全な監査ログを残す

## TAKTが制御・管理するもの

TAKTはエージェントの実行を**制御**し、プロンプトの構成要素を**管理**します。

| | 対象 | 説明 |
|---|------|------|
| 制御 | **ルーティング** | 状態遷移ルール（誰がいつ動くか） |
| 制御 | **ツール・権限** | 読み取り専用・編集可・フルアクセス（何を許可するか） |
| 制御 | **記録** | セッションログ・レポート（何を残すか） |
| 管理 | **ペルソナ** | エージェントの役割・専門性（誰として振る舞うか） |
| 管理 | **ポリシー** | コーディング規約・品質基準・禁止事項（何を守るか） |
| 管理 | **ナレッジ** | ドメイン知識・アーキテクチャ情報（何を参照するか） |

ペルソナ・ポリシー・ナレッジは独立したファイルとして管理され、ワークフロー間で自由に組み合わせられます（[Faceted Prompting](./faceted-prompting.ja.md)）。ポリシーを1ファイル変更すれば、それを使うすべてのワークフローに反映されます。

## TAKTとは何でないか

- **自律型AIエンジニアではない** — TAKTはエージェントを協調させるが、何を作るかは決めない。タスクを与えるのはあなたで、TAKTは実行を統制する。
- **SkillやSwarmの代替ではない** — Skillは単一エージェントの知識を拡張する。Swarmはエージェントを並列化する。TAKTはエージェント間のワークフロー構造を定義する — 誰がどの順序でどのルールで実行するか。
- **デフォルトで全自動ではない** — すべてのステップで人の承認を要求できる。自動化はオプトイン（パイプラインモード）であり、デフォルトではない。

## 必要条件

次のいずれかを選択してください。

- **プロバイダーCLIを使用**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、または [OpenCode](https://opencode.ai) をインストール
- **API直接利用**: **Anthropic API Key**、**OpenAI API Key**、または **OpenCode API Key**（CLI不要）

追加で必要なもの:

- [GitHub CLI](https://cli.github.com/) (`gh`) — `takt #N`（GitHub Issue実行）を使う場合のみ必要

**料金について**: API Key を使用する場合、TAKT は Claude API（Anthropic）、OpenAI API、または OpenCode API を直接呼び出します。料金体系は各 CLI ツールを使った場合と同じです。特に CI/CD で自動実行する場合、API 使用量が増えるため、コストに注意してください。

## インストール

```bash
npm install -g takt
```

## クイックスタート

```bash
# 対話モードでAIとタスク要件を詰めてから実行
takt

# GitHub Issueをタスクとして実行（どちらも同じ）
takt #6
takt --issue 6

# パイプライン実行（非対話・スクリプト/CI向け）
takt --pipeline --task "バグを修正して" --auto-pr
```

## 使い方

## 実装メモ

- failed タスクの retry とセッション再開: [`docs/implements/retry-and-session.ja.md`](./implements/retry-and-session.ja.md)

### 対話モード

AI との会話でタスク内容を詰めてから実行するモード。タスクの要件が曖昧な場合や、AI と相談しながら内容を整理したい場合に便利です。

```bash
# 対話モードを開始（引数なし）
takt

# 最初のメッセージを指定（短い単語のみ）
takt hello
```

**注意:** `--task` オプションを指定すると対話モードをスキップして直接タスク実行されます。Issue 参照（`#6`、`--issue`）は対話モードの初期入力として使用されます。

**フロー:**
1. ピース選択
2. 対話モード選択（assistant / persona / quiet / passthrough）
3. AI との会話でタスク内容を整理
4. `/go` でタスク指示を確定（`/go 追加の指示` のように指示を追加することも可能）、または `/play <タスク>` で即座に実行
5. 実行（worktree 作成、ピース実行、PR 作成）

#### 対話モードの種類

| モード | 説明 |
|--------|------|
| `assistant` | デフォルト。AI が質問を通じてタスク要件を明確にしてから指示を生成。 |
| `persona` | 最初のムーブメントのペルソナとの会話（ペルソナのシステムプロンプトとツールを使用）。 |
| `quiet` | 質問なしでタスク指示を生成（ベストエフォート）。 |
| `passthrough` | ユーザー入力をそのままタスクテキストとして使用。AI 処理なし。 |

ピースの `interactive_mode` フィールドでデフォルトモードを設定可能。

#### 実行例

```
$ takt

Select piece:
  ❯ 🎼 default (current)
    📁 Development/
    📁 Research/
    Cancel

対話モード - タスク内容を入力してください。コマンド: /go（実行）, /cancel（終了）

> ユーザー認証機能を追加したい

[AI が要件を確認・整理]

> /go

提案されたタスク指示:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ユーザー認証機能を実装する。

要件:
- メールアドレスとパスワードによるログイン機能
- JWT トークンを使った認証
- パスワードのハッシュ化（bcrypt）
- ログイン・ログアウト API エンドポイント
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

このタスク指示で進めますか？ (Y/n) y

? Create worktree? (Y/n) y

[ピース実行開始...]
```

### 直接タスク実行

`--task` オプションを使うと、対話モードをスキップして直接実行できます。

```bash
# --task オプションでタスク内容を指定
takt --task "バグを修正"

# ピース指定
takt --task "認証機能を追加" --piece expert

# PR 自動作成
takt --task "バグを修正" --auto-pr
```

**注意:** `takt "ログイン機能を追加する"` のように引数として文字列を渡した場合は、対話モードの初期メッセージとして使用されます。

### GitHub Issue タスク

GitHub Issue を直接タスクとして実行できます。Issue のタイトル、本文、ラベル、コメントが自動的にタスク内容として取り込まれます。

```bash
# Issue番号を指定して実行
takt #6
takt --issue 6

# Issue + ピース指定
takt #6 --piece expert

# Issue + PR自動作成
takt #6 --auto-pr
```

**必要条件:** [GitHub CLI](https://cli.github.com/) (`gh`) がインストールされ、認証済みであること。

### タスク管理（add / run / watch / list）

`.takt/tasks.yaml` と `.takt/tasks/{slug}/` を使ったバッチ処理。複数のタスクを積んでおいて、後でまとめて実行する使い方に便利です。

#### タスクを追加（`takt add`）

```bash
# AI会話でタスクの要件を詰めてからタスクを追加
takt add

# GitHub IssueからタスクAdd（Issue番号がブランチ名に反映される）
takt add #28
```

#### タスクを実行（`takt run`）

```bash
# .takt/tasks.yaml の保留中タスクをすべて実行
takt run
```

#### タスクを監視（`takt watch`）

```bash
# .takt/tasks.yaml を監視してタスクを自動実行（常駐プロセス）
takt watch
```

#### タスクブランチを一覧表示（`takt list`）

```bash
# タスクブランチ一覧（マージ・削除）
takt list

# 非対話モード（CI/スクリプト向け）
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

#### タスクディレクトリ運用（作成・実行・確認）

1. `takt add` を実行して `.takt/tasks.yaml` に pending レコードが作られることを確認する。
2. 生成された `.takt/tasks/{slug}/order.md` を開き、必要なら仕様や参考資料を追記する。
3. `takt run`（または `takt watch`）で `tasks.yaml` の pending タスクを実行する。
4. `task_dir` と同じスラッグの `.takt/runs/{slug}/reports/` を確認する。

### パイプラインモード（CI/自動化向け）

`--pipeline` を指定すると非対話のパイプラインモードに入ります。ブランチ作成 → ピース実行 → commit & push を自動で行います。CI/CD での自動化に適しています。

```bash
# タスクをパイプライン実行
takt --pipeline --task "バグを修正"

# パイプライン実行 + PR自動作成
takt --pipeline --task "バグを修正" --auto-pr

# Issue情報を紐付け
takt --pipeline --issue 99 --auto-pr

# ピース・ブランチ指定
takt --pipeline --task "バグを修正" -w magi -b feat/fix-bug

# リポジトリ指定（PR作成時）
takt --pipeline --task "バグを修正" --auto-pr --repo owner/repo

# ピース実行のみ（ブランチ作成・commit・pushをスキップ）
takt --pipeline --task "バグを修正" --skip-git

# 最小限の出力モード（CI向け）
takt --pipeline --task "バグを修正" --quiet
```

パイプラインモードでは `--auto-pr` を指定しない限り PR は作成されません。

**GitHub との統合:** GitHub Actions で TAKT を使う場合は、[takt-action](https://github.com/nrslib/takt-action) を参照してください。PR レビューやタスク実行を自動化できます。詳細は [CI/CD 連携](#cicd連携) セクションを参照してください。

### その他のコマンド

```bash
# ピースを対話的に切り替え
takt switch

# ビルトインのピース/エージェントをプロジェクト .takt/ にコピーしてカスタマイズ
takt eject

# ~/.takt/（グローバル）にコピー
takt eject --global

# エージェントの会話セッションをクリア
takt clear

# ビルトインピース・エージェントを Claude Code Skill としてデプロイ
takt export-cc

# 利用可能なファセットをレイヤー別に一覧表示
takt catalog
takt catalog personas

# 特定のファセットをカスタマイズ用にコピー
takt eject persona coder
takt eject instruction plan --global

# 各ムーブメント・フェーズの組み立て済みプロンプトをプレビュー
takt prompt [piece]

# パーミッションモードを設定
takt config

# ピースカテゴリをビルトインのデフォルトにリセット
takt reset categories
```

### おすすめピース

| ピース | おすすめ用途 |
|------------|------------|
| `default` | 本格的な開発タスク。TAKT自身の開発で使用。アーキテクト＋セキュリティの並列レビュー付き多段階レビュー。 |
| `minimal` | 簡単な修正やシンプルなタスク。基本的なレビュー付きの最小限のピース。 |
| `review-fix-minimal` | レビュー＆修正ピース。レビューフィードバックに基づく反復的な改善に特化。 |
| `research` | 調査・リサーチ。質問せずに自律的にリサーチを実行。 |

### 主要なオプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | **パイプライン（非対話）モードを有効化** — CI/自動化に必須 |
| `-t, --task <text>` | タスク内容（GitHub Issueの代わり） |
| `-i, --issue <N>` | GitHub Issue番号（対話モードでは `#N` と同じ） |
| `-w, --piece <name or path>` | ピース名、またはピースYAMLファイルのパス |
| `-b, --branch <name>` | ブランチ名指定（省略時は自動生成） |
| `--auto-pr` | PR作成（対話: 確認スキップ、パイプライン: PR有効化） |
| `--skip-git` | ブランチ作成・commit・pushをスキップ（パイプラインモード、ピース実行のみ） |
| `--repo <owner/repo>` | リポジトリ指定（PR作成時） |
| `--create-worktree <yes\|no>` | worktree確認プロンプトをスキップ |
| `-q, --quiet` | 最小限の出力モード: AIの出力を抑制（CI向け） |
| `--provider <name>` | エージェントプロバイダーを上書き（claude\|codex\|opencode\|mock） |
| `--model <name>` | エージェントモデルを上書き |

## ピース

TAKTはYAMLベースのピース定義とルールベースルーティングを使用します。ビルトインピースはパッケージに埋め込まれており、`~/.takt/pieces/` のユーザーピースが優先されます。`takt eject` でビルトインを`~/.takt/`にコピーしてカスタマイズできます。

> **注記 (v0.4.0)**: ピースコンポーネントの内部用語が "step" から "movement" に変更されました。ユーザー向けのピースファイルは引き続き互換性がありますが、ピースをカスタマイズする場合、YAMLファイルで `movements:` の代わりに `movements:` が使用されることがあります。機能は同じです。

### ピースの例

```yaml
name: default
max_movements: 10
initial_movement: plan

# セクションマップ — キー: ファイルパス（このYAMLからの相対パス）
personas:
  planner: ../personas/planner.md
  coder: ../personas/coder.md
  reviewer: ../personas/architecture-reviewer.md

policies:
  coding: ../policies/coding.md

knowledge:
  architecture: ../knowledge/architecture.md

movements:
  - name: plan
    persona: planner
    model: opus
    edit: false
    rules:
      - condition: 計画完了
        next: implement
    instruction_template: |
      リクエストを分析し、実装計画を作成してください。

  - name: implement
    persona: coder
    policy: coding
    knowledge: architecture
    edit: true
    permission_mode: edit
    rules:
      - condition: 実装完了
        next: review
      - condition: 進行不可
        next: ABORT
    instruction_template: |
      計画に基づいて実装してください。

  - name: review
    persona: reviewer
    knowledge: architecture
    edit: false
    rules:
      - condition: 承認
        next: COMPLETE
      - condition: 修正が必要
        next: implement
    instruction_template: |
      アーキテクチャとコード品質の観点で実装をレビューしてください。
```

### ペルソナレスムーブメント

`persona` フィールドは省略可能です。省略した場合、ムーブメントはシステムプロンプトなしで `instruction_template` のみを使って実行されます。これはペルソナのカスタマイズが不要なシンプルなタスクに便利です。

```yaml
  - name: summarize
    # persona未指定 — instruction_templateのみを使用
    edit: false
    rules:
      - condition: 要約完了
        next: COMPLETE
    instruction_template: |
      レポートを読んで簡潔な要約を提供してください。
```

また、`persona` の値としてインラインシステムプロンプトを記述することもできます（指定されたファイルが存在しない場合）:

```yaml
  - name: review
    persona: "あなたはコードレビュアーです。可読性と保守性に焦点を当ててください。"
    edit: false
    instruction_template: |
      コード品質をレビューしてください。
```

### パラレルムーブメント

ムーブメント内でサブムーブメントを並列実行し、集約条件で評価できます:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          アーキテクチャとコード品質をレビューしてください。
      - name: security-review
        persona: security-reviewer
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          セキュリティ脆弱性をレビューしてください。
    rules:
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: すべてのサブムーブメントが条件Xにマッチした場合にtrue
- `any("X")`: いずれかのサブムーブメントが条件Xにマッチした場合にtrue
- サブムーブメントの `rules` は可能な結果を定義しますが、`next` は省略可能（親が遷移を制御）

### ルール条件の種類

| 種類 | 構文 | 説明 |
|------|------|------|
| タグベース | `"条件テキスト"` | エージェントが `[STEP:N]` タグを出力し、インデックスでマッチ |
| AI判定 | `ai("条件テキスト")` | AIが条件をエージェント出力に対して評価 |
| 集約 | `all("X")` / `any("X")` | パラレルサブムーブメントの結果を集約 |

## ビルトインピース

TAKTには複数のビルトインピースが同梱されています:

| ピース | 説明 |
|------------|------|
| `default` | フル開発ピース: 計画 → 実装 → AI レビュー → 並列レビュー（アーキテクト＋QA）→ スーパーバイザー承認。各レビュー段階に修正ループあり。 |
| `minimal` | クイックピース: 計画 → 実装 → レビュー → スーパーバイザー。高速イテレーション向けの最小構成。 |
| `review-fix-minimal` | レビュー重視ピース: レビュー → 修正 → スーパーバイザー。レビューフィードバックに基づく反復改善向け。 |
| `research` | リサーチピース: プランナー → ディガー → スーパーバイザー。質問せずに自律的にリサーチを実行。 |
| `expert` | フルスタック開発ピース: アーキテクチャ、フロントエンド、セキュリティ、QA レビューと修正ループ。 |
| `expert-cqrs` | フルスタック開発ピース（CQRS+ES特化）: CQRS+ES、フロントエンド、セキュリティ、QA レビューと修正ループ。 |
| `magi` | エヴァンゲリオンにインスパイアされた審議システム。3つの AI ペルソナ（MELCHIOR、BALTHASAR、CASPER）が分析し投票。 |
| `coding` | 軽量開発ピース: planner → 実装 → 並列レビュー（AI アンチパターン＋アーキテクチャ）→ 修正。スーパーバイザーなしの高速フィードバックループ。 |
| `passthrough` | 最小構成。タスクをそのまま coder に渡す薄いラッパー。レビューなし。 |
| `compound-eye` | マルチモデルレビュー: Claude と Codex に同じ指示を同時送信し、両方の回答を統合。 |
| `review-only` | 変更を加えない読み取り専用のコードレビューピース。 |
| `structural-reform` | プロジェクト全体の構造改革: 段階的なファイル分割を伴う反復的なコードベース再構成。 |
| `unit-test` | ユニットテスト重視ピース: テスト分析 → テスト実装 → レビュー → 修正。 |
| `e2e-test` | E2Eテスト重視ピース: E2E分析 → E2E実装 → レビュー → 修正（VitestベースのE2Eフロー）。 |
| `frontend` | フロントエンド特化開発ピース: React/Next.js 向けのレビューとナレッジ注入。 |
| `backend` | バックエンド特化開発ピース: バックエンド、セキュリティ、QA の専門家レビュー。 |
| `backend-cqrs` | CQRS+ES 特化バックエンド開発ピース: CQRS+ES、セキュリティ、QA の専門家レビュー。 |

**ペルソナ別プロバイダー設定:** 設定ファイルの `persona_providers` で、特定のペルソナを異なるプロバイダーにルーティングできます（例: coder は Codex、レビュアーは Claude）。ピースを複製する必要はありません。

`takt switch` でピースを切り替えられます。

## ビルトインペルソナ

| ペルソナ | 説明 |
|---------|------|
| **planner** | タスク分析、仕様調査、実装計画 |
| **architect-planner** | タスク分析と設計計画: コード調査、不明点の解決、実装計画の作成 |
| **coder** | 機能の実装、バグ修正 |
| **ai-antipattern-reviewer** | AI特有のアンチパターンレビュー（存在しないAPI、誤った仮定、スコープクリープ） |
| **architecture-reviewer** | アーキテクチャとコード品質のレビュー、仕様準拠の検証 |
| **frontend-reviewer** | フロントエンド（React/Next.js）のコード品質とベストプラクティスのレビュー |
| **cqrs-es-reviewer** | CQRS+Event Sourcingアーキテクチャと実装のレビュー |
| **qa-reviewer** | テストカバレッジと品質保証のレビュー |
| **security-reviewer** | セキュリティ脆弱性の評価 |
| **conductor** | Phase 3 判定専用: レポートやレスポンスを読み取り、ステータスタグを出力 |
| **supervisor** | 最終検証、バリデーション、承認 |
| **expert-supervisor** | 包括的なレビュー統合による専門レベルの最終検証 |
| **research-planner** | リサーチタスクの計画・スコープ定義 |
| **research-digger** | 深掘り調査と情報収集 |
| **research-supervisor** | リサーチ品質の検証と網羅性の評価 |
| **test-planner** | テスト戦略分析と包括的なテスト計画 |
| **pr-commenter** | レビュー結果を GitHub PR にコメントとして投稿 |

## カスタムペルソナ

Markdown ファイルでペルソナプロンプトを作成:

```markdown
# ~/.takt/personas/my-reviewer.md

あなたはセキュリティに特化したコードレビュアーです。

## 役割
- セキュリティ脆弱性をチェック
- 入力バリデーションを検証
- 認証ロジックをレビュー
```

## モデル選択

`model` フィールド（ピースのムーブメント、エージェント設定、グローバル設定）はプロバイダー（Claude Code CLI / Codex SDK）にそのまま渡されます。TAKTはモデルエイリアスの解決を行いません。

### Claude Code

Claude Code はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）およびフルモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。利用可能なモデルは [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code)を参照してください。

### Codex

モデル文字列はCodex SDKに渡されます。未指定の場合は `codex` がデフォルトです。利用可能なモデルはCodexのドキュメントを参照してください。

## プロジェクト構造

```
~/.takt/                    # グローバル設定ディレクトリ
├── config.yaml             # グローバル設定（プロバイダー、モデル、ピース等）
├── pieces/                 # ユーザーピース定義（ビルトインを上書き）
│   └── custom.yaml
└── personas/               # ユーザーペルソナプロンプトファイル（.md）
    └── my-persona.md

.takt/                      # プロジェクトレベルの設定
├── config.yaml             # プロジェクト設定（現在のピース等）
├── tasks/                  # タスク入力ディレクトリ（.takt/tasks/{slug}/order.md など）
├── tasks.yaml              # 保留中タスクのメタデータ（task_dir, piece, worktree など）
└── runs/                   # 実行単位の成果物
    └── {slug}/
        ├── reports/        # 実行レポート（自動生成）
        ├── context/        # knowledge/policy/previous_response のスナップショット
        ├── logs/           # この実行専用の NDJSON セッションログ
        └── meta.json       # run メタデータ
```

ビルトインリソースはnpmパッケージ（`builtins/`）に埋め込まれています。`~/.takt/` のユーザーファイルが優先されます。

### グローバル設定

デフォルトのプロバイダーとモデルを `~/.takt/config.yaml` で設定:

```yaml
# ~/.takt/config.yaml
language: ja
default_piece: default
log_level: info
provider: claude         # デフォルトプロバイダー: claude、codex、または opencode
model: sonnet            # デフォルトモデル（オプション）
branch_name_strategy: romaji  # ブランチ名生成: 'romaji'（高速）または 'ai'（低速）
prevent_sleep: false     # macOS の実行中スリープ防止（caffeinate）
notification_sound: true # 通知音の有効/無効
notification_sound_events: # タイミング別の通知音制御
  iteration_limit: false
  piece_complete: true
  piece_abort: true
  run_complete: true # 未設定時は有効。false を指定すると無効
  run_abort: true    # 未設定時は有効。false を指定すると無効
concurrency: 1           # takt run の並列タスク数（1-10、デフォルト: 1 = 逐次実行）
task_poll_interval_ms: 500  # takt run 中の新タスク検出ポーリング間隔（100-5000、デフォルト: 500）
interactive_preview_movements: 3  # 対話モードでのムーブメントプレビュー数（0-10、デフォルト: 3）

# ペルソナ別プロバイダー設定（オプション）
# ピースを複製せずに特定のペルソナを異なるプロバイダーにルーティング
# persona_providers:
#   coder: codex             # coder を Codex で実行
#   ai-antipattern-reviewer: claude  # レビュアーは Claude のまま

# API Key 設定（オプション）
# 環境変数 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY で上書き可能
anthropic_api_key: sk-ant-...  # Claude (Anthropic) を使う場合
# openai_api_key: sk-...       # Codex (OpenAI) を使う場合
# opencode_api_key: ...        # OpenCode を使う場合

# ビルトインピースのフィルタリング（オプション）
# builtin_pieces_enabled: true           # false でビルトイン全体を無効化
# disabled_builtins: [magi, passthrough] # 特定のビルトインピースを無効化

# パイプライン実行設定（オプション）
# ブランチ名、コミットメッセージ、PRの本文をカスタマイズできます。
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}
```

**注意:** Codex SDK は Git 管理下のディレクトリでのみ動作します。`--skip-git-repo-check` は Codex CLI 専用です。

**API Key の設定方法:**

1. **環境変数で設定**:
   ```bash
   export TAKT_ANTHROPIC_API_KEY=sk-ant-...  # Claude の場合
   export TAKT_OPENAI_API_KEY=sk-...         # Codex の場合
   export TAKT_OPENCODE_API_KEY=...          # OpenCode の場合
   ```

2. **設定ファイルで設定**:
   上記の `~/.takt/config.yaml` に `anthropic_api_key`、`openai_api_key`、または `opencode_api_key` を記述

優先順位: 環境変数 > `config.yaml` の設定

**注意事項:**
- API Key を設定した場合、Claude Code、Codex、OpenCode のインストールは不要です。TAKT が直接各 API を呼び出します。
- **セキュリティ**: `config.yaml` に API Key を記述した場合、このファイルを Git にコミットしないよう注意してください。環境変数での設定を使うか、`.gitignore` に `~/.takt/config.yaml` を追加することを検討してください。

**パイプラインテンプレート変数:**

| 変数 | 使用可能箇所 | 説明 |
|------|-------------|------|
| `{title}` | コミットメッセージ | Issueタイトル |
| `{issue}` | コミットメッセージ、PR本文 | Issue番号 |
| `{issue_body}` | PR本文 | Issue本文 |
| `{report}` | PR本文 | ピース実行レポート |

**モデル解決の優先順位:**
1. ピースのムーブメントの `model`（最優先）
2. カスタムエージェントの `model`
3. グローバル設定の `model`
4. プロバイダーデフォルト（Claude: sonnet、Codex: codex、OpenCode: プロバイダーデフォルト）

## 詳細ガイド

### タスクディレクトリ形式

TAKT は `.takt/tasks.yaml` にタスクのメタデータを保存し、長文仕様は `.takt/tasks/{slug}/` に分離して管理します。

**推奨構成**:

```text
.takt/
  tasks/
    20260201-015714-foptng/
      order.md
      schema.sql
      wireframe.png
  tasks.yaml
  runs/
    20260201-015714-foptng/
      reports/
```

**tasks.yaml レコード例**:

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-foptng
    piece: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

`takt add` は `.takt/tasks/{slug}/order.md` を自動生成し、`tasks.yaml` には `task_dir` を保存します。

#### 共有クローンによる隔離実行

YAMLタスクファイルで`worktree`を指定すると、各タスクを`git clone --shared`で作成した隔離クローンで実行し、メインの作業ディレクトリをクリーンに保てます:

- `worktree: true` - 隣接ディレクトリ（または`worktree_dir`設定で指定した場所）に共有クローンを自動作成
- `worktree: "/path/to/dir"` - 指定パスに作成
- `branch: "feat/xxx"` - 指定ブランチを使用（省略時は`takt/{timestamp}-{slug}`で自動生成）
- `worktree`省略 - カレントディレクトリで実行（デフォルト）

> **Note**: YAMLフィールド名は後方互換のため`worktree`のままです。内部的には`git worktree`ではなく`git clone --shared`を使用しています。git worktreeの`.git`ファイルには`gitdir:`でメインリポジトリへのパスが記載されており、Claude Codeがそれを辿ってメインリポジトリをプロジェクトルートと認識してしまうためです。共有クローンは独立した`.git`ディレクトリを持つため、この問題が発生しません。

クローンは使い捨てです。タスク完了後に自動的にコミット＋プッシュし、クローンを削除します。ブランチが唯一の永続的な成果物です。`takt list` でブランチの一覧表示・マージ・削除ができます。

### セッションログ

TAKTはセッションログをNDJSON（`.jsonl`）形式で`.takt/runs/{slug}/logs/`に書き込みます。各レコードはアトミックに追記されるため、プロセスが途中でクラッシュしても部分的なログが保持され、`tail -f`でリアルタイムに追跡できます。

- `.takt/runs/{slug}/logs/{sessionId}.jsonl` - ピース実行ごとのNDJSONセッションログ
- `.takt/runs/{slug}/meta.json` - run メタデータ（`task`, `piece`, `start/end`, `status` など）

レコード種別: `piece_start`, `step_start`, `step_complete`, `piece_complete`, `piece_abort`

最新の previous response は `.takt/runs/{slug}/context/previous_responses/latest.md` に保存され、実行時に自動的に引き継がれます。

### カスタムピースの追加

`~/.takt/pieces/` に YAML ファイルを追加するか、`takt eject` でビルトインをカスタマイズします:

```bash
# defaultピースを~/.takt/pieces/にコピーして編集
takt eject default
```

```yaml
# ~/.takt/pieces/my-piece.yaml
name: my-piece
description: カスタムピース
max_movements: 5
initial_movement: analyze

personas:
  analyzer: ~/.takt/personas/analyzer.md
  coder: ../personas/coder.md

movements:
  - name: analyze
    persona: analyzer
    edit: false
    rules:
      - condition: 分析完了
        next: implement
    instruction_template: |
      このリクエストを徹底的に分析してください。

  - name: implement
    persona: coder
    edit: true
    permission_mode: edit
    pass_previous_response: true
    rules:
      - condition: 完了
        next: COMPLETE
    instruction_template: |
      分析に基づいて実装してください。
```

> **Note**: `{task}`、`{previous_response}`、`{user_inputs}` は自動的にインストラクションに注入されます。テンプレート内での位置を制御したい場合のみ、明示的なプレースホルダーが必要です。

### ペルソナをパスで指定する

セクションマップでキーとファイルパスを対応付け、ムーブメントからキーで参照します:

```yaml
# セクションマップ（ピースファイルからの相対パス）
personas:
  coder: ../personas/coder.md
  reviewer: ~/.takt/personas/my-reviewer.md
```

### ピース変数

`instruction_template`で使用可能な変数:

| 変数 | 説明 |
|------|------|
| `{task}` | 元のユーザーリクエスト（テンプレートになければ自動注入） |
| `{iteration}` | ピース全体のターン数（実行された全ムーブメント数） |
| `{max_movements}` | 最大イテレーション数 |
| `{movement_iteration}` | ムーブメントごとのイテレーション数（このムーブメントが実行された回数） |
| `{previous_response}` | 前のムーブメントの出力（テンプレートになければ自動注入） |
| `{user_inputs}` | ピース中の追加ユーザー入力（テンプレートになければ自動注入） |
| `{report_dir}` | レポートディレクトリパス（例: `.takt/runs/20250126-143052-task-summary/reports`） |
| `{report:filename}` | `{report_dir}/filename` に展開（例: `{report:00-plan.md}`） |

### ピースの設計

各ピースのムーブメントに必要な要素:

**1. ペルソナ** - セクションマップのキーで参照（system promptとして使用）:

```yaml
persona: coder                       # personas セクションマップのキー
persona_name: coder                  # 表示名（オプション）
```

**2. ルール** - ムーブメントから次のムーブメントへのルーティングを定義。インストラクションビルダーがステータス出力ルールを自動注入するため、エージェントはどのタグを出力すべきか把握できます:

```yaml
rules:
  - condition: "実装完了"
    next: review
  - condition: "進行不可"
    next: ABORT
```

特殊な `next` 値: `COMPLETE`（成功）、`ABORT`（失敗）

**3. ムーブメントオプション:**

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `edit` | - | ムーブメントがプロジェクトファイルを編集できるか（`true`/`false`） |
| `pass_previous_response` | `true` | 前のムーブメントの出力を`{previous_response}`に渡す |
| `allowed_tools` | - | エージェントが使用できるツール一覧（Read, Glob, Grep, Edit, Write, Bash等） |
| `provider` | - | このムーブメントのプロバイダーを上書き（`claude`、`codex`、または`opencode`） |
| `model` | - | このムーブメントのモデルを上書き |
| `permission_mode` | - | パーミッションモード: `readonly`、`edit`、`full`（プロバイダー非依存） |
| `provider_options` | - | プロバイダー固有オプション（例: `codex.network_access`、`opencode.network_access`） |
| `output_contracts` | - | レポートファイルの出力契約定義 |
| `quality_gates` | - | ムーブメント完了要件のAIディレクティブ |
| `mcp_servers` | - | MCP（Model Context Protocol）サーバー設定（stdio/SSE/HTTP） |

ピース全体のデフォルトは `piece_config.provider_options` で設定でき、ムーブメント側 `provider_options` で上書きできます。

```yaml
piece_config:
  provider_options:
    codex:
      network_access: true
    opencode:
      network_access: true
```

## API使用例

```typescript
import { PieceEngine, loadPiece } from 'takt';  // npm install takt

const config = loadPiece('default');
if (!config) {
  throw new Error('Piece not found');
}
const engine = new PieceEngine(config, process.cwd(), 'My task');

engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## コントリビュート

詳細は[CONTRIBUTING.md](../CONTRIBUTING.md)を参照。

## CI/CD連携

### GitHub Actions

TAKTはPRレビューやタスク実行を自動化するGitHub Actionを提供しています。詳細は [takt-action](https://github.com/nrslib/takt-action) を参照してください。

**ピース例** (このリポジトリの [.github/workflows/takt-action.yml](../.github/workflows/takt-action.yml) を参照):

```yaml
name: TAKT

on:
  issue_comment:
    types: [created]

jobs:
  takt:
    if: contains(github.event.comment.body, '@takt')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run TAKT
        uses: nrslib/takt-action@main
        with:
          anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**コスト警告**: TAKTはAI API（ClaudeまたはOpenAI）を使用するため、特にCI/CD環境でタスクが自動実行される場合、かなりのコストが発生する可能性があります。API使用量を監視し、請求アラートを設定してください。

### その他のCIシステム

GitHub以外のCIシステムでは、パイプラインモードを使用します:

```bash
# taktをインストール
npm install -g takt

# パイプラインモードで実行
takt --pipeline --task "バグ修正" --auto-pr --repo owner/repo
```

認証には `TAKT_ANTHROPIC_API_KEY`、`TAKT_OPENAI_API_KEY`、または `TAKT_OPENCODE_API_KEY` 環境変数を設定してください（TAKT 独自のプレフィックス付き）。

```bash
# Claude (Anthropic) を使う場合
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex (OpenAI) を使う場合
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode を使う場合
export TAKT_OPENCODE_API_KEY=...
```

## ドキュメント

- [Faceted Prompting](./faceted-prompting.ja.md) - AIプロンプトへの関心の分離（Persona, Policy, Instruction, Knowledge, Output Contract）
- [Piece Guide](./pieces.md) - ピースの作成とカスタマイズ
- [Agent Guide](./agents.md) - カスタムエージェントの設定
- [Changelog](../CHANGELOG.md) - バージョン履歴
- [Security Policy](../SECURITY.md) - 脆弱性報告
- [ブログ: TAKT - AIエージェントオーケストレーション](https://zenn.dev/nrs/articles/c6842288a526d7) - 設計思想と実践的な使い方ガイド

## ライセンス

MIT - 詳細は[LICENSE](../LICENSE)をご覧ください。
