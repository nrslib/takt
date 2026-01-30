# TAKT

**T**ask **A**gent **K**oordination **T**ool - Claude CodeとOpenAI Codex向けのマルチエージェントオーケストレーションシステム

> **Note**: このプロジェクトは個人のペースで開発されています。詳細は[免責事項](#免責事項)をご覧ください。

## 必要条件

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) または Codex がインストール・設定済みであること

TAKTはClaude CodeとCodexの両方をプロバイダーとしてサポートしています。セットアップ時にプロバイダーを選択できます。

## インストール

```bash
npm install -g takt
```

## クイックスタート

```bash
# タスクを実行（ワークフロー選択プロンプトが表示されます）
takt "ログイン機能を追加して"

# GitHub Issueをタスクとして実行
takt "#6"

# タスクをキューに追加
takt /add-task "ログインのバグを修正"

# 保留中のタスクをすべて実行
takt /run-tasks

# タスクを監視して自動実行
takt /watch

# タスクブランチ一覧（マージ・削除）
takt /list-tasks

# ワークフローを切り替え
takt /switch
```

### タスク実行の流れ

`takt "ログイン機能を追加して"` を実行すると、以下の対話フローが表示されます:

**1. ワークフロー選択**

```
Select workflow:
  (↑↓ to move, Enter to select)

  ❯ default (current) (default)
    expert
    expert-cqrs
    magi
    research
    simple
    Cancel
```

**2. 隔離クローン作成**（オプション）

```
? Create worktree? (y/N)
```

`y` を選ぶと `git clone --shared` で隔離環境を作成し、作業ディレクトリをクリーンに保てます。

**3. 実行** — 選択したワークフローが複数のエージェントを連携させてタスクを完了します。

### おすすめワークフロー

| ワークフロー | おすすめ用途 |
|------------|------------|
| `default` | 本格的な開発タスク。TAKT自身の開発で使用。アーキテクト＋セキュリティの並列レビュー付き多段階レビュー。 |
| `simple` | README更新や小さな修正などの軽量タスク。レビューはあるが修正ループなし。 |
| `expert-review` / `expert-cqrs` | Web開発プロジェクト。マルチエキスパートレビュー（CQRS、フロントエンド、セキュリティ、QA）。 |
| `research` | 調査・リサーチ。質問せずに自律的にリサーチを実行。 |
| `magi` | 審議システム。3つのAIペルソナが分析・投票（エヴァンゲリオン風）。 |

## コマンド一覧

| コマンド | エイリアス | 説明 |
|---------|-----------|------|
| `takt "タスク"` | | 現在のワークフローでタスクを実行（セッション自動継続） |
| `takt "#N"` | | GitHub Issue #Nをタスクとして実行 |
| `takt /run-tasks` | `/run` | `.takt/tasks/` の保留中タスクをすべて実行 |
| `takt /watch` | | `.takt/tasks/` を監視してタスクを自動実行（常駐プロセス） |
| `takt /add-task` | `/add` | 新しいタスクを対話的に追加（YAML形式、複数行対応） |
| `takt /list-tasks` | `/list` | タスクブランチ一覧（マージ・削除） |
| `takt /switch` | `/sw` | ワークフローを対話的に切り替え |
| `takt /clear` | | エージェントの会話セッションをクリア |
| `takt /eject` | | ビルトインのワークフロー/エージェントを`~/.takt/`にコピーしてカスタマイズ |
| `takt /refresh-builtin` | | ビルトインのエージェント/ワークフローを最新版に更新 |
| `takt /config` | | パーミッションモードを設定 |
| `takt /help` | | ヘルプを表示 |

## ワークフロー

TAKTはYAMLベースのワークフロー定義とルールベースルーティングを使用します。ビルトインワークフローはパッケージに埋め込まれており、`~/.takt/workflows/` のユーザーワークフローが優先されます。`/eject` でビルトインを`~/.takt/`にコピーしてカスタマイズできます。

### ワークフローの例

```yaml
name: default
max_iterations: 10
initial_step: plan

steps:
  - name: plan
    agent: ../agents/default/planner.md
    model: opus
    edit: false
    rules:
      - condition: 計画完了
        next: implement
    instruction_template: |
      リクエストを分析し、実装計画を作成してください。

  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    rules:
      - condition: 実装完了
        next: review
      - condition: 進行不可
        next: ABORT
    instruction_template: |
      計画に基づいて実装してください。

  - name: review
    agent: ../agents/default/architecture-reviewer.md
    edit: false
    rules:
      - condition: 承認
        next: COMPLETE
      - condition: 修正が必要
        next: implement
    instruction_template: |
      アーキテクチャとコード品質の観点で実装をレビューしてください。
```

### パラレルステップ

