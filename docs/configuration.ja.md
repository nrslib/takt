# 設定

[English](./configuration.md)

このドキュメントは TAKT の全設定オプションのリファレンスです。クイックスタートについては [README](../README.md) を参照してください。
phase 粒度の usage events と集計方法は [Observability Guide](./observability.ja.md) を参照してください。

## グローバル設定

`~/.takt/config.yaml` で TAKT のデフォルト設定を行います。このファイルは初回実行時に自動作成されます。すべてのフィールドは省略可能です。

```yaml
# ~/.takt/config.yaml
language: en                  # UI 言語: 'en' または 'ja'
logging:
  level: info                 # ログレベル: debug, info, warn, error
provider: claude              # デフォルト provider: claude, claude-sdk, claude-terminal, codex, opencode, cursor, copilot, kiro, または mock
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
interactive_preview_steps: 3  # インタラクティブモードでの step プレビュー数（0-10、デフォルト: 3）
auto_requeue_max_attempts: 0  # takt run 中の失敗 workflow task 自動 requeue 上限（非負整数、デフォルト: 0 = 無効）
ignore_exceed: false          # takt run / takt watch で --ignore-exceed 相当を適用（デフォルト: false）
# auto_fetch: false           # クローン作成前にリモートを fetch（デフォルト: false）
# base_branch: main           # クローン作成のベースブランチ（デフォルト: リモートのデフォルトブランチ）

# ランタイム環境デフォルト（workflow_config.runtime で上書きしない限りすべての workflow に適用）
# runtime:
#   prepare:
#     - gradle    # .runtime/ に Gradle キャッシュ/設定を準備
#     - node      # .runtime/ に npm キャッシュを準備

# workflow step の provider routing（推奨）
# raw persona キー、step tag、step name で provider / model / provider_options を切り替え
# provider_routing:
#   personas:
#     coder:
#       provider: codex
#       model: gpt-5
#       provider_options:
#         codex:
#           reasoning_effort: high
#   tags:
#     implementation:
#       provider: codex
#       model: gpt-5
#     review:
#       provider: opencode
#       model: opencode/qwen3-coder-next
#     final-gate:
#       provider: codex
#       model: gpt-5
#       provider_options:
#         codex:
#           reasoning_effort: high
#     edit:
#       provider_options:
#         codex:
#           network_access: true
#   steps:
#     ai-antipattern-review-2nd:
#       provider: opencode
#       model: opencode/qwen3-coder-next

# display name ベースの旧設定（deprecated。新規設定では provider_routing を推奨）
# persona_providers:
#   coder:
#     provider: codex
#     model: gpt-5

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
# 環境変数 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY で上書き可能
# anthropic_api_key: sk-ant-...  # Claude（Anthropic）用
# openai_api_key: sk-...         # Codex（OpenAI）用
# opencode_api_key: ...          # OpenCode 用
# cursor_api_key: ...            # Cursor Agent 用（省略時は login セッションにフォールバック）
# copilot_github_token: ...      # Copilot 用（GitHub トークン）
# kiro_api_key: ...              # Kiro CLI 用

# CLI パス上書き（省略可）
# provider の CLI バイナリを上書き（実行可能ファイルの絶対パスが必要）
# 環境変数 TAKT_CLAUDE_CLI_PATH / TAKT_CODEX_CLI_PATH / TAKT_CURSOR_CLI_PATH / TAKT_COPILOT_CLI_PATH / TAKT_KIRO_CLI_PATH で上書き可能
# claude_cli_path: /usr/local/bin/claude
# codex_cli_path: /usr/local/bin/codex
# cursor_cli_path: /usr/local/bin/cursor-agent
# copilot_cli_path: /usr/local/bin/github-copilot-cli
# kiro_cli_path: /usr/local/bin/kiro-cli

# VCS プロバイダー（省略可）
# git リモート URL から自動検出（github.com → github、gitlab.com → gitlab）
# セルフホスト環境では明示的に設定
# vcs_provider: github                   # 'github' または 'gitlab'

# assistant プロバイダー（省略可）
# インタラクティブモードの会話と Report phase fallback provider をルーティング
# Report fallback は OpenCode の report retry が失敗した場合のみ、この設定を使用します。
# project assistant は global assistant を上書きします。assistant 未設定時、Report fallback は
# top-level provider/model へ暗黙フォールバックしません。
# takt_providers:
#   assistant:
#     provider: claude
#     model: opus

# ワークフローセキュリティポリシー（すべてデフォルト拒否）
# 信頼されていないワークフロー YAML が実行できる内容を制御
# workflow_mcp_servers:                  # MCP サーバートランスポートポリシー
#   stdio: true                          # stdio トランスポートを許可（デフォルト: false）
#   sse: false                           # SSE トランスポートを許可（デフォルト: false）
#   http: false                          # HTTP トランスポートを許可（デフォルト: false）
# workflow_arpeggio:                     # Arpeggio カスタムコードポリシー
#   custom_data_source_modules: false    # カスタムデータソースモジュールを許可（デフォルト: false）
#   custom_merge_inline_js: false        # インライン JS マージ関数を許可（デフォルト: false）
#   custom_merge_files: false            # 外部マージファイルを許可（デフォルト: false）
# workflow_runtime_prepare:              # ランタイム prepare ポリシー
#   custom_scripts: false                # カスタムスクリプトを許可（デフォルト: false、ビルトインプリセットは常に許可）
# workflow_command_gates:                # workflow YAML command quality gate ポリシー
#   custom_scripts: false                # workflow YAML の command gate を許可（デフォルト: false）
# sync_conflict_resolver:                # sync conflict resolver ポリシー
#   auto_approve_tools: false            # ツールの自動承認を許可（デフォルト: false）

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

# routing decision telemetry は local-only です。
# telemetry:
#   routing_decisions: true       # auto-routing decision を .takt/events/ に書き込む（デフォルト: true）
```

