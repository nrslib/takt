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
notification_sound_events:    # イベントごとの通知音切り替え（省略可。全イベントがデフォルト有効）
  iteration_limit: false      # 例: このイベントだけ false で無効化
  workflow_complete: true
  workflow_abort: true
  run_complete: true
  run_abort: true
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
# assistant 会話（インタラクティブモードの計画会話、既存タスクへの追加指示 (instruct)、
# リトライ対話）と Report phase fallback provider をルーティング
# Report fallback は OpenCode の report retry が失敗した場合のみ、この設定を使用します。
# project assistant は global assistant を上書きします。assistant 未設定時、Report fallback は
# top-level provider/model へ暗黙フォールバックしません。
# takt_providers:
#   assistant:
#     provider: claude
#     model: opus
#   selector:              # dynamic parallel selector 専用の任意設定
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` は任意です。provider/model の優先順位は、明示的な CLI または環境 override、project selector、global selector、project top-level、global top-level の順です。model は解決済み provider と一致する候補だけを採用します。`provider_options` は selector entry だけを global → project の leaf 単位でマージし、top-level・persona・pool sub-step の options は selector に継承されません。空の selector entry と空の `provider_options` entry は設定読み込み時に拒否されます。dynamic selector には strict read-only の内部 agent 隔離を保証できる provider が必要です。Claude、Codex、Mock はこの契約を満たし、OpenCode、Cursor、Copilot、Kiro は selector・participant 起動前に拒否されます。dynamic parallel を使わない workflow では selector 設定を解決せず、既存実行へ影響しません。

```yaml
# ~/.takt/config.yaml（続き）

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
#   routing_decisions: true       # auto-routing decision を .takt/events/ に書き込む（デフォルト: false。`takt telemetry enable` またはこのキーで有効化）
```

### グローバル設定フィールドリファレンス

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI 言語 |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | ログレベル |
| `logging.trace` | boolean | `false` | trace レベルのログを有効化（高頻度のデバッグノイズを抑制） |
| `logging.debug` | boolean | `false` | デバッグログを有効化（`debug.log` + `prompts.jsonl`） |
| `logging.provider_events` | boolean | `false` | provider stream イベントを永続化 |
| `logging.usage_events` | boolean | `false` | usage イベントログを永続化 |
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | デフォルトの具体 AI provider（`claude` = ヘッドレス CLI モード、`claude-sdk` = SDK/API モード、`claude-terminal` = experimental interactive terminal モード） |
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
| `sync_project_local_takt_on_retry` | boolean | `true` | retry / 再実行前にルートの project-local `.takt` を worktree へ同期。`false` で worktree 側のコピーを維持 |
| `worktree_dir` | string | - | 共有クローンのディレクトリ（デフォルトは `../{clone-name}`） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `draft_pr` | boolean | `false` | 自動作成する PR を draft として作成 |
| `minimal_output` | boolean | `false` | AI 出力を抑制（CI 向け） |
| `runtime` | object | - | ランタイム環境デフォルト（例: `prepare: [gradle, node]`） |
| `provider_routing` | object | - | 推奨設定。raw persona キー、step tag、step name による workflow step の provider / model / provider_options ルーティング |
| `auto_routing` | object | - | 候補プールからの provider / model 自動選択（[Auto Routing](#auto-routing) 参照） |
| `persona_providers` | object | - | deprecated の旧設定。persona display name ごとの provider / model / provider_options 上書き。新規設定では `provider_routing` を推奨 |
| `provider_options` | object | - | グローバルな provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `rate_limit_fallback` | object | - | rate limit 到達時のフォールバック。`switch_chain` に `{provider, model}` を列挙した順に切り替える |
| `anthropic_api_key` | string | - | Claude 用 Anthropic API キー |
| `openai_api_key` | string | - | Codex 用 OpenAI API キー |
| `gemini_api_key` | string | - | Gemini API キー |
| `google_api_key` | string | - | Google API キー |
| `groq_api_key` | string | - | Groq API キー |
| `openrouter_api_key` | string | - | OpenRouter API キー |
| `opencode_api_key` | string | - | OpenCode API キー |
| `cursor_api_key` | string | - | Cursor API キー（省略時は login セッションへフォールバック） |
| `copilot_github_token` | string | - | Copilot CLI 認証用 GitHub トークン |
| `kiro_api_key` | string | - | Kiro API キー |
| `codex_cli_path` | string | - | Codex CLI バイナリパス上書き（絶対パス） |
| `claude_cli_path` | string | - | Claude Code CLI バイナリパス上書き（絶対パス） |
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
| `takt_providers` | object | - | TAKT 内部プロバイダー上書き。`assistant` は assistant 会話（インタラクティブモードの計画会話、既存タスクへの追加指示 (instruct)、リトライ対話）をルーティングし、OpenCode の report retry 失敗後の Report phase fallback provider としても使われます。project の `takt_providers.assistant` は global の `takt_providers.assistant` を上書きします。どちらも未設定の場合、Report phase fallback は無効で、top-level `provider` / `model` は暗黙 fallback として使われません。 |
| `telemetry` | object | `{ routing_decisions: false }` | local-only の routing decision 記録。デフォルト無効（opt-in）です。`takt telemetry enable` または `routing_decisions: true` で有効化すると、auto-routing decision を project `.takt/events/` 配下に NDJSON として書き込みます。TAKT は routing decision をアップロードしません。 |
| `analytics` | object | 無効 | local-only の analytics 収集。`enabled` で有効化し、`events_path` でイベントディレクトリを変更（デフォルト `~/.takt/analytics/events`）、`retention_days` で `takt purge` が適用する保持期間を設定します（デフォルト: 30日）。TAKT は analytics イベントをアップロードしません。 |
| `workflow_mcp_servers` | object | すべて `false` | MCP サーバートランスポートポリシー（`stdio`, `sse`, `http` トグル） |
| `workflow_arpeggio` | object | すべて `false` | Arpeggio カスタムコードポリシー（`custom_data_source_modules`, `custom_merge_inline_js`, `custom_merge_files`） |
| `workflow_runtime_prepare` | object | `{ custom_scripts: false }` | ランタイム prepare ポリシー（ビルトインプリセットは常に許可） |
| `workflow_command_gates` | object | `{ custom_scripts: false }` | workflow YAML command quality gate ポリシー |
| `workflow_overrides` | object | - | workflow レベルの上書き。トップレベル / step 単位 / persona 単位の `quality_gates`（AI ディレクティブまたは `type: command` ゲート）と `quality_gates_edit_only` |
| `sync_conflict_resolver` | object | `{ auto_approve_tools: false }` | sync conflict resolver ポリシー |
| `observability` | object | 無効 | OpenTelemetry foundation の opt-in 設定。`enabled` で SDK を初期化し、`monitor` は workflow metric を `.takt/runs/<run>/monitor.json` に出力し、`session_log_exporter` は span 由来の shadow session log を出力します。`usage_events_phase` は phase 粒度の usage events を `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl` に出力します。`enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` が揃うと、TAKT は標準の `OTEL_EXPORTER_OTLP_*` 環境変数で span と metric も OTLP 送信します。TAKT 独自の OTLP config キーはありません。 |

## プロジェクト設定

`.takt/config.yaml` でプロジェクト固有の設定を行います。このファイルはプロジェクトディレクトリで初めて TAKT を使用した際に作成されます。

```yaml
# .takt/config.yaml
provider: claude              # このプロジェクトの provider 上書き
model: sonnet                 # このプロジェクトのモデル上書き
auto_pr: true                 # worktree 実行後に PR を自動作成
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
#     guards:
#       profile: standard
#       model_profiles:
#         "opencode/big-pickle": minimal
#         "lmstudio/*": standard
#       call_timeout_ms: 3600000
#       event_limit: 500000
#       text_byte_limit: 1048576
#       reasoning_byte_limit: 4194304
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

