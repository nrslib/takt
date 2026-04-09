# 設定

[English](./configuration.md)

このドキュメントは TAKT の全設定オプションのリファレンスです。クイックスタートについては [README](../README.md) を参照してください。

## グローバル設定

`~/.takt/config.yaml` で TAKT のデフォルト設定を行います。このファイルは初回実行時に自動作成されます。すべてのフィールドは省略可能です。

```yaml
# ~/.takt/config.yaml
language: en                  # UI 言語: 'en' または 'ja'
logging:
  level: info                 # ログレベル: debug, info, warn, error
provider: claude              # デフォルト provider: claude, codex, opencode, cursor, または copilot
model: sonnet                 # デフォルトモデル（省略可、provider にそのまま渡される）
branch_name_strategy: romaji  # ブランチ名生成方式: 'romaji'（高速）または 'ai'（低速）
prevent_sleep: false          # 実行中に macOS のアイドルスリープを防止（caffeinate）
notification_sound: true      # 通知音の有効/無効
notification_sound_events:    # イベントごとの通知音切り替え（省略可）
  iteration_limit: false
  workflow_complete: true
  workflow_abort: true
  run_complete: true          # デフォルト有効。false で無効化
  run_abort: true             # デフォルト有効。false で無効化
concurrency: 1                # takt run の並列タスク数（1-10、デフォルト: 1 = 逐次実行）
task_poll_interval_ms: 500    # takt run での新規タスクポーリング間隔（100-5000、デフォルト: 500）
interactive_preview_steps: 3      # インタラクティブモードでの step プレビュー数（0-10、デフォルト: 3）
# auto_fetch: false            # クローン作成前にリモートを fetch（デフォルト: false）
# base_branch: main            # クローン作成のベースブランチ（デフォルト: リモートのデフォルトブランチ）

# ランタイム環境デフォルト（workflow_config.runtime で上書きしない限りすべての workflow に適用）
# runtime:
#   prepare:
#     - gradle    # .runtime/ に Gradle キャッシュ/設定を準備
#     - node      # .runtime/ に npm キャッシュを準備

# persona ごとの provider / model 上書き（省略可）
# workflow を複製せずに特定の persona を別の provider / model にルーティング
# persona_providers:
#   coder:
#     provider: codex        # coder を Codex で実行
#     model: o3-mini         # 使用モデル（省略可）
#   ai-antipattern-reviewer:
#     provider: claude       # レビュアーは Claude のまま

# provider 固有のパーミッションプロファイル（省略可）
# 優先順位: プロジェクト上書き > グローバル上書き > プロジェクトデフォルト > グローバルデフォルト > required_permission_mode（下限）
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly
#   claude:
#     default_permission_mode: edit

# API キー設定（省略可）
# 環境変数 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN で上書き可能
# anthropic_api_key: sk-ant-...  # Claude（Anthropic）用
# openai_api_key: sk-...         # Codex（OpenAI）用
# opencode_api_key: ...          # OpenCode 用
# cursor_api_key: ...            # Cursor Agent 用（省略時は login セッションにフォールバック）
# copilot_github_token: ...      # Copilot 用（GitHub トークン）

# CLI パス上書き（省略可）
# provider の CLI バイナリを上書き（実行可能ファイルの絶対パスが必要）
# 環境変数 TAKT_CLAUDE_CLI_PATH / TAKT_CODEX_CLI_PATH / TAKT_CURSOR_CLI_PATH / TAKT_COPILOT_CLI_PATH で上書き可能
# claude_cli_path: /usr/local/bin/claude
# codex_cli_path: /usr/local/bin/codex
# cursor_cli_path: /usr/local/bin/cursor-agent
# copilot_cli_path: /usr/local/bin/github-copilot-cli

# VCS プロバイダー（省略可）
# git リモート URL から自動検出（github.com → github、gitlab.com → gitlab）
# セルフホスト環境では明示的に設定
# vcs_provider: github                   # 'github' または 'gitlab'

# インタラクティブモード用 assistant プロバイダー（省略可）
# インタラクティブモードの会話を別の provider/model にルーティング
# taktProviders:
#   assistant:
#     provider: claude
#     model: opus

# ワークフローセキュリティポリシー（すべてデフォルト拒否）
# 信頼されていないワークフロー YAML が実行できる内容を制御
# workflowMcpServers:                    # MCP サーバートランスポートポリシー
#   stdio: true                          # stdio トランスポートを許可（デフォルト: false）
#   sse: false                           # SSE トランスポートを許可（デフォルト: false）
#   http: false                          # HTTP トランスポートを許可（デフォルト: false）
# workflowArpeggio:                      # Arpeggio カスタムコードポリシー
#   customDataSourceModules: false       # カスタムデータソースモジュールを許可（デフォルト: false）
#   customMergeInlineJs: false           # インライン JS マージ関数を許可（デフォルト: false）
#   customMergeFiles: false              # 外部マージファイルを許可（デフォルト: false）
# workflowRuntimePrepare:                # ランタイム prepare ポリシー
#   customScripts: false                 # カスタムスクリプトを許可（デフォルト: false、ビルトインプリセットは常に許可）
# syncConflictResolver:                  # sync conflict resolver ポリシー
#   autoApproveTools: false              # ツールの自動承認を許可（デフォルト: false）

# ビルトイン workflow フィルタリング（省略可）
# enable_builtin_workflows: true         # false ですべてのビルトイン workflow を無効化
# disabled_builtins: [magi]              # 特定のビルトイン workflow（name）を無効化

# pipeline 実行設定（省略可）
# ブランチ名、コミットメッセージ、PR 本文をカスタマイズ
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}
```