### グローバル設定フィールドリファレンス

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI 言語 |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | ログレベル |
| `provider` | `"auto"` \| `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | デフォルト AI provider（`auto` = auto routing で provider/model を選択、`claude` = ヘッドレス CLI モード、`claude-sdk` = SDK/API モード、`claude-terminal` = experimental interactive terminal モード） |
| `logging.trace` | boolean | `false` | trace レベルのログを有効化（高頻度のデバッグノイズを抑制） |
| `model` | string | - | デフォルトモデル名（provider にそのまま渡される） |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | ブランチ名生成方式 |
| `prevent_sleep` | boolean | `false` | macOS アイドルスリープ防止（caffeinate） |
| `notification_sound` | boolean | `true` | 通知音の有効化 |
| `notification_sound_events` | object | - | イベントごとの通知音切り替え |
| `concurrency` | number (1-10) | `1` | `takt run` の並列タスク数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新規タスクのポーリング間隔 |
| `interactive_preview_steps` | number (0-10) | `3` | インタラクティブモードでの step プレビュー数 |
| `auto_requeue_max_attempts` | 非負整数 | `0` | `takt run` 中に失敗した workflow task を自動 requeue する上限回数。`0` で無効 |
| `ignore_exceed` | boolean | `false` | `takt run` / `takt watch` の iteration 上限無視を設定します。CLI で `--ignore-exceed` を指定した場合は CLI 指定が優先されます |
| `worktree_dir` | string | - | 共有クローンのディレクトリ（デフォルトは `../{clone-name}`） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `minimal_output` | boolean | `false` | AI 出力を抑制（CI 向け） |
| `runtime` | object | - | ランタイム環境デフォルト（例: `prepare: [gradle, node]`） |
| `provider_routing` | object | - | 推奨設定。raw persona キー、step tag、step name による workflow step の provider / model / provider_options ルーティング |
| `persona_providers` | object | - | deprecated の旧設定。persona display name ごとの provider / model / provider_options 上書き。新規設定では `provider_routing` を推奨 |
| `provider_options` | object | - | グローバルな provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `anthropic_api_key` | string | - | Claude 用 Anthropic API キー |
| `openai_api_key` | string | - | Codex 用 OpenAI API キー |
| `opencode_api_key` | string | - | OpenCode API キー |
| `cursor_api_key` | string | - | Cursor API キー（省略時は login セッションへフォールバック） |
| `copilot_github_token` | string | - | Copilot CLI 認証用 GitHub トークン |
| `kiro_api_key` | string | - | Kiro API キー |
| `codex_cli_path` | string | - | Codex CLI バイナリパス上書き（絶対パス） |
| `cursor_cli_path` | string | - | Cursor Agent CLI バイナリパス上書き（絶対パス） |
| `copilot_cli_path` | string | - | Copilot CLI バイナリパス上書き（絶対パス） |
| `kiro_cli_path` | string | - | Kiro CLI バイナリパス上書き（絶対パス） |
| `enable_builtin_workflows` | boolean | `true` | ビルトイン workflow の有効化 |
| `disabled_builtins` | string[] | `[]` | 無効化するビルトイン workflow（YAML の `name`） |
| `pipeline` | object | - | pipeline テンプレート設定 |
| `bookmarks_file` | string | - | ブックマークファイルのパス |
| `auto_fetch` | boolean | `false` | クローン作成前にリモートを fetch してクローンを最新に保つ |
| `base_branch` | string | - | クローン作成のベースブランチ（デフォルトはリモートのデフォルトブランチ） |
| `workflow_categories_file` | string | - | カテゴリファイルのパス（[Workflow カテゴリ](#workflow-categories) 参照。デフォルトのユーザー上書きは `workflow-categories.yaml`） |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自動検出 | VCS プロバイダー（git リモート URL から自動検出） |
| `takt_providers` | object | - | TAKT 内部プロバイダー上書き。`assistant` はインタラクティブモードの会話をルーティングし、OpenCode の report retry 失敗後の Report phase fallback provider としても使われます。project の `takt_providers.assistant` は global の `takt_providers.assistant` を上書きします。どちらも未設定の場合、Report phase fallback は無効で、top-level `provider` / `model` は暗黙 fallback として使われません。 |
| `telemetry` | object | `{ routing_decisions: true }` | local-only の routing decision 記録。`telemetry.routing_decisions` は auto-routing decision を project `.takt/events/` 配下に NDJSON として書き込むかどうかを制御します。TAKT は routing decision をアップロードしません。 |
| `workflow_mcp_servers` | object | すべて `false` | MCP サーバートランスポートポリシー（`stdio`, `sse`, `http` トグル） |
| `workflow_arpeggio` | object | すべて `false` | Arpeggio カスタムコードポリシー（`custom_data_source_modules`, `custom_merge_inline_js`, `custom_merge_files`） |
| `workflow_runtime_prepare` | object | `{ custom_scripts: false }` | ランタイム prepare ポリシー（ビルトインプリセットは常に許可） |
| `workflow_command_gates` | object | `{ custom_scripts: false }` | workflow YAML command quality gate ポリシー |
| `sync_conflict_resolver` | object | `{ auto_approve_tools: false }` | sync conflict resolver ポリシー |
| `observability` | object | 無効 | OpenTelemetry foundation の opt-in 設定。`enabled` で SDK を初期化し、`monitor` は workflow metric を `.takt/runs/<run>/monitor.json` に出力し、`session_log_exporter` は span 由来の shadow session log を出力します。`usage_events_phase` は phase 粒度の usage events を `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl` に出力します。`enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` が揃うと、TAKT は標準の `OTEL_EXPORTER_OTLP_*` 環境変数で span と metric も OTLP 送信します。TAKT 独自の OTLP config キーはありません。 |

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
auto_requeue_max_attempts: 1  # takt run 中の失敗 workflow task 自動 requeue 上限（非負整数）
ignore_exceed: false          # takt run / takt watch で --ignore-exceed 相当を適用
# base_branch: main           # クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ）

# インタラクティブ assistant モード専用の明示的な初期コンテキストファイル（project config 専用）
# assistant:
#   init_files:
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# provider 固有オプション（プロジェクト既定値。env 起源の leaf が最優先で、それ以外は step > provider_routing > deprecated persona_providers > workflow > project > global の順）
# provider_options:
#   codex:
#     network_access: true
#   opencode:
#     variant: high
#     allowed_tools: [read, glob, grep, bash, websearch, webfetch]
#   kiro:
#     agent: my-default-agent
#   claude_terminal:
#     backend: tmux
#     timeout_ms: 900000
#     keep_session: false
#     transcript_poll_interval_ms: 500

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
| `provider` | `"auto"` \| `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | provider 上書き |
| `model` | string | - | モデル名の上書き（provider にそのまま渡される） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `concurrency` | number (1-10) | `1`（global 設定由来） | `takt run` の並列タスク数 |
| `auto_requeue_max_attempts` | 非負整数 | `0`（global 設定またはデフォルト由来） | `takt run` 中に失敗した workflow task を自動 requeue する上限回数。`0` で無効 |
| `ignore_exceed` | boolean | `false`（global 設定またはデフォルト由来） | `takt run` / `takt watch` の iteration 上限無視を設定します。CLI で `--ignore-exceed` を指定した場合は CLI 指定が優先されます |
| `base_branch` | string | - | クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ） |
| `assistant.init_files` | string[] | - | project config 専用のインタラクティブ assistant 初期コンテキストファイル。パスは project root 相対で指定します。絶対パス、project root 外へ解決されるパス、`.env*` / `.npmrc` / `.pypirc` / `.netrc` / `*.pem` / `*.key` / `.git/**` などの機密ファイルパターンは拒否されます。存在しないパス、ディレクトリ、読めないファイルは分かるエラーになります。最大16ファイルまで指定でき、1ファイルは256KiB、合計本文は1MiBまでです。未設定または空の場合、`CLAUDE.md`、`AGENT.md`、`AGENTS.md`、`TAKT.md` などは自動探索されません。assistant の provider/model だけを制御する `takt_providers.assistant` とは別設定です。 |
| `provider_options` | object | - | provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自動検出 | VCS プロバイダー（グローバルを上書き） |
| `takt_providers` | object | - | TAKT 内部プロバイダー上書き。project の `takt_providers.assistant` は global assistant provider/model を上書きし、インタラクティブモードの会話と、OpenCode の report retry 失敗後の Report phase fallback に使われます。project と global の assistant がどちらも未設定の場合、Report phase fallback は無効で、top-level `provider` / `model` は暗黙 fallback として使われません。 |
| `workflow_mcp_servers` | object | - | MCP サーバートランスポートポリシー（グローバルを上書き） |
| `workflow_arpeggio` | object | - | Arpeggio カスタムコードポリシー（グローバルを上書き） |
| `workflow_runtime_prepare` | object | - | ランタイム prepare ポリシー（グローバルを上書き） |
| `workflow_command_gates` | object | - | workflow YAML command quality gate ポリシー（グローバルを上書き） |
| `sync_conflict_resolver` | object | - | sync conflict resolver ポリシー（グローバルを上書き） |
| `observability` | object | - | プロジェクトレベルの OpenTelemetry opt-in 上書き。`enabled` で SDK を初期化し、`monitor` は workflow metric を `.takt/runs/<run>/monitor.json` に出力し、`session_log_exporter` は span 由来の shadow session log を出力します。`usage_events_phase` は phase 粒度の usage events を `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl` に出力します。`enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` が揃うと、TAKT は標準の `OTEL_EXPORTER_OTLP_*` 環境変数で span と metric も OTLP 送信します。TAKT 独自の OTLP config キーはありません。 |