### OpenCode 実行ガード

`provider_options.opencode.guards.profile` の既定値は `standard` です。
`minimal` が無効にするのはヒューリスティックなループ検出だけで、時間・有界資源・
完全性・厳密 correction のガードは mandatory のままです。`model_profiles` は解決済み
モデル文字列を記述順に照合し、`*` だけをワイルドカードとして扱います。guards の
各 leaf は provider option の各レイヤー間で個別にマージされますが、上位優先度の
`model_profiles` は下位の map 全体を置換します。

OpenCode の単一 call には既定で 3,600,000 ms（60分）の wall-clock 上限があります。
60分を超える可能性がある call は、60,000〜86,400,000 の
`call_timeout_ms` を明示してください。テストスイートの実行のような長時間の作業を
含む step は、この上限に達して切断されます。`event_limit` の既定値は 500,000 で、
`TAKT_OPENCODE_STREAM_EVENT_LIMIT` でも上書きできます。`text_byte_limit` の既定値は 1 MiB、
`reasoning_byte_limit` は 4 MiB です。

ストリームの無音は 10 分（`TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS` で上書き可）で
idle timeout として扱われますが、ツール呼び出しが in-flight の間は計測しません。
OpenCode は tool_use から tool_result までイベントを流さないため、テストスイート
実行のような長時間のツールを無音と判定すると健全な実行を切ってしまうからです。
結果が返らないツールは `call_timeout_ms` の wall-clock 上限が受け持ちます。運用上の
帰結として、ツール実行中に本当に処理が止まった場合の検知は既定 10 分ではなく
`call_timeout_ms`（既定 60 分、引き上げればさらに）まで伸びます。ツール結果イベントを
取りこぼした場合も、in-flight 登録から idle timeout の6倍を過ぎた時点で stale として
捨てるため、検知が止まったままにはなりません。

数値上限の不正値は入力経路で扱いが異なります。`guards.*` に書いた値（および
`TAKT_PROVIDER_OPTIONS_*` 由来の値）は宣言された設定なので、正の整数でなければ
エラーで停止します。一方 `TAKT_OPENCODE_*` は実験・テスト用の一時上書きなので、
不正値は無視して既定値へ戻ります。

旧 `TAKT_OPENCODE_TOOL_ERROR_BUDGET`、
`TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`、
`TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`、
`TAKT_OPENCODE_TOOL_SUCCESS_REPEATS`、
`TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` はガードを制御せず、無視時に一度だけ
警告されます。これらを削除し、上記の `guards` profile と有界上限へ移行してください。
terminal tool の完全一致反復は、廃止された累積検出ではなく固定の連続 tuple ガードに
置き換わっています。

### プロジェクト設定フィールドリファレンス