### グローバル設定フィールドリファレンス

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI 言語 |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | ログレベル |
| `provider` | `"claude"` \| `"claude-sdk"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` | `"claude"` | デフォルト AI provider（`claude` = ヘッドレス CLI モード、`claude-sdk` = SDK/API モード） |
| `logging.trace` | boolean | `false` | trace レベルのログを有効化（高頻度のデバッグノイズを抑制） |
| `model` | string | - | デフォルトモデル名（provider にそのまま渡される） |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | ブランチ名生成方式 |
| `prevent_sleep` | boolean | `false` | macOS アイドルスリープ防止（caffeinate） |
| `notification_sound` | boolean | `true` | 通知音の有効化 |
| `notification_sound_events` | object | - | イベントごとの通知音切り替え |
| `concurrency` | number (1-10) | `1` | `takt run` の並列タスク数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新規タスクのポーリング間隔 |
| `interactive_preview_steps` | number (0-10) | `3` | インタラクティブモードでの step プレビュー数 |
| `worktree_dir` | string | - | 共有クローンのディレクトリ（デフォルトは `../{clone-name}`） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `minimal_output` | boolean | `false` | AI 出力を抑制（CI 向け） |
| `runtime` | object | - | ランタイム環境デフォルト（例: `prepare: [gradle, node]`） |
| `persona_providers` | object | - | persona ごとの provider / model 上書き（例: `coder: { provider: codex, model: o3-mini }`） |
| `provider_options` | object | - | グローバルな provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `anthropic_api_key` | string | - | Claude 用 Anthropic API キー |
| `openai_api_key` | string | - | Codex 用 OpenAI API キー |
| `opencode_api_key` | string | - | OpenCode API キー |
| `cursor_api_key` | string | - | Cursor API キー（省略時は login セッションへフォールバック） |
| `copilot_github_token` | string | - | Copilot CLI 認証用 GitHub トークン |
| `codex_cli_path` | string | - | Codex CLI バイナリパス上書き（絶対パス） |
| `cursor_cli_path` | string | - | Cursor Agent CLI バイナリパス上書き（絶対パス） |
| `copilot_cli_path` | string | - | Copilot CLI バイナリパス上書き（絶対パス） |
| `enable_builtin_workflows` | boolean | `true` | ビルトイン workflow の有効化 |
| `disabled_builtins` | string[] | `[]` | 無効化するビルトイン workflow（YAML の `name`） |
| `pipeline` | object | - | pipeline テンプレート設定 |
| `bookmarks_file` | string | - | ブックマークファイルのパス |
| `auto_fetch` | boolean | `false` | クローン作成前にリモートを fetch してクローンを最新に保つ |
| `base_branch` | string | - | クローン作成のベースブランチ（デフォルトはリモートのデフォルトブランチ） |
| `workflow_categories_file` | string | - | カテゴリファイルのパス（[Workflow カテゴリ](#workflow-categories) 参照。デフォルトのユーザー上書きは `workflow-categories.yaml`） |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自動検出 | VCS プロバイダー（git リモート URL から自動検出） |
| `taktProviders` | object | - | TAKT 内部プロバイダー上書き（例: `assistant: { provider: claude, model: opus }`） |
| `workflowMcpServers` | object | すべて `false` | MCP サーバートランスポートポリシー（`stdio`, `sse`, `http` トグル） |
| `workflowArpeggio` | object | すべて `false` | Arpeggio カスタムコードポリシー（`customDataSourceModules`, `customMergeInlineJs`, `customMergeFiles`） |
| `workflowRuntimePrepare` | object | `{ customScripts: false }` | ランタイム prepare ポリシー（ビルトインプリセットは常に許可） |
| `syncConflictResolver` | object | `{ autoApproveTools: false }` | sync conflict resolver ポリシー |

## プロジェクト設定

`.takt/config.yaml` でプロジェクト固有の設定を行います。このファイルはプロジェクトディレクトリで初めて TAKT を使用した際に作成されます。

```yaml
# .takt/config.yaml
provider: claude              # このプロジェクトの provider 上書き
model: sonnet                 # このプロジェクトのモデル上書き
auto_pr: true                 # worktree 実行後に PR を自動作成
logging:
  level: info                 # コンソールログレベル: debug | info | warn | error
concurrency: 2                # このプロジェクトでの takt run 並列タスク数（1-10）
# base_branch: main           # クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ）

# provider 固有オプション（グローバルを上書き、workflow/step で上書き可能）
# provider_options:
#   codex:
#     network_access: true

# provider 固有パーミッションプロファイル（プロジェクトレベルの上書き）
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly
```

### プロジェクト設定フィールドリファレンス

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"mock"` | - | provider 上書き |
| `model` | string | - | モデル名の上書き（provider にそのまま渡される） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `concurrency` | number (1-10) | `1`（global 設定由来） | `takt run` の並列タスク数 |
| `base_branch` | string | - | クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ） |
| `provider_options` | object | - | provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自動検出 | VCS プロバイダー（グローバルを上書き） |
| `taktProviders` | object | - | TAKT 内部プロバイダー上書き（例: `assistant: { provider: claude, model: opus }`） |
| `workflowMcpServers` | object | - | MCP サーバートランスポートポリシー（グローバルを上書き） |
| `workflowArpeggio` | object | - | Arpeggio カスタムコードポリシー（グローバルを上書き） |
| `workflowRuntimePrepare` | object | - | ランタイム prepare ポリシー（グローバルを上書き） |
| `syncConflictResolver` | object | - | sync conflict resolver ポリシー（グローバルを上書き） |

プロジェクト設定の値は、両方が設定されている場合にグローバル設定を上書きします。

## API キー設定

TAKT は5つの provider をサポートしています。Claude/Codex/OpenCode は API キーを使い、Cursor は API キーまたは `cursor-agent login` セッションで認証でき、Copilot は GitHub トークンを使います。

### 環境変数（推奨）

```bash
# Claude（Anthropic）用
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）用
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode 用
export TAKT_OPENCODE_API_KEY=...

# Cursor Agent 用（cursor-agent login 済みなら省略可）
export TAKT_CURSOR_API_KEY=...

# GitHub Copilot CLI 用
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...
```

### 設定ファイル

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # Claude 用
openai_api_key: sk-...         # Codex 用
opencode_api_key: ...          # OpenCode 用
cursor_api_key: ...            # Cursor Agent 用（省略可）
copilot_github_token: ghp_...  # GitHub Copilot CLI 用
```

### 優先順位

環境変数は `config.yaml` の設定よりも優先されます。

| Provider | 環境変数 | 設定キー |
|----------|---------|---------|
| Claude (Anthropic) | `TAKT_ANTHROPIC_API_KEY` | `anthropic_api_key` |
| Codex (OpenAI) | `TAKT_OPENAI_API_KEY` | `openai_api_key` |
| OpenCode | `TAKT_OPENCODE_API_KEY` | `opencode_api_key` |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |

### セキュリティ

- `config.yaml` に API キーを記載する場合、このファイルを Git にコミットしないよう注意してください。
- 環境変数の使用を検討してください。
- 必要に応じて `~/.takt/config.yaml` をグローバル `.gitignore` に追加してください。
- Cursor provider は `cursor-agent login` が済んでいれば API キーなしでも動作できます。
- API キーを設定すれば、対応する CLI ツール（Claude Code、Codex、OpenCode）のインストールは不要です。TAKT が対応する API を直接呼び出します。
- Copilot provider は `copilot` CLI のインストールが必要です。GitHub トークンは認証に使用されます。

### CLI パス上書き

provider の CLI バイナリパスは環境変数または設定ファイルで上書きできます。

```bash
export TAKT_CLAUDE_CLI_PATH=/usr/local/bin/claude
export TAKT_CODEX_CLI_PATH=/usr/local/bin/codex
export TAKT_CURSOR_CLI_PATH=/usr/local/bin/cursor-agent
export TAKT_COPILOT_CLI_PATH=/usr/local/bin/github-copilot-cli
```

```yaml
# ~/.takt/config.yaml
claude_cli_path: /usr/local/bin/claude
codex_cli_path: /usr/local/bin/codex
cursor_cli_path: /usr/local/bin/cursor-agent
copilot_cli_path: /usr/local/bin/github-copilot-cli
```

| Provider | 環境変数 | 設定キー |
|----------|---------|---------|
| Claude | `TAKT_CLAUDE_CLI_PATH` | `claude_cli_path` |
| Codex | `TAKT_CODEX_CLI_PATH` | `codex_cli_path` |
| Cursor Agent | `TAKT_CURSOR_CLI_PATH` | `cursor_cli_path` |
| Copilot | `TAKT_COPILOT_CLI_PATH` | `copilot_cli_path` |

パスは実行可能ファイルの絶対パスである必要があります。環境変数は設定ファイルの値よりも優先されます。プロジェクトレベルの `.takt/config.yaml` でも設定可能です。

## モデル解決

各 step で使用されるモデルは、次の優先順位（高い順）で解決されます。

1. **Workflow step の `model`** - workflow YAML の step 定義で指定
2. **グローバル設定の `model`** - `~/.takt/config.yaml` のデフォルトモデル
3. **Provider デフォルト** - provider のビルトインデフォルトにフォールバック（Claude: `sonnet`、Codex: `codex`、OpenCode: provider デフォルト、Cursor: CLI デフォルト、Copilot: CLI デフォルト）

### Provider 固有のモデルに関する注意

**Claude Code** はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）と完全なモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。`model` フィールドは provider CLI にそのまま渡されます。利用可能なモデルについては [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code) を参照してください。

**Codex** は Codex SDK を通じてモデル文字列をそのまま使用します。未指定の場合、デフォルトは `codex` です。利用可能なモデルについては Codex のドキュメントを参照してください。

**OpenCode** は `provider/model` 形式のモデル（例: `opencode/big-pickle`）が必要です。OpenCode provider でモデルを省略すると設定エラーになります。

**Cursor Agent** は `model` を `cursor-agent --model <model>` にそのまま渡します。省略時は Cursor CLI のデフォルトが使用されます。

**GitHub Copilot CLI** は `model` を `copilot --model <model>` にそのまま渡します。省略時は Copilot CLI のデフォルトが使用されます。

### 設定例

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # すべての step のデフォルトモデル（上書きされない限り）
```

```yaml
# workflow.yaml - step レベルの上書きが最高優先
steps:
  - name: plan
    model: opus       # この step はグローバル設定に関係なく opus を使用
    ...
  - name: implement
    # model 未指定 - グローバル設定（opus）にフォールバック
    ...
```

## Provider プロファイル

Provider プロファイルを使用すると、各 provider にデフォルトのパーミッションモードと step ごとのパーミッション上書きを設定できます。異なる provider を異なるセキュリティポリシーで運用する場合に便利です。

### パーミッションモード

TAKT は provider 非依存の3つのパーミッションモードを使用します。

| モード | 説明 | Claude | Codex | OpenCode | Cursor Agent | Copilot |
|--------|------|--------|-------|----------|--------------|---------|
| `readonly` | 読み取り専用、ファイル変更不可 | `default` | `read-only` | `read-only` | デフォルトフラグ（`--force` なし） | フラグなし |
| `edit` | 確認付きでファイル編集を許可 | `acceptEdits` | `workspace-write` | `workspace-write` | デフォルトフラグ（`--force` なし） | `--allow-all-tools --no-ask-user` |
| `full` | すべてのパーミッションチェックをバイパス | `bypassPermissions` | `danger-full-access` | `danger-full-access` | `--force` | `--yolo` |

### 設定方法

Provider プロファイルはグローバルレベルとプロジェクトレベルの両方で設定できます。

```yaml
# ~/.takt/config.yaml（グローバル）または .takt/config.yaml（プロジェクト）
provider_profiles:
  codex:
    default_permission_mode: full
    step_permission_overrides:
      ai_review: readonly
  claude:
    default_permission_mode: edit
    step_permission_overrides:
      implement: full
```

### パーミッション解決の優先順位

パーミッションモードは次の順序で解決されます（最初にマッチしたものが適用）。

1. **プロジェクト** `provider_profiles.<provider>.step_permission_overrides.<step>`
2. **グローバル** `provider_profiles.<provider>.step_permission_overrides.<step>`
3. **プロジェクト** `provider_profiles.<provider>.default_permission_mode`
4. **グローバル** `provider_profiles.<provider>.default_permission_mode`
5. **Step** `required_permission_mode`（最低限の下限として機能）

step の `required_permission_mode` は最低限の下限を設定します。provider プロファイルから解決されたモードが要求モードよりも低い場合、要求モードが使用されます。たとえば、step が `edit` を要求しているがプロファイルが `readonly` に解決される場合、実効モードは `edit` になります。

### Persona Provider

workflow を複製せずに、特定の persona を別の provider や model にルーティングできます。

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder:
    provider: codex        # coder persona を Codex で実行
    model: o3-mini         # 使用モデル（省略可）
  ai-antipattern-reviewer:
    provider: claude       # レビュアーは Claude のまま
```

`provider` と `model` はいずれも省略可能です。`model` の解決優先度: step YAML の `model` > `persona_providers[persona].model` > グローバル `model`。

これにより、単一の workflow 内で provider や model を混在させることができます。persona 名は step 定義の `persona` キーに対してマッチされます。

<a id="workflow-categories"></a>

## Workflow カテゴリ

`takt` の workflow 選択プロンプトでの UI 表示を改善するために、workflow をカテゴリに整理できます。

**推奨（正）の YAML キー**（同梱の `builtins/{lang}/workflow-categories.yaml` と一致）: トップレベル **`workflow_categories`**、各カテゴリオブジェクト直下の **`workflows`** 配列に **workflow 名**（各 workflow YAML の `name` フィールド。ビルトインなら `default` など）を列挙します。ファイルパスではありません。

削除済みの旧カテゴリキーは受理されません。指定すると validation error になります。

### 設定方法

カテゴリは次の場所で設定できます。
- `builtins/{lang}/workflow-categories.yaml` — TAKT 同梱のデフォルト
- `~/.takt/config.yaml` または `workflow_categories_file` で指定した別ファイル（ユーザー上書きのデフォルトは `~/.takt/preferences/workflow-categories.yaml`）

```yaml
# ~/.takt/config.yaml または専用カテゴリファイル（推奨）
workflow_categories:
  Development:
    workflows: [default, simple]
    children:
      Backend:
        workflows: [dual-cqrs]
      Frontend:
        workflows: [dual]
  Research:
    workflows: [research, magi]

show_others_category: true         # 未分類の workflow を表示（デフォルト: true）
others_category_name: "Other Workflows"  # 未分類カテゴリの名前
```

### カテゴリ機能

- **ネストされたカテゴリ** — 階層的な整理のための無制限の深さ
- **カテゴリごとの workflow リスト** — 各カテゴリの `workflows:` に、そのグループに表示する workflow 名を並べる
- **その他カテゴリ** — いずれのカテゴリにも列挙されていない workflow を自動収集（`show_others_category: false` で無効化可能）
- **ビルトイン workflow フィルタリング** — `enable_builtin_workflows: false` ですべてのビルトインを無効化、または `disabled_builtins: [name1, name2]` で名前指定で無効化

### カテゴリのリセット

workflow カテゴリをビルトインのデフォルトにリセットできます。

```bash
takt reset categories
```

## Pipeline テンプレート

Pipeline モード（`--pipeline`）では、ブランチ名、コミットメッセージ、PR 本文をカスタマイズするテンプレートをサポートしています。

### 設定方法

```yaml
# ~/.takt/config.yaml
pipeline:
  default_branch_prefix: "takt/"
  commit_message_template: "feat: {title} (#{issue})"
  pr_body_template: |
    ## Summary
    {issue_body}
    Closes #{issue}
```

### テンプレート変数

| 変数 | 使用可能な場所 | 説明 |
|------|--------------|------|
| `{title}` | コミットメッセージ | Issue タイトル |
| `{issue}` | コミットメッセージ、PR 本文 | Issue 番号 |
| `{issue_body}` | PR 本文 | Issue 本文 |
| `{report}` | PR 本文 | Workflow 実行レポート |

### Pipeline CLI オプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | pipeline（非インタラクティブ）モードを有効化 |
| `--auto-pr` | 実行後に PR を作成 |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（workflow のみ実行） |
| `--repo <owner/repo>` | PR 作成用のリポジトリを指定 |
| `-q, --quiet` | 最小出力モード（AI 出力を抑制） |

## デバッグ

### デバッグログ

`~/.takt/config.yaml` で `logging.debug: true` を設定してデバッグログを有効化できます。

```yaml
logging:
  debug: true
```

デバッグログは `.takt/runs/debug-{timestamp}/logs/debug.log` に NDJSON 形式で出力されます。

### 詳細コンソール出力

`logging.level: debug` を設定すると、詳細なコンソール出力が有効になります。

```yaml
# ~/.takt/config.yaml または .takt/config.yaml
logging:
  level: debug
```

これは CLI 内部の verbose console mode を有効にする設定です。

`debug.log` などのデバッグ成果物が必要な場合は、別途 `logging.debug: true` を設定してください。

```yaml
logging:
  debug: true
```