プロジェクト設定の値は、両方が設定されている場合にグローバル設定を上書きします。

### task 実行設定の環境変数上書き

`auto_requeue_max_attempts` と `ignore_exceed` は
`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` / `TAKT_IGNORE_EXCEED` でも設定できます。
これらの値は、env 対応の他の task 実行設定と同じ優先順位で解決されます。

1. 環境変数
2. プロジェクト `.takt/config.yaml`
3. グローバル `~/.takt/config.yaml`
4. デフォルト

`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` は number parse 後に非負整数である必要があります。
数値でない値、負数、整数でない値は config validation に失敗します。
`TAKT_IGNORE_EXCEED` は `true` または `false` のみ受け付け、それ以外の値は config
validation に失敗します。

## API キー設定

TAKT は Claude、Codex、OpenCode、Cursor、Copilot、Kiro provider をサポートしています。Claude/Codex/OpenCode/Kiro は API キーを使い、Cursor は API キーまたは `cursor-agent login` セッションで認証でき、Copilot は GitHub トークンを使います。

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

# Kiro CLI 用（TAKT_KIRO_API_KEY と kiro_api_key が未設定の場合は KIRO_API_KEY も使用）
export TAKT_KIRO_API_KEY=...
```

### 設定ファイル

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # Claude 用
openai_api_key: sk-...         # Codex 用
opencode_api_key: ...          # OpenCode 用
cursor_api_key: ...            # Cursor Agent 用（省略可）
copilot_github_token: ghp_...  # GitHub Copilot CLI 用
kiro_api_key: ...              # Kiro CLI 用
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
| Kiro CLI | `TAKT_KIRO_API_KEY`（`KIRO_API_KEY` フォールバック） | `kiro_api_key` |

### セキュリティ

- `config.yaml` に API キーを記載する場合、このファイルを Git にコミットしないよう注意してください。
- 環境変数の使用を検討してください。
- 必要に応じて `~/.takt/config.yaml` をグローバル `.gitignore` に追加してください。
- Cursor provider は `cursor-agent login` が済んでいれば API キーなしでも動作できます。
- API キーを設定すれば、対応する CLI ツール（Claude Code、Codex、OpenCode）のインストールは不要です。TAKT が対応する API を直接呼び出します。
- Copilot provider は `copilot` CLI のインストールが必要です。GitHub トークンは認証に使用されます。
- Kiro provider は `kiro-cli` CLI のインストールが必要です。`TAKT_KIRO_API_KEY` / `kiro_api_key` は子プロセスの `KIRO_API_KEY` として渡されます。どちらも未設定の場合は公式の `KIRO_API_KEY` 環境変数を使用します。

### CLI パス上書き

provider の CLI バイナリパスは環境変数または設定ファイルで上書きできます。

```bash
export TAKT_CLAUDE_CLI_PATH=/usr/local/bin/claude
export TAKT_CODEX_CLI_PATH=/usr/local/bin/codex
export TAKT_CURSOR_CLI_PATH=/usr/local/bin/cursor-agent
export TAKT_COPILOT_CLI_PATH=/usr/local/bin/github-copilot-cli
export TAKT_KIRO_CLI_PATH=/usr/local/bin/kiro-cli
```

```yaml
# ~/.takt/config.yaml
claude_cli_path: /usr/local/bin/claude
codex_cli_path: /usr/local/bin/codex
cursor_cli_path: /usr/local/bin/cursor-agent
copilot_cli_path: /usr/local/bin/github-copilot-cli
kiro_cli_path: /usr/local/bin/kiro-cli
```

| Provider | 環境変数 | 設定キー |
|----------|---------|---------|
| Claude | `TAKT_CLAUDE_CLI_PATH` | `claude_cli_path` |
| Codex | `TAKT_CODEX_CLI_PATH` | `codex_cli_path` |
| Cursor Agent | `TAKT_CURSOR_CLI_PATH` | `cursor_cli_path` |
| Copilot | `TAKT_COPILOT_CLI_PATH` | `copilot_cli_path` |
| Kiro CLI | `TAKT_KIRO_CLI_PATH` | `kiro_cli_path` |

パスは実行可能ファイルの絶対パスである必要があります。環境変数は設定ファイルの値よりも優先されます。CLI パス上書きはグローバル専用の設定値です。プロジェクトレベルの `.takt/config.yaml` ではなく、`~/.takt/config.yaml` または対応する環境変数で設定してください。

## モデル解決

TAKT のモデル選択は 2 段階で解決されます。

1. **入力 `model` の解決** - workflow 実行前に、入力 `model` が CLI `--model`、次に config `model`、最後に provider デフォルトの順で解決されます。
2. **Workflow step の `model` 解決** - 各 step では、実効モデルが step YAML の `model`、次に `provider_routing.steps.<step.name>`、step に書かれた順の `provider_routing.tags`、`provider_routing.personas.<raw persona key>`、deprecated の `persona_providers.<persona display name>`、`workflow_config.model`、最後に解決済みの入力 `model` の順で決まります。

Finding Contract workflow では、`finding_contract.manager.provider` と `finding_contract.manager.model` は合成 `findings-manager` step の step レベル provider/model として扱われます。`provider_routing`、deprecated の `persona_providers.findings-manager`、workflow 既定値、解決済み入力値より優先されます。両方とも未指定の場合、manager は通常の workflow step と同じ fallback chain を使います。`provider` だけを指定すると、下位優先度の model fallback は停止し、選択した provider 自身のデフォルトを使います。明示 model が必須の provider では検証エラーになります。

workflow YAML では、通常 step、parallel sub-step、`loop_monitors.judge` の `model: null` は model の明示的な省略を表します。`model` 未指定とは異なります。未指定の場合は routing、workflow、loop monitor judge のトリガー元 step、入力由来の値など、適用可能な下位優先度のソースへフォールバックしますが、`model: null` はその entry で model 解決を止め、実効 model を未定義のままにします。解決済み provider に CLI または provider 側のデフォルトを使わせたい場合に指定します。明示 model が必須の provider では、model が供給されないため検証エラーになります。

### Provider 固有のモデルに関する注意

**Claude Code** はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）と完全なモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。`model` フィールドは provider CLI にそのまま渡されます。利用可能なモデルについては [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code) を参照してください。

**Codex** は Codex SDK を通じてモデル文字列をそのまま使用します。未指定の場合、デフォルトは `codex` です。利用可能なモデルについては Codex のドキュメントを参照してください。

**OpenCode** は `provider/model` 形式のモデル（例: `opencode/big-pickle`）が必要です。OpenCode provider でモデルを省略すると設定エラーになります。

**Cursor Agent** は `model` を `cursor-agent --model <model>` にそのまま渡します。省略時は Cursor CLI のデフォルトが使用されます。

**GitHub Copilot CLI** は `model` を `copilot --model <model>` にそのまま渡します。省略時は Copilot CLI のデフォルトが使用されます。

**Kiro CLI** の初期実装では `model` を CLI フラグとして渡しません。Kiro 側のデフォルトモデル設定を使用してください。

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

| モード | 説明 | Claude | Codex | OpenCode | Cursor Agent | Copilot | Kiro CLI |
|--------|------|--------|-------|----------|--------------|---------|----------|
| `readonly` | 読み取り専用、ファイル変更不可 | `default` | `read-only` | `read-only` | デフォルトフラグ（`--force` なし） | フラグなし | `--trust-tools=read,grep` |
| `edit` | 確認付きでファイル編集を許可 | `acceptEdits` | `workspace-write` | `workspace-write` | デフォルトフラグ（`--force` なし） | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | すべてのパーミッションチェックをバイパス | `bypassPermissions` | `danger-full-access` | `danger-full-access` | `--force` | `--yolo` | `--trust-all-tools` |

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

### Provider Routing

`provider_routing` を使うと、workflow を複製せずに step を別の provider、model、provider 固有オプションへルーティングできます。`~/.takt/config.yaml` と `.takt/config.yaml` のどちらでも定義できます。

```yaml
# ~/.takt/config.yaml
provider_routing:
  personas:
    coder:
      provider: codex
      model: gpt-5
      provider_options:
        codex:
          reasoning_effort: high
  tags:
    implementation:
      provider: codex
      model: gpt-5
    review:
      provider: opencode
      model: opencode/qwen3-coder-next
    final-gate:
      provider: codex
      model: gpt-5
      provider_options:
        codex:
          reasoning_effort: high
    edit:
      provider_options:
        codex:
          network_access: true
  steps:
    ai-antipattern-review-2nd:
      provider: opencode
      model: opencode/qwen3-coder-next