ステップ内でサブステップを並列実行し、集約条件で評価できます:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        agent: ../agents/default/architecture-reviewer.md
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          アーキテクチャとコード品質をレビューしてください。
      - name: security-review
        agent: ../agents/default/security-reviewer.md
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

- `all("X")`: すべてのサブステップが条件Xにマッチした場合にtrue
- `any("X")`: いずれかのサブステップが条件Xにマッチした場合にtrue
- サブステップの `rules` は可能な結果を定義しますが、`next` は省略可能（親が遷移を制御）

### ルール条件の種類

| 種類 | 構文 | 説明 |
|------|------|------|
| タグベース | `"条件テキスト"` | エージェントが `[STEP:N]` タグを出力し、インデックスでマッチ |
| AI判定 | `ai("条件テキスト")` | AIが条件をエージェント出力に対して評価 |
| 集約 | `all("X")` / `any("X")` | パラレルサブステップの結果を集約 |

## ビルトインワークフロー

TAKTには複数のビルトインワークフローが同梱されています:

| ワークフロー | 説明 |
|------------|------|
| `default` | フル開発ワークフロー: 計画 → 実装 → AIレビュー → 並列レビュー（アーキテクト＋セキュリティ）→ スーパーバイザー承認。各レビュー段階に修正ループあり。 |
| `simple` | defaultの簡略版: 計画 → 実装 → アーキテクトレビュー → AIレビュー → スーパーバイザー。中間の修正ステップなし。 |
| `research` | リサーチワークフロー: プランナー → ディガー → スーパーバイザー。質問せずに自律的にリサーチを実行。 |
| `expert-review` | ドメインエキスパートによる包括的レビュー: CQRS+ES、フロントエンド、AI、セキュリティ、QAレビューと修正ループ。 |
| `expert-cqrs` | CQRS+ES、フロントエンド、AI、セキュリティ、QA専門のエキスパートレビュー。計画 → 実装 → マルチエキスパートレビュー → スーパーバイザー。 |
| `magi` | エヴァンゲリオンにインスパイアされた審議システム。3つのAIペルソナ（MELCHIOR、BALTHASAR、CASPER）が分析し投票。 |

`takt /switch` でワークフローを切り替えられます。

## ビルトインエージェント

- **coder** - 機能を実装しバグを修正
- **architect** - アーキテクチャとコード品質をレビュー、仕様準拠を検証
- **supervisor** - 最終検証、バリデーション、承認
- **planner** - タスク分析、仕様調査、実装計画
- **ai-reviewer** - AI生成コードの品質レビュー
- **security** - セキュリティ脆弱性の評価

## カスタムエージェント

`.takt/agents.yaml`でカスタムエージェントを定義:

```yaml
agents:
  - name: my-reviewer
    prompt_file: .takt/prompts/reviewer.md
    allowed_tools: [Read, Glob, Grep]
    provider: claude             # オプション: claude または codex
    model: opus                  # Claude: opus/sonnet/haiku、Codex: gpt-5.2-codex 等
```

またはMarkdownファイルでエージェントプロンプトを作成:

```markdown
# ~/.takt/agents/my-agents/reviewer.md

あなたはセキュリティに特化したコードレビュアーです。

## 役割
- セキュリティ脆弱性をチェック
- 入力バリデーションを検証
- 認証ロジックをレビュー
```

## プロジェクト構造

```
~/.takt/
├── config.yaml          # グローバル設定（プロバイダー、モデル、ワークフロー等）
├── workflows/           # ユーザーワークフロー定義（ビルトインを上書き）
└── agents/              # ユーザーエージェントプロンプトファイル

.takt/                   # プロジェクトレベルの設定
├── agents.yaml          # カスタムエージェント定義
├── tasks/               # 保留中のタスクファイル（.yaml, .md）
├── completed/           # 完了したタスクとレポート
├── reports/             # 実行レポート（自動生成）
└── logs/                # NDJSON形式のセッションログ
    ├── latest.json      # 現在/最新セッションへのポインタ
    ├── previous.json    # 前回セッションへのポインタ
    └── {sessionId}.jsonl # ワークフロー実行ごとのNDJSONセッションログ
```

ビルトインリソースはnpmパッケージ（`dist/resources/`）に埋め込まれています。`~/.takt/` のユーザーファイルが優先されます。

## 実践的な使い方ガイド

### タスク管理

TAKTは`.takt/tasks/`内のタスクファイルによるバッチ処理をサポートしています。`.yaml`/`.yml`と`.md`の両方のファイル形式に対応しています。

#### `/add-task` でタスクを追加

```bash
# クイック追加（隔離なし）
takt /add-task "認証機能を追加"

# GitHub Issueをタスクとして追加
takt /add-task "#6"

# 対話モード（隔離実行、ブランチ、ワークフローオプションを指定可能）
takt /add-task
```