プロジェクト設定はグローバル設定のほとんどのキーを受け付け、グローバル値を上書きします（例: `language`、`branch_name_strategy`、`minimal_output`、`task_poll_interval_ms`、`interactive_preview_steps`、`provider_routing`、`persona_providers`、`runtime`、`analytics`、`telemetry`、`rate_limit_fallback`、`workflow_overrides`。意味は[グローバル設定フィールドリファレンス](#グローバル設定フィールドリファレンス)を参照）。プロジェクト設定のスキーマは strict で、`logging`、`disabled_builtins`、`enable_builtin_workflows`、通知設定、API キー、CLI パスなどのグローバル専用キーを `.takt/config.yaml` に書くと起動時に config validation error になります。次の表はプロジェクト専用キーと、よく使う上書きキーの一覧です。

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | 具体 provider の上書き |
| `model` | string | - | モデル名の上書き（provider にそのまま渡される） |
| `submodules` | `"all"` \| string[] | - | プロジェクト専用。共有クローンで初期化する submodule。`"all"` または明示パスリスト（ワイルドカード不可） |
| `with_submodules` | boolean | - | プロジェクト専用。`submodules: "all"` 相当の旧 boolean 設定。`submodules` を推奨 |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `draft_pr` | boolean | `false`（global 設定由来） | 自動作成する PR を draft として作成 |
| `concurrency` | number (1-10) | `1`（global 設定由来） | `takt run` の並列タスク数 |
| `auto_requeue_max_attempts` | 非負整数 | `0`（global 設定またはデフォルト由来） | `takt run` 中に失敗した workflow task を自動 requeue する上限回数。`0` で無効 |
| `ignore_exceed` | boolean | `false`（global 設定またはデフォルト由来） | `takt run` / `takt watch` の iteration 上限無視を設定します。CLI で `--ignore-exceed` を指定した場合は CLI 指定が優先されます |
| `base_branch` | string | - | クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ） |
| `assistant.init_files` | string[] | - | project config 専用のインタラクティブ assistant 初期コンテキストファイル。パスは project root 相対で指定します。絶対パス、project root 外へ解決されるパス、`.env*` / `.npmrc` / `.pypirc` / `.netrc` / `*.pem` / `*.key` / `.git/**` などの機密ファイルパターンは拒否されます。存在しないパス、ディレクトリ、読めないファイルは分かるエラーになります。最大16ファイルまで指定でき、1ファイルは256KiB、合計本文は1MiBまでです。未設定または空の場合、`CLAUDE.md`、`AGENT.md`、`AGENTS.md`、`TAKT.md` などは自動探索されません。assistant の provider/model だけを制御する `takt_providers.assistant` とは別設定です。 |
| `provider_options` | object | - | provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自動検出 | VCS プロバイダー（グローバルを上書き） |
| `takt_providers` | object | - | TAKT 内部プロバイダー上書き。project の `takt_providers.assistant` は global assistant provider/model を上書きし、assistant 会話（インタラクティブモードの計画会話、既存タスクへの追加指示 (instruct)、リトライ対話）と、OpenCode の report retry 失敗後の Report phase fallback に使われます。project と global の assistant がどちらも未設定の場合、Report phase fallback は無効で、top-level `provider` / `model` は暗黙 fallback として使われません。 |
| `workflow_mcp_servers` | object | - | MCP サーバートランスポートポリシー（グローバルを上書き） |
| `workflow_arpeggio` | object | - | Arpeggio カスタムコードポリシー（グローバルを上書き） |
| `workflow_runtime_prepare` | object | - | ランタイム prepare ポリシー（グローバルを上書き） |
| `workflow_command_gates` | object | - | workflow YAML command quality gate ポリシー（グローバルを上書き） |
| `sync_conflict_resolver` | object | - | sync conflict resolver ポリシー（グローバルを上書き） |
| `observability` | object | - | プロジェクトレベルの OpenTelemetry opt-in 上書き。`enabled` で SDK を初期化し、`monitor` は workflow metric を `.takt/runs/<run>/monitor.json` に出力し、`session_log_exporter` は span 由来の shadow session log を出力します。`usage_events_phase` は phase 粒度の usage events を `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl` に出力します。`enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` が揃うと、TAKT は標準の `OTEL_EXPORTER_OTLP_*` 環境変数で span と metric も OTLP 送信します。TAKT 独自の OTLP config キーはありません。 |

プロジェクト設定の値は、両方が設定されている場合にグローバル設定を上書きします。

Finding Contract の正規化係に `config.yaml` のキーはありません。Finding Contract の reviewer は
全員が通常の Markdown report を書き、TAKT はその report を保存して、それだけを tool なしの新規
structured session へ渡します。呼び出しはレビュアー×ラウンドごとに1回です。その session の
provider/model は、runtime.yaml の
`provider.targets.internal_agents['intake-normalizer']` seat → reviewer の profile が宣言する
`escalate` 先 → 通常の既定解決、の順で決まります。先頭の候補は isolated structured
execution に対応している必要があり、対応していない場合は黙って続行せずその理由を示して停止します。
正規化係の出力が検証と訂正1回のどちらも通らなかった場合は、同じチェーンの次の候補（すでに使った
候補と `(provider, model)` が異なり、isolated structured execution に対応する最初のもの）で
1度だけやり直します。それでも失敗した場合は候補ごとの具体的な理由を示して停止します。正規化係も合成ステップとして通常どおり解決されるため、CLI や環境変数による明示的な
provider/model override は正規化係にも適用されます。これは意図した挙動です — 明示 override は
TAKT のどこでも最優先レイヤだからです。その帰結として、isolated structured execution に対応
しない provider を明示指定して Finding Contract ランを走らせると、黙って劣化するのではなく
正規化係の理由を示して停止します。`finding_intake_normalizer` operation に登録された rate-limit
fallback は、その呼び出しに限って正規化係を差し替えます。

廃止された `finding_contract.intake_normalize` キーはもう存在しません。正規化は組み込み動作に
なりました。まだこのブロックを書いている workflow は strict スキーマの未知キー拒否で読み込みに
失敗します。ブロックごと削除してください。

run metadata、session log、trace、report などのrun lifecycle artifactは、
引き続き `.takt/runs/<run>/` 配下のファイルです。Finding Contractの状態だけは
分離され、Finding authorityを初めて解決した時点で
`.takt/runs/<run>/finding-contract.sqlite` を遅延作成します。このDBはFinding
Contract管理用のrun-scopedな内部authorityであり、run自体の記録ではありません。
resumeやrequeueでは別runであってもsource runのFinding DBからtargetをseedできます。
sourceにFinding DBがなければ、resumeを拒否せず空のledgerから開始します。

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

## 環境変数上書き

ほとんどの設定キーは、`TAKT_` に設定キーパスをアンダースコア区切り・大文字化して続けた環境変数で上書きできます。`logging.debug` は `TAKT_LOGGING_DEBUG`、`telemetry.routing_decisions` は `TAKT_TELEMETRY_ROUTING_DECISIONS` になります。よく使う例: `TAKT_PROVIDER`、`TAKT_MODEL`、`TAKT_CONCURRENCY`、`TAKT_LOGGING_DEBUG`、`TAKT_TELEMETRY_ROUTING_DECISIONS`、`TAKT_OBSERVABILITY_ENABLED`。環境変数の値は対応するファイルの値を上書きし、キーを持つ層で適用されます。グローバル専用キー（例: `logging`、`disabled_builtins`）はグローバル `~/.takt/config.yaml` 層で、プロジェクト上書き可能キー（例: `concurrency`、`telemetry.routing_decisions`）はプロジェクト `.takt/config.yaml` 層でも解決されます。

設定キー上書きとは別に、`TAKT_NOTIFY_WEBHOOK` には Slack Incoming Webhook URL を設定できます。設定すると、pipeline 完了時と `takt run` のタスクバッチ完了時（run summary）に Slack へ通知が送信されます。

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

provider と model の選択には、[Provider Routing](#provider-routing) に記載した単一のフィールド別優先順位を使用します。通常 step、parallel sub-step、合成 step、workflow call は、各種類で利用可能なレイヤーについて同じ契約に従います。parallel sub-step は promotion をサポートしません。

Finding Contract workflow に provider や model の名前は書きません。合成ロールの宛先は `runtime.yaml` の `provider.targets.internal_agents` seat（すべて任意）で指名し、指定された seat はそのロールの合成 step の step レベル provider/model として扱われます。実装上のフィールド別優先順は、CLI/環境変数の明示 override → 実行時にマッチした promotion（通常の agent step のみ）→ step または parallel sub-step の provider/model（seat 指定を含む）→ `workflow_call` override → `provider_routing` の step/tag/persona → deprecated の `persona_providers` → auto routing → workflow → project → global → provider default です。seat 未指定のロールは通常の workflow step と同じ fallback chain を使います。provider だけを指名した seat は下位優先度の model fallback を止めるため、明示 model が必須の provider では検証エラーになります。

```yaml
# runtime.yaml
version: 1
provider:
  profiles:
    strong: { provider: codex, model: <strong-model> }
  targets:
    internal_agents:
      findings-manager:     { profile: strong }
      terminal-adjudicator: { profile: strong }
      loop-judge:           { profile: strong }
      escalation-reviewer:  { profile: strong }
      intake-normalizer:    { profile: strong }
```

workflow YAML では、通常 step、parallel sub-step、`loop_monitors.judge` の `model: null` は model の明示的な省略を表します。`model` 未指定とは異なります。未指定の場合は routing、workflow、loop monitor judge のトリガー元 step、入力由来の値など、適用可能な下位優先度のソースへフォールバックしますが、`model: null` はその entry で model 解決を止め、実効 model を未定義のままにします。解決済み provider に CLI または provider 側のデフォルトを使わせたい場合に指定します。明示 model が必須の provider では、model が供給されないため検証エラーになります。

### Provider 固有のモデルに関する注意

**Claude Code** はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）と完全なモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。`model` フィールドは provider CLI にそのまま渡されます。利用可能なモデルについては [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code) を参照してください。

**Codex** は Codex SDK を通じてモデル文字列をそのまま使用します。未指定の場合、デフォルトは `codex` です。利用可能なモデルについては Codex のドキュメントを参照してください。

**OpenCode** は `provider/model` 形式のモデル（例: `opencode/big-pickle`）が必要です。OpenCode provider でモデルを省略すると設定エラーになります。

**Cursor Agent** は `model` を `cursor-agent --model <model>` にそのまま渡します。省略時は Cursor CLI のデフォルトが使用されます。

**GitHub Copilot CLI** は `model` を `copilot --model <model>` にそのまま渡します。省略時は Copilot CLI のデフォルトが使用されます。

**Kiro CLI** は `model` を `kiro-cli chat --model <model>` にそのまま渡します。省略時は Kiro CLI のデフォルトが使用されます。

### 設定例

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # すべての step のデフォルトモデル（上書きされない限り）
```

```yaml
# workflow.yaml - step レベルの model 選択
steps:
  - name: plan
    model: opus       # この step はグローバル設定に関係なく opus を使用
    ...
  - name: implement
    # model 未指定 - グローバル設定（opus）にフォールバック
    ...
```

## Runtime Provider 設定（runtime.yaml）

`runtime.yaml` は provider/model/options を workflow の外へ切り出し、同じ workflow を編集せずに異なる実行環境で再利用できるようにします。次の 2 つの固定パスから読み込み、project 側の設定を global より優先します。

1. `~/.takt/runtime.yaml`
2. `<project>/.takt/runtime.yaml`

runtime モードはファイルの存在ではなく、有効な `provider` セクションの有無で有効化されます。`version: 1` だけのファイルは inactive で、従来の `config.yaml` による provider 解決がそのまま使われます。

### 設定例

```yaml
version: 1

provider:
  defaults:
    pool: sol-pool

  profiles:
    sol-high:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: high
    sol-medium:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: medium
    sol-low:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: low
      escalate: sol-high
    router:
      provider: codex
      model: gpt-5.6-luna
      options:
        reasoning_effort: high

  targets:
    personas:
      coder:
        profile: sol-medium
    tags:
      high-stakes:
        profile: sol-high
    steps:
      default/supervise:
        profile: sol-high
    internal_agents:
      selector:
        profile: router
      intake-normalizer:
        profile: sol-high
      findings-manager:
        profile: sol-high
      terminal-adjudicator:
        profile: sol-high

  auto_routing:
    strategy: balanced
    router_profile: router
    pools:
      sol-pool:
        candidates:
          - profile: sol-high
            tier: high
          - profile: sol-medium
            tier: medium
          - profile: sol-low
            tier: low
        fallback_profile: sol-high
```

`provider.profiles` は名前付きの provider/model/options 定義を保持します。profile のフラットな `options` はその profile の provider に適用されます（例えば `reasoning_effort` は Codex の `reasoning_effort` オプションになります）。profile は明示的な `extends` で別の profile を継承できます。global と project で同名の profile を field 単位で暗黙に混ぜることはなく、project の定義が profile 全体を置き換えます。

`provider.defaults` と各 `provider.targets` エントリは、固定の `profile` か auto routing を行う `pool` のいずれか一方だけを指定します。step は `<leaf-workflow-name>/<step-name>` 形式で指定し、agent を起動しない制御ノード（`workflow_call` など）は解決対象になりません。

### `escalate` — その profile の最後の一手

profile は `escalate` で別の profile を指名できます。「この profile で解決された作業が行き詰まったら、その profile へ渡す」という宣言です。弱い側の profile に1行書くだけで設定は完了し、workflow 側に provider 名やモデル名は一切現れません。

```yaml
provider:
  profiles:
    reviewer-local:
      provider: opencode
      model: ollama-cloud/gemma4:31b
      escalate: strong
    strong:
      provider: opencode
      model: ollama-cloud/glm-5.2
```

- 参照は agent を実行する前のコンパイル時に検証します。未定義 profile の参照、自己参照、`escalate` の循環はすべて読み込み時エラーです。
- `escalate` は `provider` / `model` / `options` と同じく `extends` を通じて継承されます。
- 消費されるのは常に1ホップだけです。`escalate` は作業者の最後の一手であり、段階的な ladder ではありません。
- `--provider` や step YAML、`workflow_call` の上書きで provider が決まった step は、その profile で動いていないため格上げ先を持ちません。auto routing の `pool` で割り当てられた step も同様です。
- 現在エンジンが `escalate` を消費するのは Finding Contract の格上げ再レビューです。[workflows.ja.md](workflows.ja.md) を参照してください。

### 解決の優先順位

workflow agent の provider は次のラダーで解決し、後のエントリが前のエントリを上書きします。

```text
defaults
  < personas
  < tags
  < steps
```

内部 agent（`selector` / `assistant` / `intake-normalizer` / `findings-manager` /
`terminal-adjudicator` / `loop-judge` / `escalation-reviewer`）は別のラダーで解決します。
`internal_agents` は step 解決後に汎用的に上書きされる target ではありません。

```text
defaults
  < internal_agents.<agent>
```

`terminal-adjudicator` は persona facet「supervisor」に対応するロールの runtime 上の名前で、
両者は意図的に別の名前です。

**seat の指定はすべて任意です。** 未指定の seat は何も変えません。そのロールは従来どおりの
解決を続けます。Finding Contract の合成ロールでは persona routing（固定キー
`findings-manager` / `supervisor` / `loop-judge`）→ workflow → project → global →
provider 既定の順です。`intake-normalizer` はその先にも候補が続き、レビュアー profile の
`escalate` 先 → 通常の既定解決の順で決まります（[workflows.ja.md](workflows.ja.md) 参照）。

`escalation-reviewer` だけは「そのロールが走るかどうか」を一切変えません。格上げ再レビューは
レビュアーが解決された profile が `escalate` を宣言している場合にだけ発火し、宣言の無い
レビュアーは seat の有無にかかわらず最終提示も本人が受け持ちます。seat は
`escalate` 宣言によって既に発火した格上げの宛先だけを差し替えます。

同じ優先度の target（例えば複数の一致する tag）が異なる provider を割り当てた場合は、暗黙に一方を選ばず fail-fast します。コマンドラインの `--provider` / `--model` は実行時 override であり、legacy と runtime のどちらのモードでも許可されます。

auto routing の candidate は provider/model/options を重複記述せず `provider.profiles` を参照し、router 自身も `router_profile` で profile を参照します。pool・tier などの routing metadata は `provider.auto_routing` が所有します。router 出力の parse/schema 不整合や未知の profile 参照は、fallback で隠さず agent 実行前に fail-fast します。

### legacy config.yaml からの移行

runtime と legacy の provider 設定は混在させられません。各 legacy 設定を次の移行先へ移してください。

| 既存設定 | 移行先 |
|---|---|
| `provider` / `model` | `provider.defaults` から参照する profile |
| `provider_options` | `provider.profiles.*.options` |
| `provider_routing.personas` | `provider.targets.personas` |
| `provider_routing.tags` | `provider.targets.tags` |
| `provider_routing.steps` | `provider.targets.steps` |
| `persona_providers` | `provider.targets.personas` |
| `takt_providers.selector` / `takt_providers.assistant` | `provider.targets.internal_agents` |
| `finding_contract.manager.provider` / `model` | `provider.targets.internal_agents.findings-manager` |
| `finding_contract.adjudicator.provider` / `model` | `provider.targets.internal_agents.terminal-adjudicator` |
| `auto_routing` | `provider.auto_routing` |
| auto routing candidates | `provider.profiles` を参照する pool candidates |
| workflow 内の provider 指定 | `provider.targets.steps` |

末尾2行は `config.yaml` の設定ではなく workflow YAML のキーで、deprecated ではなく削除済みです。
`finding_contract` のスキーマは strict なので、`manager` / `adjudicator` に `provider` や `model`
が残っているとロード時に未知キーとして拒否され、キー名とパスが示されます。値は対応する
`internal_agents` seat へ移すか、削除して以降のレイヤーへ委ねてください。

### 混在エラー

有効な `runtime.yaml` provider セクションが legacy provider 設定と共存している場合、TAKT は agent を実行する前に停止し、各箇所とその移行先を示します。

```text
Mixed provider configuration detected: an active runtime.yaml provider section cannot
coexist with legacy provider settings. Remove the runtime.yaml provider section or migrate
the following legacy settings:
  - provider at config.yaml:provider (global) → migrate to provider.defaults + provider.profiles
  - provider_routing at config.yaml:provider_routing → migrate to provider.targets
```

### 初回生成

初回起動時、TAKT は `~/.takt/runtime.yaml` を atomic に生成し、既存ファイルは上書きしません。project 側の `.takt/runtime.yaml` は自動生成されません。新規環境では、選択された provider/model を `provider.profiles.default` と `provider.defaults.profile: default` として書き込みます。legacy provider 設定が既に存在する環境には inactive な `version: 1` ファイルだけを生成し、移行するまで動作は変わりません。

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

すべての provider には組み込みの `default_permission_mode: edit` があり、この解決に常に参加します。project と global のどちらの `provider_profiles` も未設定の場合、実効モードは `edit` です（step の `required_permission_mode` がより高いモードを要求する場合は引き上げられます）。

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

workflow step での `provider` / `model` の完全な優先順位は次のとおりです。

```text
CLI / 環境変数の明示 override
> 有効な promotion（通常の agent step のみ。parallel sub-step では非対応）
> step または parallel sub-step YAML provider/model
> workflow_call override
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> effective auto_routing（auto.rules / auto.dynamic / auto.fallback）
> workflow_config.provider/model
> project .takt/config.yaml
> global ~/.takt/config.yaml
> provider default
```

provider と model は各レイヤーで個別に解決されます。provider だけの override によって、より高い優先順位の model override が失われることはありません。

「有効な promotion」とは、通常の agent step の `promotion` エントリのうち、実行回数条件（`at: <N>`）または `ai()` 条件が現在の実行にマッチしたものを指します。parallel sub-step では promotion を指定できないため、CLI/環境変数の明示 override の次に sub-step YAML の provider/model が優先されます。[Step レベルのプロバイダープロモーション](./workflows.ja.md#step-レベルのプロバイダープロモーション)を参照してください。

指定された `internal_agents` seat は、そのロールの合成 step の `step YAML provider/model` 位置に入ります。seat の指定はすべて任意で、未指定なら以降のレイヤーへそのまま落ちます。

seat 未指定の場合、合成された Finding Contract ロールは、設定した persona 名ではなく固定の persona キーで `provider_routing.personas` を解決します。`findings-manager`（manager）、`supervisor`（conflict / terminal adjudication）、`loop-judge`（loop monitor の judge）です。格上げ再レビューに persona routing はありません。発火するのはレビュアーが解決された profile が `escalate` を宣言している場合だけで、`escalation-reviewer` seat は発火条件を動かしません。owner レビュアーの step をそのまま継承し、モデルは seat があればそこから、無ければ `escalate` 先から取ります。reviewer キーは固定文字列 `escalation-reviewer` で、Finding Contract workflow では常に予約 step 名です。

### Auto Routing

TAKT に provider と model の両方を candidate list から選ばせる場合は、`auto_routing` を定義します。global、project、workflow の設定解決後にこの設定が存在すると auto routing が有効になります。workflow step 外の処理と effective `auto_routing` がない場合の fallback 用に、top-level には具体 provider/model を設定します。次の例は project `.takt/config.yaml` または global `~/.takt/config.yaml` 用です。

```yaml
provider: codex
model: gpt-5.6-luna

auto_routing:
  strategy: balanced # cost | balanced | performance
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: advanced
      description: Planning, final decisions, requirement-fulfillment judgment, and other advanced reasoning
      provider: codex
      model: gpt-5.6-sol
      routing_tier: high
    - name: coding
      description: Implementation, tests, debugging, and refactoring
      provider: codex
      model: gpt-5.6-terra
      routing_tier: medium
    - name: lightweight
      description: Formatting and small mechanical edits
      provider: codex
      model: gpt-5.6-luna
      routing_tier: low
  rules:
    steps:
      security-audit: advanced
  default_pool: general
  candidate_pools:
    general:
      candidates: [lightweight, coding, advanced]
      fallback: advanced
    implementation:
      candidates: [coding, advanced]
      fallback: advanced
  pool_rules:
    tags:
      implementation: implementation
```

自己完結した workflow では workflow-level block で routing を上書きできます。workflow-level の `auto_routing` block 自体が、その workflow の auto routing を有効にします。

```yaml
workflow_config:
  provider: codex
  model: gpt-5.6-luna
auto_routing:
  strategy: balanced
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: coding
      provider: codex
      model: gpt-5.6-terra
      routing_tier: medium
      description: Implementation, testing, debugging, and refactoring
  default_pool: general
  candidate_pools:
    general:
      candidates: [coding]
      fallback: coding
```

auto routing の candidate 選択が適用されるのは workflow の step 実行だけです。AI による task slug 生成や sync conflict resolver など workflow step context を持たない内部処理は、解決済みの具体的な top-level provider/model を使用します。`auto_routing.router` と candidates は default として暗黙に使用されません。

assistant 会話（インタラクティブモードの計画会話、既存タスクへの追加指示 (instruct)、リトライ対話）は auto routing を通りません。設定済みなら `takt_providers.assistant`、未設定なら top-level provider/model を解決し、この assistant 設定はその他の内部処理の default にはなりません。CLI の `--provider` / `--model` override が適用されるのはインタラクティブモードの計画会話だけで、instruct / retry には適用されません。解決可能な assistant または top-level provider がない場合、assistant は起動時に `Provider is not configured.` で失敗します。

auto routing の位置は、前述の provider/model の完全な優先順位に従います。hard rule は `tags`、`steps`、`personas` の順に確認します。それ以外は `pool_rules` が candidate pool を選び、router は必要な tier だけを推定し、TAKT が candidate を決定的に選びます。推定成功後、`cost` と `balanced` は選択された pool 内で必要 tier を満たす最小の `routing_tier` を選びます。同じ tier の candidate が複数ある場合は、どちらもその pool の `candidates` リストに記載された順序を使います。`performance` は選択された pool 内で最も高い `routing_tier` を選びます。推定失敗時は当該 pool の明示 `fallback` を使用し、推定成功後に必要 tier を満たす candidate がなければ実行エラーになります。

candidate の `routing_tier` は `high`、`medium`、`low` のいずれかです。すべての設定には `strategy`、`router`（`provider` と `model`）、最低 1 つの `candidates` エントリ、`default_pool`、空でない `candidate_pools`、pool 内の `fallback` が必要です。`router.model` と各 candidate の `model` は、数字か `/` を含む full model id である必要があります。`sonnet` などのエイリアスは validation で拒否されます。candidate の `provider_options` は step 優先度で merge されるため、env / CLI 由来の option leaf は引き続き優先されます。`model: auto` はサポートされません。複数 candidate を使ってください。CLI は `--auto-strategy cost|balanced|performance` で strategy を上書きできます。この上書きは、実行が effective `auto_routing` を持つ workflow に到達するまで伝播します。到達しないまま実行が完了した場合は、strategy flag が warning を出して無視されます。router には正規化済みの task、raw step instruction、現在の残作業が送信されます。識別子の置換は識別リスクを下げますが、匿名性を保証しません。routing event は local-only であり、routing 本文を保存しません。

Routing decision は local-only telemetry で、デフォルトでは記録されません。`telemetry.routing_decisions` を有効化した場合（`takt telemetry enable` または `routing_decisions: true`）、TAKT は project `.takt/events/` ディレクトリ配下に NDJSON として書き込みます。TAKT は routing decision をアップロードしません。この local recording 設定の確認・変更には `takt telemetry status`、`takt telemetry enable`、`takt telemetry disable` を使います。

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

provider option の leaf は環境変数でも上書きできます。OpenCode の model variant は `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` で `provider_options.opencode.variant` を設定できます。provider base URL は `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` または `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787` を使用できます。これらは config layer を設定するもので、step や workflow routing の `base_url` leaf は上書きしません。Codex Skill の継承は `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_REPO=true` または `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_USER=true` で設定できます。Claude Skill の継承は `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED=true` で設定できます。Claude terminal は `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500` を使用できます。Kiro の custom agent は `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` で `provider_options.kiro.agent` を設定できます。

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

外部の proxy / gateway サービス（OpenAI 互換または Anthropic 互換 API を話す任意のエンドポイント）へのルーティングにも使えます。ただし非 loopback host を許可する層（global config または `TAKT_PROVIDER_OPTIONS_*_BASE_URL` 環境変数）で設定する必要があります。workflow 層と project 層で受理されるのは loopback アドレスのみです。

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

#### Codex Skill の継承 (`skills`)

TAKT workflow は repository scope と user scope の Codex Skill をデフォルトでは継承しません。workflow が環境依存の指示を利用すべき場合だけ、対象 scope を明示的に有効化します。例外として `takt exec` は、各 scope が明示設定されていない場合、その scope を継承し、解決結果を生成する `.takt/exec/workflow.yaml` に書き込みます。これにより、Assistant 対話と生成 workflow は同じスナップショットを使い、生成パスを指定した直接の再実行でもその値を維持します。後の実行で指定した `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_*` 環境変数は引き続き最優先で、保存値を意図的に上書きします。

```yaml
provider_options:
  codex:
    skills:
      repo: true
      user: false
```

- `repo` は Codex の実行 CWD から repository root までの各 `.agents/skills` を対象にします。
- `user` は `$HOME/.agents/skills` と互換パス `$CODEX_HOME/skills` を対象にします。互換パス配下の `.system` は除外します。
- `false` は対象 scope の各 `SKILL.md` を探索し、symlink を絶対実体パスへ解決して重複を除去したうえで、Codex process に exact path の `enabled: false` override を渡します。
- `true` は対象 scope に enable override を渡さず、Codex の標準動作と既存の user config を尊重します。

探索にはCodexと同じ深度・directory数・entry数の上限を適用します。上限を超えた場合、部分的なdeny listを適用せずprovider callを失敗させます。この設定は user の Codex config を変更しません。ADMIN、SYSTEM、Plugin Skill は探索rootの対象外で、Codex の標準動作を維持します。通常の provider option leaf 優先順位で解決され、retry と session resume にも同じ値が適用されます。

#### Claude Skill の継承 (`skills`)

TAKT は `claude-sdk`、`claude`、`claude-terminal` の filesystem Skill 探索をデフォルトで無効にします。repository または user Skill に意図的に依存する workflow だけで有効化してください。

```yaml
provider_options:
  claude:
    skills:
      enabled: true
```

`enabled: false` の場合、`claude-sdk` には `skills: []` を渡し、`claude` と `claude-terminal` には `--disable-slash-commands` を渡します。この CLI flag は custom Claude slash command も無効にします。`enabled: true` の場合、TAKT は Skill 用の option/flag を追加せず、Claude の標準探索を維持します。この値は通常の provider option leaf 優先順位と `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED` に従い、retry と resume でも維持されます。

これは context filter であり sandbox ではありません。Skill file が Read/Bash から到達可能な場合は引き続き読めます。TAKT は `settingSources`、Claude settings、user/repository の Skill file を変更しません。同梱の Agent SDK version は `0.3.206` です。CLI session では `--disable-slash-commands` 対応が必要で、headless (`claude`) と terminal (`claude-terminal`) の各 CLI session の開始前に確認し、非対応なら更新を促すエラーを返します。検証済みの Claude Code 最低 version は `2.1.220` です。

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

カテゴリ構造には正準キーの **`workflow_categories`** と **`workflows`** を使います。加えて、上の例にあるトップレベルの任意設定 `show_others_category` / `others_category_name` も使えます。削除済みの旧カテゴリキーは受理されません。指定すると validation error になります。

### 設定方法

カテゴリは次の場所で設定できます。
- `builtins/{lang}/workflow-categories.yaml` — TAKT 同梱のデフォルト
- `~/.takt/preferences/workflow-categories.yaml` — ユーザー上書きファイル。`~/.takt/config.yaml` の `workflow_categories_file` で別パスも指定可能

`workflow_categories` を `~/.takt/config.yaml` 自体に書くことはできません。config スキーマは strict でこのキーを拒否します。`config.yaml` に書けるのはファイルパス（`workflow_categories_file`）だけで、カテゴリ本体は専用の上書きファイルに書きます。

```yaml
# ~/.takt/preferences/workflow-categories.yaml（または workflow_categories_file で指定したファイル）
workflow_categories:
  Development:
    workflows: [default, simple]
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

- **ネストされたカテゴリ** — 階層的な整理のための無制限の深さ。カテゴリ配下の `workflows` 以外のキーはすべて子カテゴリ名として扱われます（`children:` キーはありません）
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
| `--draft` | 自動作成する PR を draft として作成（`--auto-pr` または `auto_pr` 設定が必要） |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（workflow のみ実行） |
| `--repo <owner/repo>` | PR 作成用のリポジトリを指定 |
| `--auto-strategy <strategy>` | auto routing の strategy を上書き（`cost` \| `balanced` \| `performance`） |
| `-q, --quiet` | 最小出力モード（AI 出力を抑制） |

## デバッグ

### デバッグログ

`~/.takt/config.yaml` で `logging.debug: true` を設定してデバッグログを有効化できます（`logging` キーはグローバル専用です）。

```yaml
logging:
  debug: true
```

デバッグログは `.takt/runs/debug-{timestamp}/logs/debug-{timestamp}.log` に NDJSON 形式で出力され、プロンプト/レスポンスログは同じディレクトリの `debug-{timestamp}-prompts.jsonl` に出力されます。

### 詳細コンソール出力

`logging.level: debug` を設定すると、詳細なコンソール出力が有効になります。

```yaml
# ~/.takt/config.yaml
logging:
  level: debug
```

これは CLI 内部の verbose console mode も有効にします。さらに `logging.level: debug` だけでデバッグロガーも有効になるため、上記の `debug-{timestamp}.log` と `debug-{timestamp}-prompts.jsonl` は `logging.debug` を別途設定しなくても出力されます。`logging.debug: true`、`logging.trace: true`、`logging.level: debug` のいずれかで有効になります。