```

```yaml
# workflow.yaml
steps:
  - name: implement
    persona: coder
    persona_name: implementation-coder
    tags: [implementation, edit]
```

`provider_routing.personas` は workflow step の raw `persona` キーを使います。`persona_name` は表示専用で、routing には影響しません。`provider_routing.tags` は step の `tags` に一致する entry を適用します。複数 tag が一致した場合は step に書かれた順に適用され、後ろの tag が同じ provider / model / provider_options leaf を上書きします。たとえば builtin の最終ゲートは `review` の後に `final-gate` を持つため、通常レビューを OpenCode にしつつ merge-readiness / supervisor だけ Codex の高推論モデルへ上書きできます。より細かく分ける場合は `merge-readiness` と `supervise` タグを個別に指定できます。`provider_routing.steps` は workflow step の `name` を使います。

各 routing entry では `provider`、`model`、`provider_options` を指定できます。これらは個別に省略できますが、各 entry には少なくとも 1 つ必要です。空の `provider_options` オブジェクトは受理されません。

workflow step での `provider` / `model` 優先順位は次のとおりです。

```text
step YAML provider/model
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> workflow_config.provider/model
> 解決済みの入力
```

解決済みの入力は workflow 実行前に CLI フラグ、次に project `.takt/config.yaml`、global `~/.takt/config.yaml`、最後に provider デフォルトの順で決まります。promotion が有効な場合は、step YAML の値よりもさらに高い優先順位になります。

Finding Contract manager では、`finding_contract.manager.provider` と `finding_contract.manager.model` が合成 `findings-manager` step の `step YAML provider/model` 位置に入ります。

### Auto Routing

TAKT に provider と model の両方を実効 `auto_routing` candidate list から選ばせる場合は、`provider: auto` を設定します。次の例は project `.takt/config.yaml` または global `~/.takt/config.yaml` 用です。

```yaml
provider: auto