#### タスクファイルの形式

**YAML形式**（推奨、worktree/branch/workflowオプション対応）:

```yaml
# .takt/tasks/add-auth.yaml
task: "認証機能を追加する"
worktree: true                  # 隔離された共有クローンで実行
branch: "feat/add-auth"         # ブランチ名（省略時は自動生成）
workflow: "default"             # ワークフロー指定（省略時は現在のもの）
```

**Markdown形式**（シンプル、後方互換）:

```markdown
# .takt/tasks/add-login-feature.md

アプリケーションにログイン機能を追加する。

要件:
- ユーザー名とパスワードフィールド
- フォームバリデーション
- 失敗時のエラーハンドリング
```

#### 共有クローンによる隔離実行

YAMLタスクファイルで`worktree`を指定すると、各タスクを`git clone --shared`で作成した隔離クローンで実行し、メインの作業ディレクトリをクリーンに保てます:

- `worktree: true` - 隣接ディレクトリ（または`worktree_dir`設定で指定した場所）に共有クローンを自動作成
- `worktree: "/path/to/dir"` - 指定パスに作成
- `branch: "feat/xxx"` - 指定ブランチを使用（省略時は`takt/{timestamp}-{slug}`で自動生成）
- `worktree`省略 - カレントディレクトリで実行（デフォルト）

> **Note**: YAMLフィールド名は後方互換のため`worktree`のままです。内部的には`git worktree`ではなく`git clone --shared`を使用しています。git worktreeの`.git`ファイルには`gitdir:`でメインリポジトリへのパスが記載されており、Claude Codeがそれを辿ってメインリポジトリをプロジェクトルートと認識してしまうためです。共有クローンは独立した`.git`ディレクトリを持つため、この問題が発生しません。

クローンは使い捨てです。タスク完了後に自動的にコミット＋プッシュし、クローンを削除します。ブランチが唯一の永続的な成果物です。`takt /list-tasks`でブランチの一覧表示・マージ・削除ができます。

#### `/run-tasks` でタスクを実行

```bash
takt /run-tasks
```

- タスクはアルファベット順に実行されます（`001-`、`002-`のようなプレフィックスで順序を制御）
- 完了したタスクは実行レポートとともに`.takt/completed/`に移動されます
- 実行中に追加された新しいタスクも動的に取得されます

#### `/watch` でタスクを監視

```bash
takt /watch
```

ウォッチモードは`.takt/tasks/`をポーリングし、新しいタスクファイルが現れると自動実行します。`Ctrl+C`で停止する常駐プロセスです。以下のような場合に便利です:
- タスクファイルを生成するCI/CDパイプライン
- 外部プロセスがタスクを追加する自動化ワークフロー
- タスクを順次キューイングする長時間の開発セッション

#### `/list-tasks` でタスクブランチを一覧表示

```bash
takt /list-tasks
```

`takt/`プレフィックスのブランチをファイル変更数とともに一覧表示します。各ブランチに対して以下の操作が可能です:
- **Try merge** - mainにスカッシュマージ（変更をステージングのみ、コミットなし）
- **Instruct** - 一時クローン経由で追加指示を与える
- **Merge & cleanup** - マージしてブランチを削除
- **Delete** - マージせずにブランチを削除

### セッションログ

TAKTはセッションログをNDJSON（`.jsonl`）形式で`.takt/logs/`に書き込みます。各レコードはアトミックに追記されるため、プロセスが途中でクラッシュしても部分的なログが保持され、`tail -f`でリアルタイムに追跡できます。

- `.takt/logs/latest.json` - 現在（または最新の）セッションへのポインタ
- `.takt/logs/previous.json` - 前回セッションへのポインタ
- `.takt/logs/{sessionId}.jsonl` - ワークフロー実行ごとのNDJSONセッションログ

レコード種別: `workflow_start`, `step_start`, `step_complete`, `workflow_complete`, `workflow_abort`

エージェントは`previous.json`を読み取って前回の実行コンテキストを引き継ぐことができます。セッション継続は自動的に行われます — `takt "タスク"`を実行するだけで前回のセッションから続行されます。

### カスタムワークフローの追加

`~/.takt/workflows/`にYAMLファイルを追加するか、`/eject`でビルトインをカスタマイズします:

```bash
# defaultワークフローを~/.takt/workflows/にコピーして編集
takt /eject default
```

```yaml
# ~/.takt/workflows/my-workflow.yaml
name: my-workflow
description: カスタムワークフロー
max_iterations: 5
initial_step: analyze

steps:
  - name: analyze
    agent: ~/.takt/agents/my-agents/analyzer.md
    edit: false
    rules:
      - condition: 分析完了
        next: implement
    instruction_template: |
      このリクエストを徹底的に分析してください。

  - name: implement
    agent: ~/.takt/agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    pass_previous_response: true
    rules:
      - condition: 完了
        next: COMPLETE
    instruction_template: |
      分析に基づいて実装してください。
```