takt_providers:
  assistant:
    provider: codex
    model: gpt-5.6-sol

auto_routing:
  default_provider:
    provider: codex
    model: gpt-5.6-luna # 省略時は provider のデフォルトモデルを使用
  strategy: balanced # cost | balanced | performance
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: advanced
      description: Planning, final decisions, requirement-fulfillment judgment, and other advanced reasoning
      provider: codex
      model: gpt-5.6-sol
      cost_tier: high
    - name: coding
      description: Implementation, tests, debugging, and refactoring
      provider: codex
      model: gpt-5.6-terra
      cost_tier: medium
    - name: lightweight
      description: Formatting and small mechanical edits
      provider: codex
      model: gpt-5.6-luna
      cost_tier: low
  rules:
    tags:
      implementation: coding
      architecture: advanced
    steps:
      security-audit: advanced
    personas:
      architect: advanced
```

自己完結した workflow では workflow-level block で routing を上書きできます。workflow YAML が受理するのは routing 用フィールドだけであり、config 専用の `default_provider` は指定できません。

```yaml
workflow_config:
  provider: auto
auto_routing:
  strategy: balanced
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: coding
      provider: codex
      model: gpt-5.6-terra
      cost_tier: medium
      description: Implementation, testing, debugging, and refactoring
```

effective top-level provider が `auto` の場合、AI による task slug 生成など、workflow step context を持たず concrete provider を必要とする内部処理では `auto_routing.default_provider` を使用します。`default_provider.provider` は必須で、`auto` は指定できません。`default_provider.model` は省略可能です。project の `default_provider` は global の値よりオブジェクト単位で優先されるため、`provider` と `model` が global のオブジェクトのフィールドと合成されることはありません。このような処理の実行時に設定がない場合は、`Configuration error: auto_routing.default_provider is required when provider is auto for operations without workflow step context.` というエラーになります。effective top-level provider が concrete provider の場合は、従来どおり top-level の provider/model を使用します。

auto routing の candidate 選択が適用されるのは workflow の step 実行だけです。`auto_routing.router` は routing 判定専用であり、`default_provider` として暗黙に使用されません。インタラクティブ assistant は auto routing を通らず、引き続き `takt_providers.assistant` を使用します。この assistant 設定がその他の内部処理の default として使用されることもありません。top-level の `provider: auto` は assistant では無視されるため、`takt_providers.assistant` を併記するか、CLI で `--provider` を渡してください。どちらもない場合、assistant は起動時に `Provider is not configured.` で失敗します。

解決順序は保守的です。`promotion`、明示的な step provider/model、`provider_routing`、`persona_providers` が auto routing より優先されます。その後、auto routing は `tags`、`steps`、`personas` の順に rule を確認します。複数の step tag が一致した場合は、step 上で後ろに書かれた tag が優先されます。rule が一致しない場合、TAKT は設定された router model に candidate description から候補を選ばせます。router failure は warning を出し、strategy default にフォールバックします。`cost` は最初の `low` candidate、`balanced` は最初の `medium` candidate、`performance` は最初の `high` candidate を選びます。

candidate の `cost_tier` は `high`、`medium`、`low` のいずれかです。candidate の `provider_options` は step 優先度で merge されるため、env / CLI 由来の option leaf は引き続き優先されます。`model: auto` はサポートされません。複数 candidate を使ってください。CLI は `--auto-strategy cost|balanced|performance` で strategy を上書きできます。この上書きは、実効 workflow、step、parallel sub-step、workflow_call override、または解決済み workflow_call child が `provider: auto` を使う場合に適用されます。auto provider 経路がない場合、strategy flag は warning を出して無視されます。

Routing decision は local-only telemetry です。`telemetry.routing_decisions` が有効な場合、TAKT は project `.takt/events/` ディレクトリ配下に NDJSON として書き込みます。TAKT は routing decision をアップロードしません。この local recording 設定の確認・変更には `takt telemetry status`、`takt telemetry enable`、`takt telemetry disable` を使います。

workflow YAML の `model: null` は、明示的な entry レベル値として扱われます。step、parallel sub-step、`loop_monitors.judge` で model 解決を止めるため、下位優先度のソースやトリガー元 step 継承は `model` には使われません。`model` フィールドを省略した場合は通常どおりフォールバックします。

`provider_options` の優先順位は leaf ごとに解決されます。多くの leaf では env または CLI 起源の config leaf が他のすべてのソースより優先されます。例外は `base_url` です。workflow が特定の provider だけを明示的に proxy へ向けられるよう、`base_url` は step / workflow routing の設定を TAKT env override より優先します。`base_url` の順序は step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated の `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml` > TAKT env override です。preview、doctor、validation、summary、report などの補助入口も、workflow 実行と同じ `base_url` 優先順位を使います。他の leaf は env / CLI config override の後に同じ step-to-global 順序で解決されます。

安全のため、workflow YAML と project `.takt/config.yaml` で指定できる `base_url` は `127.0.0.1`、`127.x.x.x`、`localhost`、`*.localhost`、`::1` などの loopback host に限られます。非 loopback の provider base URL は、ユーザー管理の global config または `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` / `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL` に設定してください。

`persona_providers` は既存 config のため引き続き使用できますが、新規設定では deprecated です。これは step の persona display name を使うため、raw `persona` キーではなく `persona_name` 由来の名前に一致することがあります。

```yaml
persona_providers:
  implementation-coder:
    provider: codex
    model: gpt-5
    provider_options:
      codex:
        reasoning_effort: high
```

workflow の `provider_options.extends` は、共有 YAML プリセットを名前で読み込めます。名前は `.takt/provider-options`、`~/.takt/provider-options`、`builtins/{lang}/provider-options` の順に first-match で解決されます。repertoire package からインストールされた workflow では、それらより先に package-local の `provider-options/` が参照されます。`@owner/repo/name` 形式の scoped ref は、別の repertoire package の `provider-options/` から `name` を解決します。解決済み YAML は参照された workflow または step レイヤーの base として扱われ、同じ workflow または step の inline `provider_options` が一致する leaf を上書きします。

`provider_options.extends` は、preset または path を解決できない場合、scoped ref が利用可能な repertoire package を指していない場合、参照先 YAML が不正または provider-options object でない場合、extends チェーンが循環している場合、削除済みの `$ref` キーが使われた場合に、設定エラーとして fail fast します。相対 path は workflow file 基準で解決され、symlink 解決後も workflow directory 内に留まる必要があります。絶対 path と、実体が workflow directory 外へ出る path は拒否されます。

provider option の leaf は環境変数でも上書きできます。OpenCode の model variant は `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` で `provider_options.opencode.variant` を設定できます。provider base URL は `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` または `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787` を使用できます。これらは config layer を設定するもので、step や workflow routing の `base_url` leaf は上書きしません。Claude terminal は `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500` を使用できます。Kiro の custom agent は `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` で `provider_options.kiro.agent` を設定できます。

これにより、表示名と provider 選択を分離したまま、単一の workflow 内で provider や model を混在させることができます。

### プロバイダー固有オプションの実用例

#### Provider base URL (`base_url`)

OpenAI 互換または Anthropic 互換の proxy へ対応 provider を向けるには `base_url` を使います。

```yaml
provider_options:
  claude:
    base_url: http://127.0.0.1:8787
  codex:
    base_url: http://127.0.0.1:8787/v1