> **Note**: `{task}`、`{previous_response}`、`{user_inputs}` は自動的にインストラクションに注入されます。テンプレート内での位置を制御したい場合のみ、明示的なプレースホルダーが必要です。

### エージェントをパスで指定する

ワークフロー定義ではファイルパスを使ってエージェントを指定します:

```yaml
# ワークフローファイルからの相対パス
agent: ../agents/default/coder.md

# ホームディレクトリ
agent: ~/.takt/agents/default/coder.md

# 絶対パス
agent: /path/to/custom/agent.md
```

### ワークフロー変数

`instruction_template`で使用可能な変数:

| 変数 | 説明 |
|------|------|
| `{task}` | 元のユーザーリクエスト（テンプレートになければ自動注入） |
| `{iteration}` | ワークフロー全体のターン数（実行された全ステップ数） |
| `{max_iterations}` | 最大イテレーション数 |
| `{step_iteration}` | ステップごとのイテレーション数（このステップが実行された回数） |
| `{previous_response}` | 前のステップの出力（テンプレートになければ自動注入） |
| `{user_inputs}` | ワークフロー中の追加ユーザー入力（テンプレートになければ自動注入） |
| `{report_dir}` | レポートディレクトリ名（例: `20250126-143052-task-summary`） |

### ワークフローの設計

各ワークフローステップに必要な要素:

**1. エージェント** - システムプロンプトを含むMarkdownファイル:

```yaml
agent: ../agents/default/coder.md    # エージェントプロンプトファイルのパス
agent_name: coder                    # 表示名（オプション）
```

**2. ルール** - ステップから次のステップへのルーティングを定義。インストラクションビルダーがステータス出力ルールを自動注入するため、エージェントはどのタグを出力すべきか把握できます:

```yaml
rules:
  - condition: "実装完了"
    next: review
  - condition: "進行不可"
    next: ABORT
```

特殊な `next` 値: `COMPLETE`（成功）、`ABORT`（失敗）

**3. ステップオプション:**

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `edit` | - | ステップがプロジェクトファイルを編集できるか（`true`/`false`） |
| `pass_previous_response` | `true` | 前のステップの出力を`{previous_response}`に渡す |
| `allowed_tools` | - | エージェントが使用できるツール一覧（Read, Glob, Grep, Edit, Write, Bash等） |
| `provider` | - | このステップのプロバイダーを上書き（`claude`または`codex`） |
| `model` | - | このステップのモデルを上書き |
| `permission_mode` | `default` | パーミッションモード: `default`、`acceptEdits`、`bypassPermissions` |
| `report` | - | 自動生成レポートのファイル設定（name, format） |

## API使用例

```typescript
import { WorkflowEngine, loadWorkflow } from 'takt';  // npm install takt

const config = loadWorkflow('default');
if (!config) {
  throw new Error('Workflow not found');
}
const engine = new WorkflowEngine(config, process.cwd(), 'My task');

engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## 免責事項

このプロジェクトは個人プロジェクトであり、私自身のペースで開発されています。

- **レスポンス時間**: イシューにすぐに対応できない場合があります
- **開発スタイル**: このプロジェクトは主に「バイブコーディング」（AI支援開発）で開発されています - **自己責任でお使いください**
- **プルリクエスト**:
  - 小さく焦点を絞ったPR（バグ修正、タイポ、ドキュメント）は歓迎します
  - 大きなPR、特にAI生成の一括変更はレビューが困難です

詳細は[CONTRIBUTING.md](../CONTRIBUTING.md)をご覧ください。

## Docker サポート

他の環境でのテスト用にDocker環境が提供されています:

```bash
# Dockerイメージをビルド
docker compose build

# コンテナでテストを実行
docker compose run --rm test

# コンテナでlintを実行
docker compose run --rm lint

# ビルドのみ（テストをスキップ）
docker compose run --rm build
```

これにより、クリーンなNode.js 20環境でプロジェクトが正しく動作することが保証されます。

## ドキュメント

- [Workflow Guide](./workflows.md) - ワークフローの作成とカスタマイズ
- [Agent Guide](./agents.md) - カスタムエージェントの設定
- [Changelog](../CHANGELOG.md) - バージョン履歴
- [Security Policy](../SECURITY.md) - 脆弱性報告
- [ブログ: TAKT - AIエージェントオーケストレーション](https://zenn.dev/nrs/articles/c6842288a526d7) - 設計思想と実践的な使い方ガイド

## ライセンス

MIT - 詳細は[LICENSE](../LICENSE)をご覧ください。