```

TAKT は `provider_options.claude.base_url` を `claude` と `claude-sdk` に `ANTHROPIC_BASE_URL` として渡します。`provider_options.codex.base_url` は Codex SDK constructor の `baseUrl` として渡します。`claude-terminal`、`opencode`、`cursor`、`copilot`、`kiro` は、別途文書化されるまでこの base URL 対応の対象外です。

`ANTHROPIC_BASE_URL` や `OPENAI_BASE_URL` など provider-native の環境変数は provider 側の fallback 設定です。上記 provider では、TAKT の `provider_options.*.base_url` が明示的な TAKT config として provider-native 設定より優先されます。

workflow と project config での `base_url` は local proxy 用に限定されています。任意の workflow file が API key と prompt の送信先を外部 host に変更できないよう、非 loopback の proxy endpoint は global config または TAKT env から設定してください。

#### ネットワークアクセス (`network_access`)

実装系の step で `npm install` / `pip install` / `gradle` / `mvn` などネットワークを使うコマンドを実行する場合、provider のサンドボックスでネットワークがブロックされて失敗することがあります。プロバイダーごとに次のように設定してください。

Codex はデフォルトでネットワーク遮断されています。許可するには次のとおりです。

```yaml
provider_options:
  codex:
    network_access: true
```

OpenCode はネイティブのサンドボックスを持ちません。TAKT は `webfetch` / `websearch` ツールの権限を抽象化レイヤーで制御し、同じキーで設定できます。

```yaml
provider_options:
  opencode:
    network_access: true
```

OpenCode のツール許可リストでは lowercase の OpenCode tool 名を使います。

```yaml
provider_options:
  opencode:
    allowed_tools: [read, glob, grep, bash, websearch, webfetch]
```

step / `provider_routing` / deprecated の `persona_providers` / `workflow_config` / project / global の各レイヤーで設定でき、step が最優先です。環境変数 `TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` でも上書きできます。

#### Claude Code の sandbox 制御 (`allow_unsandboxed_commands`)

Claude SDK は `permission_mode: edit` のとき Bash コマンドを macOS Seatbelt サンドボックス内で実行するため、`~/.gradle` への書き込みや JVM ベースのビルドツールが `Operation not permitted` で失敗することがあります。Bash コマンドだけサンドボックス外で実行したい場合は次のとおりです。

```yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

ファイル編集の権限は引き続き `permission_mode` で制御されます。

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
