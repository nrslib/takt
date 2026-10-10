# 設定

[English](./configuration.md) | [日本語](./configuration.ja.md) | [简体中文](./configuration.zh-CN.md)

このドキュメントは TAKT の全設定オプションのリファレンスです。クイックスタートについては [README](../README.md) を参照してください。
phase 粒度の usage events と集計方法は [Observability Guide](./observability.ja.md) を参照してください。

## グローバル設定

`~/.takt/config.yaml` で TAKT のデフォルト設定を行います。このファイルは初回実行時に自動作成されます。すべてのフィールドは省略可能です。

TAKT は、存在するグローバル設定ディレクトリとプロジェクト設定ディレクトリを実体パスで比較し、まだ存在しないディレクトリは正規化した絶対論理パスで比較します。この解決後にグローバル設定ディレクトリと現在のプロジェクトの `.takt/` が一致する場合、TAKT はどちらの設定ディレクトリも初期化する前にエラー終了します。ホームディレクトリで実行する場合やシンボリックリンク経由で衝突する場合は、`TAKT_CONFIG_DIR` をプロジェクトの `.takt/` とは異なるディレクトリに設定してから再実行してください。`--help` と `--version` はこのチェックの対象外です。

```yaml
# ~/.takt/config.yaml
language: en                  # UI 言語: 'en' または 'ja'
logging:
  level: info                 # ログレベル: debug, info, warn, error
provider: claude-sdk              # デフォルト provider: claude-sdk, claude, claude-headless, claude-terminal, codex, opencode, deepseek-harness, cursor, copilot, kiro, pi, または mock
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
concurrency: 1                # takt run / takt watch の並列タスク数（1-10、デフォルト: 1 = 逐次実行）
task_poll_interval_ms: 500    # takt run / takt watch での新規タスクポーリング間隔（100-5000、デフォルト: 500）
interactive_preview_steps: 3  # インタラクティブモードでの step プレビュー数（0-10、デフォルト: 3）
auto_requeue_max_attempts: 0  # takt run / takt watch 中の失敗 workflow task 自動 requeue 上限（非負整数、デフォルト: 0 = 無効）
ignore_exceed: false          # takt run / takt watch で --ignore-exceed 相当を適用（デフォルト: false）
assistant:
  formal_spec:
    mode: 'y/N'                # Alloy／Quint モード: true, false, Y/n, y/N（デフォルト: y/N）
    comments: true             # 各形式構造への自然言語の意味コメント（デフォルト: true）
    model_check_timeout_seconds: 900  # /verify の quint verify と Alloy モデル検査の上限秒数。1〜86400 の整数（デフォルト: 900）
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
#   claude-sdk:
#     default_permission_mode: edit

# API キー設定（省略可）
# 環境変数 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY で上書き可能。DeepSeek Harness は公式store（$DSH_HOME/.credentials.yaml、既定 ~/.dsh/.credentials.yaml）または DEEPSEEK_API_KEY と任意の DEEPSEEK_BASE_URL を使います（YAML の API キー項目はありません）。
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
#     provider: claude-sdk
#     model: opus
#   selector:              # dynamic parallel・dynamic_facets・companion pool の選択に使う任意の selector 設定
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` は任意です。provider/model の優先順位は、明示的な CLI または環境 override、project selector、global selector、project top-level、global top-level の順です。model は解決済み provider と一致する候補だけを採用します。`provider_options` は selector entry だけを global → project の leaf 単位でマージし、top-level・persona・pool sub-step の options は selector に継承されません。provider option の環境変数 override は、解決済み selector provider の枝だけに適用されます。Codex selector で `config_profile` を使うには、selector 自身の有効 options（selector entry または一致する環境変数 override）に `permission_control: codex` が必要です。top-level `provider_options` は継承されません。空の selector entry と空の `provider_options` entry は設定読み込み時に拒否されます。dynamic parallel と `dynamic_facets` の selector は provider-neutral な fresh-session transport を使い、固定の read-only tool allowlist `Read`・`Glob`・`Grep` と `permission_mode: readonly` を渡します。companion selector には固定の `allowedTools` を渡さないため、selector profile の `allowed_tools` が採用されることがあります。tool allowlist が実効性を持つのは、それを尊重する provider に限られます。dynamic parallel、dynamic facets、または有効な companion pool のいずれも使わない workflow では selector 設定は未使用で、既存実行へ影響しません。

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-headless"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude-sdk"` | デフォルトの具体 AI provider（`claude-sdk` = Agent SDK モード、`claude` = `claude-sdk` のエイリアス、`claude-headless` = ヘッドレス CLI モード、`claude-terminal` = experimental interactive terminal モード、`pi` = Pi SDK モード、`deepseek-harness` = 公式 DeepSeek Harness TypeScript SDK/runtime `0.2.0-rc.2`） |
| `model` | string | - | デフォルトモデル名（provider にそのまま渡される） |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | ブランチ名生成方式 |
| `prevent_sleep` | boolean | `false` | macOS アイドルスリープ防止（caffeinate） |
| `notification_sound` | boolean | `true` | 通知音の有効化 |
| `notification_sound_events` | object | - | イベントごとの通知音切り替え |
| `concurrency` | number (1-10) | `1` | `takt run` / `takt watch` の並列タスク数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新規タスクのポーリング間隔 (`takt run` / `takt watch`) |
| `interactive_preview_steps` | number (0-10) | `3` | インタラクティブモードでの step プレビュー数 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`、comments `true` | Alloy／Quint のガイダンスを追加し、要件を両方の記法でも表現します。object 形式では `mode`、`comments`、`model_check_timeout_seconds` を独立して指定できます。`comments: false` は自然言語の意味コメント指示だけを外し、形式仕様の量・要件網羅・構文と正確性の指示は維持します。`model_check_timeout_seconds` は `/verify` の `quint verify` と Alloy Analyzer に適用する上限秒数（1〜86,400 の整数、デフォルト 900）で、`parse`／`typecheck`／`run` の 60 秒は変わりません。project と global の object はフィールド単位で解決され、project が優先されます。`true` と `false` は質問せず使用します。TTY では `"Y/n"` と `"y/N"` を Yes／No の既定回答として会話セッションごとに1回質問し、非 TTY では標準入力を消費せず既定回答を採用します。Gherkin のガイダンスは開発・実装タスクにだけ適用されます。 |
| `auto_requeue_max_attempts` | 非負整数 | `0` | `takt run` / `takt watch` 中に失敗した workflow task を自動 requeue する上限回数。`0` で無効 |
| `ignore_exceed` | boolean | `false` | `takt run` / `takt watch` の iteration 上限無視を設定します。CLI で `--ignore-exceed` を指定した場合は CLI 指定が優先されます |
| `sync_project_local_takt_on_retry` | boolean | `true` | retry / 再実行前にルートの project-local `.takt` を worktree へ同期。`false` で worktree 側のコピーを維持 |
| `worktree_dir` | string | - | 共有クローンのディレクトリ（デフォルトは `../{clone-name}`） |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `caccia` | object | `{ enabled: false, wait_timeout_ms: 1800000, max_iterations: 3, workflow: "caccia" }` | CodeRabbit レビューループの設定 |
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

## Caccia レビューループ

`caccia` は `~/.takt/config.yaml` と `.takt/config.yaml` のどちらにも設定できます。

```yaml
caccia:
  enabled: false          # タスクが PR を作成・更新した後の自動連結を有効化
  wait_timeout_ms: 1800000 # 初回レビューとPush後の各コミットのレビューを待つ上限（ミリ秒）
  max_iterations: 3       # 修正と再レビューの最大反復回数
  workflow: caccia        # 各スレッド群の判断と修正に使う workflow
```

`enabled: true` の場合だけ連結経路を起動します。単独実行の `takt caccia <PR番号>` はこのフラグに関係なく利用できます。既定値は無効、1,800,000 ミリ秒、3 回、workflow `caccia` です。project に `caccia` ブロックがある場合は global のブロックより優先し、省略した項目には上記の既定値を適用します。`workflow` に workflow 識別子を指定するとビルトイン workflow を差し替えられます。

`wait_timeout_ms` は初回のレビュー確認とPush後の各コミットへの再レビュー待機に適用されます。初回待機が上限に達すると Caccia はスキップされます。単独コマンドは非ゼロで終了し、連結経路ではタスク結果を変えずに終了します。Push後のレビュー待機が上限に達した場合は実行エラーです。単独コマンドは非ゼロで終了し、連結経路ではエラーをログに記録して完了済みタスクの結果を保持します。

## プロジェクト設定

`.takt/config.yaml` でプロジェクト固有の設定を行います。このファイルはプロジェクトディレクトリで初めて TAKT を使用した際に作成されます。

```yaml
# .takt/config.yaml
provider: claude-sdk              # このプロジェクトの provider 上書き
model: sonnet                 # このプロジェクトのモデル上書き
auto_pr: true                 # worktree 実行後に PR を自動作成
concurrency: 2                # このプロジェクトでの takt run / takt watch 並列タスク数（1-10）
auto_requeue_max_attempts: 1  # takt run / takt watch 中の失敗 workflow task 自動 requeue 上限（非負整数）
ignore_exceed: false          # takt run / takt watch で --ignore-exceed 相当を適用
# base_branch: main           # クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ）

# プロジェクト固有の assistant 設定
# assistant:
#   formal_spec:
#     mode: 'Y/n'               # global の Alloy／Quint モードだけを上書き
#     comments: false           # 形式仕様は維持し、意味コメントの強制指示だけを外す
#   init_files:
#     # project config 専用。インタラクティブ assistant モードの初期コンテキストファイル
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# provider 固有オプション（legacy のプロジェクト既定値。runtime モードでは runtime.yaml の profile が所有）
# codex / claude / claude_terminal / cursor / copilot / kiro / pi も
#   guards.call_timeout_ms（未指定時 60 分）を利用できます。
# provider_options:
#   codex:
#     network_access: true
#   opencode:
#     variant: high
#     skills:
#       enabled: false
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
#   pi:
#     extensions: [npm:pi-fff]
#     no_skills: true
#   deepseek_harness:
#     base_url: http://127.0.0.1:8787/v1
#     max_tokens: 4096
#     request_timeout_ms: 3600000
#     shutdown_timeout_ms: 1000
# #   claude_terminal:
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

### Pi provider の session 境界

TAKT の Pi provider は現在の TAKT process 内だけで使う embedded な in-memory Pi SDK session を使用します。Pi の session JSONL ファイルを書き込まず、Pi CLI のグローバル `settings.json` も読み書きしません。そのため、デフォルト model、thinking level、shell、retry option などの Pi グローバル設定は TAKT に自動継承されません。

同じ process と作業ディレクトリ内でキャッシュ済み session を再利用する場合、明示拡張やリソース読み込み設定を変更しても論理 session ID と会話履歴を保持します。SessionManager を履歴の正本とし、先行 turn の終了と旧 runtime の shutdown を待ってから SDK runtime を交換します。model、thinking level、ツール許可は turn ごとに適用します。

shutdown 成功後に交換先の初期化が失敗しても、会話履歴は後続の再構築に引き継ぎます。破棄済み runtime は再利用しません。shutdown 自体が失敗した場合は、交換と同じ論理 session での後続呼び出しを拒否します。

Pi のツール許可は通常実行と入れ子実行の直前に検証します。空または空白だけの allowlist は全ツールを拒否します。登録元の検証失敗時はツールを無効化して実行を中断し、同じ論理 session の拡張構成を変更しても失敗状態を解除しません。標準の TAKT loader は Pi SDK の `codemode` 拡張を既定で読み込み、`readonly`、`edit`、`full` の各 mode で有効化しますが、underlying tool の権限は追加しません。JavaScript から複数の tool を呼び、選んだ結果だけを返せます。

```js
const [matches, files] = await Promise.all([
  tools.grep({ pattern: "createPiResourceLoader", path: "src" }),
  tools.find({ pattern: "*.test.ts", path: "src/__tests__" }),
]);
return matches;
```

各 nested call は同じ permission mode と明示 `allowedTools` list で検証され、拒否された call は tool 実行前に失敗します。明示 allowlist に `codemode` がなければ、codemode は inactive のままです。追加の codemode `models` API は公開せず、MCP と tool search も引き続き opt-in です。この検証は OS sandbox や tool ごとの確認 prompt を提供するものではありません。

Pi のデフォルトとして使う model は TAKT の設定で明示してください。model の選択と thinking level の選択は分けて設定します。legacy `config.yaml` モードでは、明示的な option を推奨します。

```yaml
# ~/.takt/config.yaml または .takt/config.yaml
provider: pi
model: provider/model
provider_options:
  pi:
    thinking_level: high
```

runtime モードでは、Pi profile の `provider.profiles.<name>.options` に `thinking_level` を置きます。workflow YAML には provider、model、provider option を定義できません。

Pi の thinking level は `provider_options.pi.thinking_level` または `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL` だけで設定します。指定できる値は `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` で、不正な値はエラーになります。省略時は Pi SDK の既定値 `medium` が使われます。model reference は `/` だけで分割されるため、model ID 内の `:` はそのまま扱われます。たとえば `provider/model:high` の model ID は `model:high` です。明示した level は、再利用した session を含むすべての Pi turn の前に適用されます。

以前 `model: pi/...:high` を thinking level の指定に使っていた場合は、model reference から `:high` を削除し、代わりに次の option を設定してください。

```yaml
provider_options:
  pi:
    thinking_level: high
```

`provider` と `model` の宣言は TAKT 実行で使う provider と model を選択し、明示的な Pi option が thinking level を選択します。Pi CLI の設定は取り込みません。Pi の認証は Pi SDK credential store または provider-native 環境変数で別途処理されます。この境界により、グローバル設定への意図しない書き込みを防ぎ、プロジェクトローカル設定の信頼性と予測可能性を保ちます。

`provider_options.pi` には、独立した `thinking_level` option と、`extensions` や `no_*` の探索制御など Pi リソースを読み込むための設定が含まれます。認証や model 選択は設定しません。version 指定のない明示 npm source は既存の project scope、user scope を順に再利用し、どちらも正常に読み込めない場合だけ temporary resolution に fallback します。version 指定付き npm source と npm 以外の source は常に temporary resolution されます。明示した source は Pi settings には永続化されません。リソースの信頼境界については [Pi のリソース読み込み](#pi-resource-loading) を参照してください。

### プロバイダ無応答 deadline と OpenCode 実行ガード

全 provider で観測可能な provider event が届かない時間の上限は
`guards.call_timeout_ms` で設定します。stream/tool event、phase 完了、新しい provider
試行の開始ごとにタイマーをリセットし、累積実行時間には上限を設けません。
対象は `codex`、`opencode`、`claude`（`claude-sdk`、別名 `claude`、`claude-headless` で共通）、`claude_terminal`、
`cursor`、`copilot`、`kiro`、`pi` です。値は 60,000〜86,400,000 ms の整数で、
未指定時は 3,600,000 ms（60 分）です。通常の `provider_options` profile 解決を経て
エンジンの親ステップ deadline になり、全 provider に同じ `AbortSignal` が渡されます。
`claude_terminal.timeout_ms` は互換用の旧設定で、`guards.call_timeout_ms` が未指定の
場合だけ使われます。

`provider_options.opencode.guards.profile` の既定値は `standard` です。
`minimal` が無効にするのはヒューリスティックなループ検出だけで、時間・有界資源・
完全性・厳密 correction のガードは mandatory のままです。`model_profiles` は解決済み
モデル文字列を記述順に照合し、`*` だけをワイルドカードとして扱います。guards の
各 leaf は provider option の各レイヤー間で個別にマージされますが、上位優先度の
`model_profiles` は下位の map 全体を置換します。

OpenCode の単一 call には既定で 3,600,000 ms（60分）の provider event 無応答上限が
あります。event が継続して届く健全な call は60分を超えて実行できます。
`event_limit` の既定値は 500,000 で、
`TAKT_OPENCODE_STREAM_EVENT_LIMIT` でも上書きできます。`text_byte_limit` の既定値は 1 MiB、
`reasoning_byte_limit` は 4 MiB です。

この上限は provider から実際に届く event を観測し、TAKT は keepalive を合成しません。
OpenCode では tool の実行開始 event から終端 event までを in-flight として追跡し、その間は
通常の無応答判定を停止します。終端 event が欠落した完全ハングを無界に待たないよう、
in-flight 状態自体は `call_timeout_ms` の6倍で stale と判定し、`PART_TIMEOUT` で終了します。

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-headless"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | 具体 provider の上書き |
| `model` | string | - | モデル名の上書き（provider にそのまま渡される） |
| `submodules` | `"all"` \| string[] | - | プロジェクト専用。共有クローンで初期化する submodule。`"all"` または明示パスリスト（ワイルドカード不可） |
| `with_submodules` | boolean | - | プロジェクト専用。`submodules: "all"` 相当の旧 boolean 設定。`submodules` を推奨 |
| `allow_git_hooks` | boolean | `false` | TAKT 管理の auto-commit 時に git hooks を許可 |
| `allow_git_filters` | boolean | `false` | TAKT 管理の auto-commit 時に git filter を許可 |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `caccia` | object | 無効 | CodeRabbit レビューループ設定（上記参照） |
| `draft_pr` | boolean | `false`（global 設定由来） | 自動作成する PR を draft として作成 |
| `concurrency` | number (1-10) | `1`（global 設定由来） | `takt run` / `takt watch` の並列タスク数 |
| `auto_requeue_max_attempts` | 非負整数 | `0`（global 設定またはデフォルト由来） | `takt run` / `takt watch` 中に失敗した workflow task を自動 requeue する上限回数。`0` で無効 |
| `ignore_exceed` | boolean | `false`（global 設定またはデフォルト由来） | `takt run` / `takt watch` の iteration 上限無視を設定します。CLI で `--ignore-exceed` を指定した場合は CLI 指定が優先されます |
| `base_branch` | string | - | クローン作成のベースブランチ（グローバルを上書き、デフォルト: リモートのデフォルトブランチ） |
| `assistant.init_files` | string[] | - | project config 専用のインタラクティブ assistant 初期コンテキストファイル。パスは project root 相対で指定します。絶対パス、project root 外へ解決されるパス、`.env*` / `.npmrc` / `.pypirc` / `.netrc` / `*.pem` / `*.key` / `.git/**` などの機密ファイルパターンは拒否されます。存在しないパス、ディレクトリ、読めないファイルは分かるエラーになります。最大16ファイルまで指定でき、1ファイルは256KiB、合計本文は1MiBまでです。未設定または空の場合、`CLAUDE.md`、`AGENT.md`、`AGENTS.md`、`TAKT.md` などは自動探索されません。assistant の provider/model だけを制御する `takt_providers.assistant` とは別設定です。 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`、comments `true`（global 設定またはデフォルト由来） | 要件を Alloy／Quint の両方の記法でも表現するガイダンスを追加するプロジェクト上書きです。object 形式では `mode`、`comments`、`model_check_timeout_seconds` を独立して指定でき、未指定フィールドは global またはデフォルトへフォールバックします。`comments: false` は自然言語の意味コメント指示だけを外し、形式仕様の量・要件網羅・構文と正確性の指示は維持します。`"Y/n"`／`"y/N"` への回答はセッション内だけで保持し、会話の再開時には改めて解決します。ACP と非 TTY では質問せず設定の既定回答を採用します。Gherkin のガイダンスは開発・実装タスクにだけ適用されます。廃止済みの `assistant.gherkin` は警告後に無視され、変換・永続化・ファイル更新は行いません。 |
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

プロジェクト設定の値は両方が設定されている場合にグローバル設定を上書きします。

### task 実行設定の環境変数上書き

`auto_requeue_max_attempts` と `ignore_exceed` は
`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` / `TAKT_IGNORE_EXCEED` でも設定できます。
これらの値は env 対応の他の task 実行設定と同じ優先順位で解決されます。

1. 環境変数
2. プロジェクト `.takt/config.yaml`
3. グローバル `~/.takt/config.yaml`
4. デフォルト

`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` は number parse 後に非負整数である必要があります。
数値でない値、負数、整数でない値は config validation に失敗します。
`TAKT_IGNORE_EXCEED` は `true` または `false` のみ受け付け、それ以外の値は config
validation に失敗します。

## 環境変数上書き

ほとんどの設定キーは `TAKT_` に設定キーパスをアンダースコア区切り・大文字化して続けた環境変数で上書きできます。`logging.debug` は `TAKT_LOGGING_DEBUG`、`telemetry.routing_decisions` は `TAKT_TELEMETRY_ROUTING_DECISIONS` になります。よく使う例: `TAKT_PROVIDER`、`TAKT_MODEL`、`TAKT_CONCURRENCY`、`TAKT_LOGGING_DEBUG`、`TAKT_TELEMETRY_ROUTING_DECISIONS`、`TAKT_OBSERVABILITY_ENABLED`。環境変数の値は対応するファイルの値を上書きし、キーを持つ層で適用されます。グローバル専用キー（例: `logging`、`disabled_builtins`）はグローバル `~/.takt/config.yaml` 層で、プロジェクト上書き可能キー（例: `concurrency`、`telemetry.routing_decisions`）はプロジェクト `.takt/config.yaml` 層でも解決されます。

設定キー上書きとは別に、`TAKT_NOTIFY_WEBHOOK` には Slack Incoming Webhook URL を設定できます。設定すると、pipeline 完了時と `takt run` のタスクバッチ完了時（run summary）に Slack へ通知が送信されます。

## API キー設定

TAKT は Claude、Codex、OpenCode、Pi、公式 DeepSeek Harness SDK、Cursor、Copilot、Kiro provider をサポートしています。Claude/Codex/OpenCode は各 SDK の認証情報、Pi は Pi SDK の credential store または provider 環境変数、DeepSeek Harness は公式store（`$DSH_HOME/.credentials.yaml`、既定 `~/.dsh/.credentials.yaml`）または `DEEPSEEK_API_KEY` 環境変数、Kiro は API キーを使い、Cursor は API キーまたは `cursor-agent login` セッションで認証でき、Copilot は GitHub トークンを使います。

グローバル設定 schema には現在トップレベル provider として選択できない一部の legacy または provider integration 用 API key フィールドも残っています。これらのフィールドだけでは provider は有効になりません。選択した provider について、以下に記載した認証用の環境変数または設定キーを使用してください。

### 環境変数（推奨）

```bash
# Claude（Anthropic）用
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）用
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode 用
export TAKT_OPENCODE_API_KEY=...

# Pi 用
# Pi SDK の credential store または provider-native 環境変数を使用

# 公式 DeepSeek Harness TypeScript SDK 用
export DEEPSEEK_API_KEY=...
# 任意: export DEEPSEEK_BASE_URL=https://...

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
| Pi | Pi SDK credential store または provider-native 環境変数 | - |
| DeepSeek Harness | 公式store `$DSH_HOME/.credentials.yaml`（既定 `~/.dsh/.credentials.yaml`）または `DEEPSEEK_API_KEY`（任意で `DEEPSEEK_BASE_URL`） | - |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY`（`KIRO_API_KEY` フォールバック） | `kiro_api_key` |

### セキュリティ

- `config.yaml` に API キーを記載する場合、このファイルを Git にコミットしないよう注意してください。
- 環境変数の使用を検討してください。
- 必要に応じて `~/.takt/config.yaml` をグローバル `.gitignore` に追加してください。
- Cursor provider は `cursor-agent login` が済んでいれば API キーなしでも動作できます。
- 認証情報を設定すれば、対応する CLI ツール（Claude SDK、Codex、Pi）のインストールは不要です。TAKT が対応する API を直接呼び出します。DeepSeek Harness は固定済み TypeScript SDK/runtime を使い、glibc `>= 2.28` の Linux x64/arm64 と macOS arm64 `>= 14.0` に対応します。
- DeepSeek credential は公式 runtime に渡します。TAKT は保存済み credential 値を読みません。
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

provider と model の選択は runtime モードでは `runtime.yaml` が所有し、CLI と環境変数の override も引き続き利用できます。legacy モードでは以下に記載する `config.yaml` の provider、model、routing 設定が引き続きサポートされます。workflow YAML は provider や model を選択できず、`provider`、`model`、inline provider options を書くとロード境界で移行先を示すエラーになります。

workflow の `promotion` entry は `runtime.yaml` で選択された target ladder だけを進めます。provider、model、provider options、condition は指定できません。provider を選ばず tool、network、sandbox、skill の能力だけを要求する workflow の面として `capabilities` を使用します。

### Provider 固有のモデルに関する注意

**Claude Code** はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）と完全なモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。`claude-sdk` と別名 `claude` では、`model` を Agent SDK の model option に渡します。`claude-headless` と `claude-terminal` では CLI の `--model` 引数に渡します。利用可能なモデルについては [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code) を参照してください。

**Codex** は Codex SDK を通じてモデル文字列をそのまま使用します。未指定の場合、デフォルトは `codex` です。利用可能なモデルについては Codex のドキュメントを参照してください。

**OpenCode** に明示するモデルは `provider/model` 形式（例: `opencode/big-pickle`）で指定します。workflow では通常、明示モデルが必要です。ただし、選択された OpenCode provider と所有元が異なる model 指定を解決時に破棄した場合に限り、model 未指定のまま検証を通過し、OpenCode runtime に既定モデルの選択を委ねます。workflow 外の設定では引き続き明示モデルが必要です。

**Pi** は `provider/model` 形式と、設定済みの Pi model に一意に一致する model ID を受け付けます。reference は `/` だけで分割されるため、`provider/model:high` の `model:high` はリテラルの model ID です。thinking level は `provider_options.pi.thinking_level` または `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL` で設定し、省略時は Pi SDK の既定値 `medium` を使います。明示した level はすべての Pi turn に適用されます。model を省略した場合は Pi session の現在の model を維持します。

**Cursor Agent** は `model` を `cursor-agent --model <model>` にそのまま渡します。省略時は Cursor CLI のデフォルトが使用されます。

**GitHub Copilot CLI** は `model` を `copilot --model <model>` にそのまま渡します。省略時は Copilot CLI のデフォルトが使用されます。

**Kiro CLI** は `model` を `kiro-cli chat --model <model>` にそのまま渡します。省略時は Kiro CLI のデフォルトが使用されます。

### 設定例

```yaml
# ~/.takt/config.yaml
provider: claude-sdk
model: opus     # すべての step のデフォルトモデル（上書きされない限り）
```

### OpenCode v1/v2 の選択

OpenCode provider は外部 `opencode` CLI の `serve` を起動し、SDK で専用サーバーへ接続します。API キーだけでは実行できません。既定は v2 で、`@opencode/client` と `@opencode/plugin` 2.0.18 を使います。明示的に v1 を選ぶ場合は `@opencode-ai/sdk` 1.18.28 を使います。検証済み CLI は v1 1.18.2 と v2 2.0.18 です。最低対応版を保証する記載ではありません。選択した世代と CLI の major version が一致しない場合はサーバー起動前にエラーにします。v1 CLI だけを導入している環境では v1 の明示選択が必要です。OpenCode v2 は同名の `opencode` を置き換えるため、自動判定や自動更新は行いません。

```sh
# 既存 CLI を更新せず v2 を隔離して導入
npm install --prefix /path/to/opencode-v2 @opencode/cli@2.0.18
TAKT_OPENCODE_PATH=/path/to/opencode-v2/node_modules/.bin/opencode takt run
# v1 に戻す場合も、対応するバイナリを明示
TAKT_OPENCODE_VERSION=v1 TAKT_OPENCODE_PATH=/path/to/opencode-v1 takt run
```

この 2 変数は TAKT プロセス全体の実行環境を選びます。step ごとの `provider_options` ではありません。CI やランチャーにも同じ値を保存してください。未指定の path は `PATH` の `opencode` です。session ID は世代をまたいで移行しません。切替後は新しい実行を開始してください。

v2 ではフェーズごとに session の system 指示と権限を更新し、同梱 plugin が tool allowlist を適用します。plugin が有効でなければプロンプトを送信しません。`bash` は `shell`、`task` は `subagent`、`apply_patch` は `patch` へ変換します。v2 は `read` でディレクトリを列挙するため v1 の `list` shim は使いません。MCP は従来の設定を v2 形式へ変換し、許可した tool を直接公開します。構造化出力は schema をプロンプトへ含める既存の formatless 経路で抽出・検証します。v2 の native JSON Schema API による生成保証ではありません。

開発時は build 後に `npm run test:opencode-v2-probe -- --cli /absolute/path/to/opencode-v2` で、隔離された実 CLI と mock LLM/MCP による受入検証を実行できます。認証情報やユーザーの OpenCode 設定は使用しません。通常の v1 回帰 probe は `npm run test:opencode-probe` です。

#### OpenCode の Skill

v2 では環境由来の Skill を既定で無効にします。legacy の global/project 設定、routing の設定、workflow/step の capability ファイルで boolean の `provider_options.opencode.skills.enabled: true` を指定すると、Phase 1 で標準の Skill 探索と permission を使えます。`Read` の許可だけでは有効になりません。native の `allow`・`deny`・`ask` を強制的に `allow` に変更せず、OpenCode の設定や Skill ファイルも変更しません。

```yaml
# legacy の ~/.takt/config.yaml または .takt/config.yaml
provider_options:
  opencode:
    skills:
      enabled: true
```

legacy の `provider_routing` でも persona・tag・step ごとに指定できます。次の3種類は選択肢なので、必要なものを残してください。

```yaml
provider_routing:
  personas:
    coder: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
  tags:
    coding: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
  steps:
    implement: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
```

runtime モードでは OpenCode profile の `options` に `skills.enabled` を指定し、対象の persona・tag・step にその profile を割り当てます。次の targets は選択肢なので、必要なものを残してください。

```yaml
version: 1
provider:
  profiles:
    default: { provider: opencode, model: opencode/big-pickle, options: { skills: { enabled: false } } }
    coder: { provider: opencode, model: opencode/big-pickle, options: { skills: { enabled: true } } }
  defaults: { profile: default }
  targets:
    personas:
      coder: { profile: coder }
    tags:
      coding: { profile: coder }
    steps:
      development-implement/implement: { profile: coder }
```

`TAKT_PROVIDER_OPTIONS_OPENCODE_SKILLS_ENABLED=true` と root の `TAKT_PROVIDER_OPTIONS` JSON も既存の環境変数優先順位に従います。別 provider の Skill 設定は OpenCode を有効にしません。Phase 2 のレポート、Phase 3 のステータス判定、strict-readonly の内部呼び出しでは Skill tool を無効にします。Phase 1 の再開時には元の設定を復元します。Skill 設定が異なる呼び出しは別サーバーを使い、retry・resume・compaction では設定を保持します。v1 はこの設定を無視し、従来の動作を維持します。

CLI 2.0.18 の既知の制約として、Phase 1 を `skills.enabled: true` で実行した同じセッションを Phase 2 のレポート、Phase 3 のステータス判定、strict-readonly の内部呼び出し、または false への切替後の呼び出しで再利用すると、Skill tool は無効でも OpenCode が保存済みの `<available_skills>` テキストはモデル入力に残ることがあります。初回の system message に結合された一覧に加え、無効で開始してから有効に切り替えたときに履歴へ追加された一覧も含みます。TAKT はこの保存済みテキストを除去・書き換えしません。Skill tool が無効なので Skill は実行できません。

Phase 2 の新規セッション retry、strict-readonly の新規呼び出し、Skill を有効にした Phase 1 を一度も実行していないセッションでは、Skill が無効なときに tool と環境由来の一覧がどちらもモデル入力に含まれません。実 CLI probe はこれらのセッションで両方の不在を確認します。有効化済みの同じセッションでは tool の無効化と設定値・セッション ID の維持を確認し、保存済み一覧の不在は求めません。`--capture /path/to/capture.json` でモデル送信本文と context hook 入力を保存できます。

組み込みの development・simple workflow は `enable-skills` を暗黙に付与しなくなりました。プリセットは引き続き同梱し、`takt exec` の既定 capability 付与と Codex の動作を維持します。このプリセットは OpenCode の Skill を有効にしません。

v2 probe は system 指示、同一 session のフェーズ間 read/write 権限切替、禁止された write の拒否、schema 出力、質問、停止と再開、compact、サーバー再起動後の再開、並列 session の分離、stdio MCP tool の実行を検証します。macOS・Node.js 26・CLI 2.0.18 で実行契約を確認しています。実サービスのモデル応答と remote MCP OAuth は未検証で、OAuth 設定変換は unit test で確認しています。MCP discovery は許可した tool ID の登録を最大 30 秒待ちます。tool 制限がない場合は各 assigned server に少なくとも 1 tool の登録が必要です。resource だけを公開する server はこの経路で使える tool を持ちません。v2 は v1 の `todowrite` tool を公開しません。


## Runtime Provider 設定（runtime.yaml）

`runtime.yaml` は provider/model/options を workflow の外へ切り出し、同じ workflow を編集せずに異なる実行環境で再利用できるようにします。次の 2 つの固定パスから読み込み、project 側の設定を global より優先します。

1. `~/.takt/runtime.yaml`
2. `<project>/.takt/runtime.yaml`

companion reviewer は既定で無効です。有効化する場合はトップレベルの
`companion.enabled` を設定します。

```yaml
version: 1
companion:
  enabled: true
  review_mode: completion # completion | live
  fix_policy: single      # single | loop
```

`companion` ポリシーには `enabled`、`review_mode`、`fix_policy` の少なくとも一方を
指定します。`companion: { review_mode: live }` や
`companion: { fix_policy: loop }` のような mode または fix policy 単独指定は受理され、
`enabled: false` として解決されます。空の `companion: {}` は拒否されます。

global と project の両方にポリシーがある場合、`enabled` の値は論理積で合成されるため、
global 側で無効化した companion を project 側の `true` で再有効化することはできません。
レイヤー合成時に未指定のポリシーは中立として扱い、両方とも未指定なら companion は
無効のままです。

`companion.review_mode` の既定値は `completion` です。project に指定した値は global
を上書きし、project で省略した場合は global の値を継承します。`completion` は実装
エージェントの成功応答後に累積差分をレビューし、`live` は応答中の quiet、forced、
commit 発火を維持します。指定できる値は `completion` と `live` だけで、無効な値は
`runtime.yaml` の読み込み時にエラーになります。`companion.enabled` が `false` でも
mode と fix policy の構造は検証されますが、Companion provider の解決と実行は行われません。

`companion.fix_policy` の既定値は `single` です。project に指定した値は global を
上書きし、project で省略した場合は global の値を継承します。`single` は初回レビュー後に
advisory な修正 follow-up を最大 1 回だけ実行し、その follow-up の再レビューは行いません。
`loop` は従来のレビューと修正の反復動作を維持します。指定できる値は `single` と `loop`
だけで、無効な値は `runtime.yaml` の読み込み時にエラーになります。

companion の provider target（`targets.companions`）とプロバイダ能力要件が適用されるのは
companion が有効な間だけです。無効時も companion 宣言と `targets.companions` の構造検証は
維持されますが、companion の provider 解決と実行は行われません — companion を宣言した
ワークフローは companion 用の provider 設定なしで実行できます。

### run 完了後のループ分析

ループ分析は opt-in 機能です。run の終端成果物が確定した後に分析するにはトップレベルの
`loop_analysis` を追加します。

```yaml
version: 1
loop_analysis:
  enabled: true
  output: file # file | pr-comment。既定値は file
```

有効時は成功・失敗・中断したすべての元 run から builtin の `loop-analysis` workflow を
非同期で起動します。元 run は分析の完了を待たず、分析の起動・実行失敗も元 run の結果を
変更しません。手動で force-fail した run も終端成果物の確定直後に分析対象になります。
分析 run から別の分析 run は起動しません。同一 run の解析ジョブは1回だけ作成されます。

終端成果物の確定直後にプロセスが OS の強制終了（`SIGKILL`）を受け、解析ジョブの永続化まで
到達しなかった場合、そのプロセス自身から解析を起動することはできません。dispatch claim は意図的に
at-most-once であるため、claim がプロセス終了直前に永続化されていた場合、task 一覧から run を
force-fail しても、この状態を自動復旧できる保証はありません。

分析 agent は元 run に存在する JSONL ログ、trace、monitor data、report、保存済みのワークフロー定義と、
各 step が参照した facets を読みます。複数 step で共有する不変条件はワークフロー全体の rule、step 固有の
問題は対応する facet の変更として提案します。reviewer は、根拠不足、過剰な個別最適化、対象となる
ワークフロー動作の誤りがある場合、明示的な再分析を最大2回まで要求できます。再分析では各指摘を
対応済みまたは根拠付きの対応不能に分類し、対応不能な案を撤回した上で再び reviewer が判定します。
最終 report は常に分析 run の `reports/loop-analysis.md` へ保存されます。

サニタイズと公開の前に、worker は完全版 report を global config dir（`TAKT_CONFIG_DIR` を設定した場合はその値）の
`loop-analysis/<source-run-slug>-<hash>/loop-analysis.md` へ保存します。`<hash>` は source run directory のパスを
SHA-256 でハッシュ化した先頭8桁の16進数です。同じ場所に private な `source.json` も作成し、
version 1、`sourceRunDirectory`、`projectCwd`、任意の `branch`、`analysisReportPath`、`archivedAt`（ISO 文字列）を
記録します。`pullRequest.number` と `pullRequest.url` は PR コメントの投稿に成功した場合だけ記録されます。
この archive は `output: file` と `output: pr-comment` の両方で保存され、同じ source run directory を再解析した場合は
上書きされます。分析 run の report と、存在する場合の PR コメントの末尾には
`source run: <source-run-slug>` の行を1行だけ付けます。この行には slug だけを記載します。
archive の保存後、worker は分析 run の report をサニタイズして公開用の内容で上書きします。
そのため archive には完全版が残り、ファイルと PR コメントはサニタイズ後の同一内容になります。

`output: pr-comment` の場合、元 run で auto-PR が有効で、その branch の PR が既に存在するときだけ、
保存済み report と同一内容をコメントします。PR が存在しない場合はコメントを投稿せず、分析 report と private archive を残します。
`loop_analysis` 内に provider、model、provider options は指定できません。通常の runtime provider
target で分析 step を割り当ててください。global と project の両方が `loop_analysis` を定義した場合、
project のセクションが global のセクション全体を置き換えます。

公開前に、TAKTは認識できたsecret、credential、token、個人識別情報、絶対ローカルパス、runnerを
特定できるmetadataを除去します。除去によって内容が変わる場合は保存済みreportも安全化後の内容で
置き換え、ファイルとPRコメントを同一に保ちます。

runtime モードはファイルの存在ではなく、有効な `provider` セクションの有無で有効化されます。`version: 1` だけのファイルは inactive で、従来の `config.yaml` による provider 解決がそのまま使われます。

### 設定例

```yaml
version: 1

provider:
  defaults:
    profile: sol-medium

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
    router:
      provider: codex
      model: gpt-5.6-luna
      capabilities: readonly
      permission_mode: readonly
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
      default/implement:
        pool: sol-pool
    internal_agents:
      selector:
        profile: router
      review-completion-judge:
        profile: router

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

### 名前付き assignment

`provider.assignments` には起動ディレクトリや `--runtime-assignment <name>` で選択する名前付きの provider 設定セットを定義できます。
各 entry は `defaults` または `targets` の少なくとも一方を持つ必要があり、空の assignment は指定できません。
`defaults` はトップレベルの `provider.defaults` と同じく `profile` または `ladder` の一方を指定します。
`targets` はトップレベルの `provider.targets` と同じ形で、`personas`、`tags`、`steps` は
`profile`、`pool`、`ladder` のいずれか、`internal_agents` は `profile` または `ladder`、
`companions` は固定 `profile` を指定できます。

`provider.directories` はディレクトリパスから assignment 名への map です。照合対象は起動時の project
ディレクトリで、キーは `~` を展開して絶対パス化した後、存在するパスについて realpath 相当に正規化して
完全一致で照合します。前方一致や glob は使いません。値の assignment 名が未定義の場合は読み込み時に
fail-fast します。ディレクトリが一致すると、assignment の `defaults`（省略時はトップレベルの
`provider.defaults`）を使用し、assignment に `targets` がある場合はトップレベルの `provider.targets` 全体を
置き換えます。`personas` だけを残すような map 単位のマージは行いません。`targets` を省略した assignment
はトップレベルの `provider.targets` をそのまま引き継ぎます。`profiles` と `auto_routing` は共有されたままです。

```yaml
provider:
  assignments:
    project-sol:
      defaults:
        profile: sol-medium
      targets:
        personas:
          coder:
            profile: sol-medium
        steps:
          default/implement:
            pool: sol-pool

  directories:
    ~/work/example: project-sol
```

global と project のレイヤーで `assignments` が定義されている場合、同名 entry は project が全体を置き換え、
異なる名前は両方残ります。`directories` は正規化後の同じパスキーについて project が優先し、異なるパスは
両方残ります。これらのマージは assignment の選択前に行われます。assignment 内の profile、pool、ladder
参照も通常の runtime provider 参照と同じく、未定義なら agent 実行前に fail-fast します。

#### 起動時にプリセットを選ぶ

`--runtime-assignment <name>` は global と project の runtime.yaml を合成した後の
`provider.assignments` から名前を選びます。`provider.directories` の一致より CLI 指定が優先します。
assignment は合成直後のトップレベルへ1回だけ適用します。`defaults` と `targets` は省略すると
トップレベルの値を継承し、`targets` を指定すると map 全体を置き換えます。
`profiles`、`auto_routing`、`mcp`、`companion`、`loop_analysis` は共通のままです。
既存の `--provider`、`--model`、`--auto-strategy` override は選択後の設定より優先します。

共有する `.takt/runtime.yaml` に profile とコスト重視・品質重視のプリセットを定義します。

```yaml
version: 1
provider:
  profiles:
    sol-high: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: high } }
    sol-medium: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: medium } }
    sol-low: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: low } }
  defaults: { profile: sol-medium }
  targets:
    personas:
      reviewer: { profile: sol-high }
  assignments:
    cost:
      defaults: { profile: sol-low }
      targets:
        personas:
          reviewer: { profile: sol-medium }
    quality:
      defaults: { profile: sol-high }
```

```sh
takt --runtime-assignment cost "#123"
takt run --runtime-assignment quality
takt --pipeline --runtime-assignment cost "#123"
```

この例の `cost` は既定で low、reviewer に medium の推論設定を使います。
`quality` は既定で high を使い、トップレベルの reviewer target を継承します。

このオプションはインタラクティブ起動、直接実行、pipeline、`run`、`watch`、その他のサブコマンドで使えます。
同じ `run` の全タスク、同じ `watch` に後から追加したタスク、内部エージェント、loop-analysis に同じ選択が効きます。
選択処理は設定ファイルを書き換えず、タスクレコードにも記録しません。requeue、retry、instruct は過去の起動指定を
復元しません。通常のタスク実行による状態更新は従来どおり行います。未指定時は従来の directories 一致と
トップレベルによる解決を維持します。

未定義名、assignments 未定義、有効な runtime provider section がない場合は、どの agent も起動する前に停止します。
エラーには指定名と定義済みの名前一覧、または定義がない旨を表示します。directories や legacy 設定へ戻りません。

個人の `~/.takt/runtime.yaml` に別名の assignment を追加し、共有プリセットと並べて選べます。

```yaml
version: 1
provider:
  profiles:
    personal-model: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: medium } }
  defaults: { profile: personal-model }
  assignments:
    personal:
      defaults: { profile: personal-model }
```

```sh
takt run --runtime-assignment personal
```

両層の異なる名前の profile と assignment は合成後も残り、同名の場合は project の entry が全体を置き換えます。

`provider.profiles` は名前付きの provider/model/options 定義を保持します。profile のフラットな `options` はその profile の provider に適用されます（例えば `reasoning_effort` は Codex の `reasoning_effort` オプションになります）。任意の `capabilities` には provider-options preset 名、または適用順の preset 名リストを指定します。workflow の `capabilities` と同じ project → global → builtin の順で解決し、inline の `options` が preset より優先されます。任意の `permission_mode` は provider の正確な permission mode を設定します。profile は明示的な `extends` で別の profile を継承できます。global と project で同名の profile を field 単位で暗黙に混ぜることはなく、project の定義が profile 全体を置き換えます。

TAKT が所有する structured agent は常に fresh session で起動します。native structured output 対応 provider には schema を直接渡し、非対応 provider には JSON schema instruction を渡して返却 object を parse・validate します。TAKT は internal agent 専用の permission、tool、network、sandbox、skill、MCP、bypass policy を追加しません。role を制限する場合は `capabilities` と `permission_mode` の一方または両方を明示した profile を割り当てます。両方を省略した場合は通常の provider 設定をそのまま使用します。

有効な provider section では `provider.defaults` の指定が必須で、固定の `profile` または順序付きの `ladder` のいずれか一方だけを指定します。`pool` は指定できません。`provider.targets.personas`、`provider.targets.tags`、`provider.targets.steps` のエントリは、固定の `profile`、順序付きの `ladder`、または auto routing 用の `pool` のいずれか一方を指定できます。`pool` はこれらの明示的な workflow target に限り指定できます。`internal_agents` のエントリは固定の `profile` または順序付きの `ladder` を指定できますが、`pool` は指定できません。`companions` のエントリは固定の `profile` のみ指定でき、`pool` と `ladder` は指定できません。step は `<leaf-workflow-name>/<step-name>` 形式で指定し、agent を起動しない制御ノード（`workflow_call` など）は解決対象になりません。

`provider.auto_routing` が存在しても、`pool` を明示した target だけが自動ルーティング対象になります。pool を明示していない target、AI による task slug 生成などの非ワークフロー処理、その他の補助処理は `provider.defaults` を使用します。暗黙の既定 pool はなく、`fallback_profile` は明示的に選択された pool の中だけで使用されます。

### 解決の優先順位

workflow agent の provider は次のラダーで解決し、後のエントリが前のエントリを上書きします。

```text
defaults
  < personas
  < tags
  < steps
```

内部 agent（`selector`、`assistant`、`loop-judge`、`review-completion-judge`）は別のラダーで解決します。`selector` は動的な作業選択、`assistant` は対話セッション、`loop-judge` は loop monitor の判定、`review-completion-judge` は opt-in した reviewer に再確認が必要かの判定を担当します。seat はすべて任意で、未指定なら通常の既定解決を使います。

```text
defaults
  < internal_agents.<agent>
```

同じ優先度の target（例えば複数の一致する tag）が異なる provider を割り当てた場合は暗黙に一方を選ばず fail-fast します。コマンドラインの `--provider` / `--model` は実行時 override であり、legacy と runtime のどちらのモードでも許可されます。

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
| `auto_routing` | `provider.auto_routing` |
| auto routing candidates | `provider.profiles` を参照する pool candidates |
| workflow 内の provider 指定 | `provider.targets.steps` |

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

初回起動時、TAKT は `~/.takt/runtime.yaml` を atomic に生成し、既存ファイルは上書きしません。project 側の `.takt/runtime.yaml` は自動生成されません。新規環境では選択された provider/model を `provider.profiles.default` と `provider.defaults.profile: default` として書き込みます。legacy provider 設定が既に存在する環境には inactive な `version: 1` ファイルだけを生成し、移行するまで動作は変わりません。

## `runtime.yaml` の Runtime MCP 設定

`runtime.yaml` の `mcp` セクションは MCP server の定義と agent への割り当てを管理します。`provider` と並ぶトップレベルの兄弟であり（order.md:36）、`provider` セクションなしでも単独で有効化できます。その場合も provider/model 解析は legacy `config.yaml` 経路のまま MCP server を注入できます。

### 設定例

```yaml
version: 1

mcp:
  servers:
    common-tools:
      type: stdio
      command: common-mcp-server
      args: []
      env:
        API_TOKEN: "${COMMON_MCP_API_TOKEN}"
    github:
      type: http
      url: https://api.githubcopilot.com/mcp/
      headers:
        Authorization: "Bearer ${GITHUB_TOKEN}"

  defaults:
    servers:
      - common-tools

  targets:
    personas:
      release-manager:
        servers:
          - github
    tags:
      github:
        servers:
          - github
    steps:
      release/create-pr:
        servers:
          - github
    internal_agents:
      selector:
        exclude:
          - common-tools
```

### スキーマ

| フィールド | 型 | 説明 |
|---|---|---|
| `mcp.servers` | `{ <名前>: ServerEntry }` | 名前付き MCP server 定義（`stdio` / `sse` / `http`）。ここで定義しただけでは有効化せず、`defaults` または `targets` で割り当てる必要があります。 |
| `mcp.defaults.servers` | `string[]` | すべての agent 実行（通常 step、parallel agent、fan-in、内部 agent、サブワークフロー内の leaf step）へ適用される server。 |
| `mcp.targets.personas` | `{ <persona>: { servers?, exclude? } }` | persona 単位の追加/除外。 |
| `mcp.targets.tags` | `{ <tag>: { servers?, exclude? } }` | tag 単位の追加/除外。 |
| `mcp.targets.steps` | `{ <leaf-workflow>/<step>: { servers?, exclude? } }` | step 単位の追加/除外。制御ノード（`workflow_call` など）は解決対象外です。 |
| `mcp.targets.internal_agents` | `{ selector: { exclude? } }` | 両内部 agent（`selector` と `assistant`）へ適用する除外。`selector.exclude` のみ受け付けます。 |

server エントリ:

| transport | 必須フィールド | 任意フィールド |
|---|---|---|
| `stdio` | `command` | `args`, `env` |
| `sse` | `url` | `headers` |
| `http` | `url` | `headers` |

### 実効 server 解決

```text
effective servers
  = defaults.servers
  + matched targets.servers
  - matched targets.exclude
```

- server 名は重複を除去します。
- `exclude` は追加より優先します。
- `targets` に未知の server 名が含まれる場合、agent 実行前に fail-fast します。
- `mcp.servers` に定義しただけでは有効化せず、`defaults` または `targets` で割り当てる必要があります。

### global/project のマージ

global と project 両方の `runtime.yaml` が `mcp` セクションを持つ場合、project 側のセクションが global 側を全体置換します。同名 server を field 単位で暗黙に混ぜることはなく、`defaults`/`targets` は project 側の値が優先します。これは `provider` セクションのマージ規則と同じです。

### 環境変数補間

`command`、`args`、`env`、`url`、`headers` 内の `${NAME}` 参照は agent 起動前に `process.env` で解決します。未定義の必須環境変数は fail-fast し、空文字列で黙に置換しません。解決済みの秘密値（env, headers）はログやエラーメッセージへ出力しません。

### provider 別 transport 対応

各 provider は対応する transport を宣言します。解決した server が未対応 transport を使う場合、TAKT は agent 起動前に fail-fast し、provider 名、server 名、transport、対応 transport、runtime.yaml のソースパスを報告します。

| Provider | 対応 transport |
|---|---|
| `claude-sdk` / `claude` / `claude-headless` / `claude-terminal` | `stdio`, `sse`, `http` |
| `codex` | `stdio`, `http` |
| `opencode` | `stdio`, `http` |
| `cursor` | `stdio`, `http` |
| `copilot` | `stdio`, `http` |
| `kiro` | `stdio`, `http` |
| `mock` | `stdio` |

互換性のない transport を別 transport へ推測変換すること、server を黙に除外することはありません。

### legacy workflow MCP モードと移行

MCP 設定も legacy と runtime の混在を許しません。

- `runtime.yaml` に有効な `mcp` セクションがない場合: workflow の `mcp_servers` と `workflow_mcp_servers` ポリシーを使用します。
- `runtime.yaml` に有効な `mcp` セクションがある場合: runtime MCP assignment だけを使用します。
- runtime MCP と workflow `mcp_servers` が同時に存在する場合: 該当 workflow/step と移行先を示して fail-fast します。

runtime MCP モードでは、workflow から MCP server の command、URL、header、env を指定できません。これらは `runtime.yaml` の `mcp` セクションが所有します。

| 既存設定 | 移行先 |
|---|---|
| workflow の `mcp_servers` ポリシー | `mcp.targets` |
| step の `mcp_servers` マップ | `mcp.targets.steps` |

## Provider プロファイル

Provider プロファイルを使用すると、各 provider にデフォルトのパーミッションモードと step ごとのパーミッション上書きを設定できます。異なる provider を異なるセキュリティポリシーで運用する場合に便利です。

### パーミッションモード

TAKT は provider 非依存の3つのパーミッションモードを使用します。

| モード | 説明 | Claude | Codex | OpenCode | Pi | DeepSeek Harness | Cursor Agent | Copilot | Kiro CLI |
|--------|------|--------|-------|----------|----|-----------------|--------------|---------|----------|
| `readonly` | 読み取り専用、ファイル変更不可 | `default` | `read-only` | `read-only` | `read`, `grep`, `find`, `ls`, `codemode` | この SDK では公開されません | デフォルトフラグ（`--force` なし） | フラグなし | `--trust-tools=read,grep` |
| `edit` | 確認付きでファイル編集を許可 | `acceptEdits` | `workspace-write` | `workspace-write` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `codemode` | この SDK では公開されません | デフォルトフラグ（`--force` なし） | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | すべてのパーミッションチェックをバイパス | `bypassPermissions` | `danger-full-access` | `danger-full-access` | 登録済み Pi tool すべて | この SDK では公開されません | `--force` | `--yolo` | `--trust-all-tools` |

Pi の permission mode は SDK の active-tool allowlist であり、OS sandbox ではありません。また、TAKT は Pi に tool ごとの確認 prompt を追加しません。特に Pi の `edit` は `bash` を有効化し、file tool は絶対 path も受け取れます。信頼できる workflow input と extension だけで実行してください。internal agent の role に狭い権限が必要なら、Pi の profile に capabilities と permission mode を明示してください。

### 設定方法

Provider プロファイルはグローバルレベルとプロジェクトレベルの両方で設定できます。

```yaml
# ~/.takt/config.yaml（グローバル）または .takt/config.yaml（プロジェクト）
provider_profiles:
  codex:
    default_permission_mode: full
    step_permission_overrides:
      ai_review: readonly
  claude-sdk:
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

権限プロファイルのキーは選択されたprovider名と一致する必要があり、キー同士はエイリアスとして扱いません。新しい既定値または明示した `claude-sdk` を使う場合は、旧 `provider_profiles.claude` の設定を `provider_profiles.claude-sdk` に移してください。明示した `claude` は `claude` キー、`claude-headless` は `claude-headless` キーを使います。provider未指定で旧 `claude` プロファイルに `readonly` を設定していた場合、移行しないと設定が適用されず、SDKの組み込み既定値 `edit` に戻る可能性があります。

### Legacy `config.yaml` Provider Routing

runtime モードが無効な場合、`provider_routing` を使うと workflow を複製せずに step を別の provider、model、provider 固有オプションへルーティングできます。`~/.takt/config.yaml` と `.takt/config.yaml` のどちらでも定義できます。runtime モードでは [Runtime Provider 設定](#runtime-provider-設定runtimeyaml) の `provider.targets` を使用し、legacy routing との混在は拒否されます。

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

`provider_routing.personas` は workflow step の raw `persona` キーを使います。`persona_name` は表示専用で、routing には影響しません。`provider_routing.tags` は step の `tags` に一致する entry を適用します。複数 tag が一致した場合は step に書かれた順に適用され、後ろの tag が同じ provider / model / provider_options leaf を上書きします。`provider_routing.steps` は workflow step の `name` を使います。有効な runtime 設定ではこれらの legacy 設定は混在エラーになり、`provider.targets` へ移行します。

各 routing entry では `provider`、`model`、`provider_options` を指定できます。これらは個別に省略できますが、各 entry には少なくとも 1 つ必要です。空の `provider_options` オブジェクトは受理されません。

legacy モードの workflow step では provider / model の優先順位は次のとおりです。

```text
CLI / 環境変数の明示 override
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> effective auto_routing（auto.rules / auto.dynamic / auto.fallback）
> project .takt/config.yaml
> global ~/.takt/config.yaml
> provider default
```

provider は上記の優先順位で選択されます。model は model が指定された最初のレイヤーで決まります。同じ指定に provider もある場合、その provider が選択済み provider と一致するときだけ model を使います。不一致なら model は未指定となり、下位レイヤーの model は探しません。provider を伴わない model 指定はそのまま渡します。

workflow YAML には provider/model のレイヤーがありません。`internal_agents` seat は合成された engine step を runtime 側で解決し、workflow の promotion は runtime target ladder だけを進めます。

### Auto Routing

legacy モードで TAKT に provider と model の両方を candidate list から選ばせる場合は project `.takt/config.yaml` または global `~/.takt/config.yaml` に `auto_routing` を定義します。runtime モードでは `runtime.yaml` の `provider.auto_routing` と profile target を使用し、workflow YAML から auto routing を有効化・上書きすることはできません。workflow step 外の処理には legacy config の具体 provider/model、または runtime の default を使用します。

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

legacy モードでは top-level の具体的な `provider` と `model` が default です。各 `auto_routing.candidates` は `provider` と `model` を直接保持します。candidate 選択が適用されるのは workflow の step 実行だけで、AI による task slug 生成や sync conflict resolver など workflow step context を持たない内部処理は top-level の具体値を使用します。legacy の `auto_routing.router` と candidates は default として暗黙に使用されません。

assistant 会話（インタラクティブモードの計画会話、既存タスクへの追加指示 (instruct)、リトライ対話）は auto routing を通りません。設定済みなら `takt_providers.assistant`、未設定なら top-level provider/model を解決し、この assistant 設定はその他の内部処理の default にはなりません。CLI の `--provider` / `--model` override が適用されるのはインタラクティブモードの計画会話だけで、instruct / retry には適用されません。解決可能な assistant または top-level provider がない場合、assistant は起動時に `Provider is not configured.` で失敗します。

runtime モードでは `provider.defaults` が runtime default の profile または ladder を選択します。auto routing は persona、tag、step の target が pool を明示的に選択した場合だけ適用されます。pool の candidate は `provider.profiles` を参照し、provider/model を直接保持しません。auto routing の hard rule は pool 選択時に `tags`、`steps`、`personas` の順に評価します。これとは別に、最終的な provider target の上書き優先順位は `defaults < personas < tags < steps` です。それ以外は `pool_rules` が candidate pool を選び、router は必要な tier だけを推定して TAKT が candidate を決定的に選びます。

candidate の `routing_tier` は `high`、`medium`、`low` のいずれかです。runtime profile が provider/model/options を保持するため、candidate はこれらを重複記述せず profile を参照します。CLI は `--auto-strategy cost|balanced|performance` で strategy を上書きでき、runtime の auto-routing target に到達するまで伝播します。

Routing decision は local-only telemetry で、デフォルトでは記録されません。`telemetry.routing_decisions` を有効化した場合（`takt telemetry enable` または `routing_decisions: true`）、TAKT は project `.takt/events/` ディレクトリ配下に NDJSON として書き込みます。TAKT は routing decision をアップロードしません。この local recording 設定の確認・変更には `takt telemetry status`、`takt telemetry enable`、`takt telemetry disable` を使います。

provider options は runtime profile、capability preset、既存の config/env override 経路から解決されます。workflow YAML には inline provider options のレイヤーがないため、runtime 設定を上書きする step/workflow option 優先順位は存在しません。preview、doctor、validation、summary、report などの補助入口も workflow 実行と同じ runtime 解決契約を使います。

`provider_options` の優先順位は leaf ごとに解決されます。多くの leaf では env または CLI 起源の config leaf が他のすべてのソースより優先されます。例外は `base_url` です。workflow が特定の provider だけを明示的に proxy へ向けられるよう、`base_url` は step / workflow routing の設定を TAKT env override より優先します。`base_url` の順序は step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated の `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml` > TAKT env override です。preview、doctor、validation、summary、report などの補助入口も、workflow 実行と同じ `base_url` 優先順位を使います。他の leaf は env / CLI config override の後に同じ step-to-global 順序で解決されます。

安全のため、workflow YAML と project `.takt/config.yaml` で指定できる `base_url` は `127.0.0.1`、`127.x.x.x`、`localhost`、`*.localhost`、`::1` などの loopback host に限られます。非 loopback の provider base URL はユーザー管理の global config または `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` / `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL` / `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL` に設定してください。

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

capability の参照は共有 YAML provider-options preset を名前で読み込めます。名前は `.takt/provider-options`、`~/.takt/provider-options`、`builtins/{lang}/provider-options` の順に first-match で解決されます。repertoire package からインストールされた workflow ではそれらより先に package-local の `provider-options/` が参照されます。`@owner/repo/name` 形式の scoped ref は別の repertoire package の `provider-options/` から `name` を解決します。workflow YAML で参照できるのは capability preset だけで、provider/model/options の定義は runtime profile（または既存の legacy config layer）に置きます。

capability preset の解決は、preset または path を解決できない場合、scoped ref が利用可能な repertoire package を指していない場合、参照先 YAML が不正または provider-options object でない場合、extends チェーンが循環している場合、削除済みの `$ref` キーが使われた場合に、設定エラーとして fail fast します。相対 path は workflow file 基準で解決され、symlink 解決後も workflow directory 内に留まる必要があります。絶対 path と、実体が workflow directory 外へ出る path は拒否されます。

provider option の leaf は環境変数でも上書きできます。OpenCode の model variant は `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` で `provider_options.opencode.variant` を設定できます。provider base URL は `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` または `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787` を使用できます。DeepSeek Harness は `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL=http://127.0.0.1:8787/v1` を使用できます。これらは config layer を設定するもので、step や workflow routing の `base_url` leaf は上書きしません。Codex の permission control は `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL=takt` または `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL=codex` で設定できます。Codex Skill の継承は `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_REPO=true` または `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_USER=true` で設定できます。Claude Skill の継承は `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED=true` で設定できます。Claude terminal は `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`、`TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500` を使用できます。Kiro の custom agent は `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` で `provider_options.kiro.agent` を設定できます。Pi の thinking level は `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL=high` で `provider_options.pi.thinking_level` に設定できます。Pi の resource loading は `TAKT_PROVIDER_OPTIONS_PI_EXTENSIONS='["npm:pi-fff"]'`、`TAKT_PROVIDER_OPTIONS_PI_NO_EXTENSIONS=true`、`TAKT_PROVIDER_OPTIONS_PI_NO_SKILLS=true`、`TAKT_PROVIDER_OPTIONS_PI_NO_PROMPT_TEMPLATES=true`、`TAKT_PROVIDER_OPTIONS_PI_NO_THEMES=true`、`TAKT_PROVIDER_OPTIONS_PI_NO_CONTEXT_FILES=true` を使用できます。Pi の system prompt は `TAKT_PROVIDER_OPTIONS_PI_SYSTEM_PROMPT_MODE=append` または `TAKT_PROVIDER_OPTIONS_PI_SYSTEM_PROMPT_MODE=replace` で `provider_options.pi.system_prompt_mode` に設定できます。

これにより、表示名と provider 選択を分離したまま、runtime target が単一の workflow 内で provider や model を混在させることができます。

以下の provider 固有オプション例は互換性のために残る legacy `config.yaml` の option bag を示します。runtime モードでは `runtime.yaml` の `provider.profiles.<name>.options` に置き、workflow では対応する capability leaf だけを指定してください。

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

TAKT は `provider_options.claude.base_url` を `claude-sdk`、`claude`、`claude-headless` に `ANTHROPIC_BASE_URL` として渡します。`provider_options.codex.base_url` は Codex SDK constructor の `baseUrl` として渡します。`deepseek-harness` の `provider_options.deepseek_harness.base_url` は公式 TypeScript SDK へ `DEEPSEEK_BASE_URL` として渡します。`claude-terminal`、`opencode`、`cursor`、`copilot`、`kiro`、`pi` は、別途文書化されるまでこの base URL 対応の対象外です。

`ANTHROPIC_BASE_URL` や `OPENAI_BASE_URL` など provider-native の環境変数は provider 側の fallback 設定です。上記 provider では TAKT の `provider_options.*.base_url` が明示的な TAKT config として provider-native 設定より優先されます。

外部の proxy / gateway サービス（OpenAI 互換または Anthropic 互換 API を話す任意のエンドポイント）へのルーティングにも使えます。ただし非 loopback host を許可する層（global config または `TAKT_PROVIDER_OPTIONS_*_BASE_URL` 環境変数）で設定する必要があります。workflow 層と project 層で受理されるのは loopback アドレスのみです。

workflow と project config での `base_url` は local proxy 用に限定されています。任意の workflow file が API key と prompt の送信先を外部 host に変更できないよう、非 loopback の proxy endpoint は global config または TAKT env から設定してください。

#### DeepSeek Harness (`deepseek-harness`)

TAKT は公式 TypeScript SDK（`@deepseek-ai/dsh-sdk-client`）と対応 runtime（`@deepseek-ai/dsh`）を使用します。利用前に `takt install deepseek-harness` を実行してください。導入には npm レジストリへのネットワーク接続が必要で、npm のレジストリ・プロキシ設定をそのまま使います。TAKT を実行する Node に同梱の npm を優先し、なければ `PATH` 上の npm を使います。SDK と runtime は TAKT 管理ディレクトリ（既定 `~/.takt/deepseek-harness/sdk`、`TAKT_CONFIG_DIR` で変更可能）に導入されます。本体の npm install には含まれません。ready 判定は主な入口・native ファイルと必要なパッケージ条件を確認し、管理先の全ファイルは検査しません。未導入・バージョン不一致・検出できる破損では再実行を案内し、自動導入はしません。検査を通っても動作がおかしい場合は `takt install deepseek-harness --force` で入れ直してください。Python と uv は不要です。対応 platform は glibc `>= 2.28` の Linux x64/arm64 と macOS arm64 `>= 14.0` です。

TAKT は DeepSeek 用の `package.json` と `package-lock.json` を同梱します。install コマンドは管理ディレクトリの一時領域で `npm ci --ignore-scripts` を実行し、SDK・runtime・`fflate@0.8.3` と必要な native dependency の読み込みを検証してから使用する版を切り替えます。対応 platform 向けの配布済み native binary が必要です。再実行は導入済みの版を確認し、正常なら変更しません。管理側の `overrides` は [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) に対応するため、上流の `@deepseek-ai/libreoffice-kit@0.1.5` が `fflate@0.8.2` を宣言していても解決版を `0.8.3` に固定します。この対応は他の dependency advisory の解消を意味しません。

設定例:

```yaml
provider: deepseek-harness
model: deepseek-v4-flash
provider_options:
  deepseek_harness:
    base_url: http://127.0.0.1:8787/v1  # 任意。project/workflow config は loopback のみ
    max_tokens: 4096
    request_timeout_ms: 3600000
    shutdown_timeout_ms: 1000
```

`runtime_mode` と Python/uv 専用 option は削除され、未知の設定として拒否されます。`base_url` の環境変数 override は `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL`、provider-native endpoint は `DEEPSEEK_BASE_URL` です。non-loopback endpoint は global config または利用者が管理する TAKT 環境変数でのみ指定できます。workflow/project config では loopback のみを許可します。

`TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_RUNTIME_MODE`と`TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH`は解除してください。空文字列でも設定されていれば、project/global configの検証で拒否します。エラーには設定値を表示しません。

credential は公式 store `$DSH_HOME/.credentials.yaml`（既定 `~/.dsh/.credentials.yaml`）または `DEEPSEEK_API_KEY` など選択された環境変数から解決されます。参照名は `$DSH_HOME/settings.yaml` の `llm-deepseek.apiKeyEnv` から読み、未指定時は `DEEPSEEK_API_KEY` を使います。保存された `llm-deepseek.baseURL` は実際の endpoint と一致する必要があります。選択された環境変数は保存 credential より優先されます。TAKT は store の path と参照名を runtime に渡し、secret 値を読み取り・複写・書き換えません。credential source home と TAKT の runtime home は分離されています。既存 session 中の credential binding 変更は拒否されます。

runtime が稼働し、対応設定が同じ間は複数 turn を同一 session で受け付け、FIFO で直列化します。SDK は runtime 終了・再起動後に保存済み履歴を復元できず、設定変更で runtime 交換が必要な場合も履歴を保持できません。その状態での継続要求は固定診断で拒否します。推論強度、model、credential、runtime 設定を変える場合は新しい session identity を使ってください。過去履歴は再送せず、拒否したturnをID変更で再実行しません。対話の後続turnでは、後述の方針に従い新IDを許容します。workflowには新しいTAKT session/runが必要です。これは意図的な破壊的変更で、runtimeをまたぐ履歴保持は後続対応です。

provider error が credential を含んで session file に保存されることを防ぐため、TAKT は runtime の JSONL session-persistence plugin を無効にします。同一 runtime 内の turn はメモリ上で引き続き利用できます。既存の DeepSeek session file は読み込み・削除しません。

公式SDKのファイル操作・検索・shell・subagent/fork・workflow toolは有効です。他のローカルcoding providerと同じ、信頼するworkspaceでの実行を前提にします。モデルのtoolからcredentialを絶対に読めない保証ではありません。SDKのworkspace-write境界は書き込みを制御しますが、secret fileの読み取り隔離ではありません。認証設定は引き続きstore path/referenceだけを渡し、credential bindingとruntime homeを分離します。明示された未対応のTAKT制約は起動前に拒否し、黙って無視しません。

初期化のtimeoutは30秒固定です。turnの`request_timeout_ms`、shutdownの`shutdown_timeout_ms`とは独立しています。SDK runtime は stderr を破棄し process group を監視する supervisor の下で起動します。cleanup を確認できない場合は、別 session を含むすべての次回 runtime 起動を、旧 process group の終了が確認できるまで拒否します。SDK error は固定診断へ変換し、raw exception message、cause、data、stderr は表示・分類に使いません。

共有runtime-state lockを取得したprocessが強制終了した場合も、起動が拒否されることがあります。lockは自動復旧しません。TAKT config directoryの`deepseek-harness/state/`内に残る`.runtime-state-lock`と`cleanup-blocked`を手動で整理する場合、先に旧runtime・supervisor・tool processがすべて終了したことを確認してください。cleanup失敗を迂回するためだけに削除してはいけません。

**旧環境の手動整理:** すべてのTAKT/DeepSeek runtime・supervisor・toolを停止します。TAKT config directory（既定`~/.takt`）内の`deepseek-harness/venv/`、`deepseek-harness/pyproject.toml`、`deepseek-harness/uv.lock`を確認し、必要な旧データをバックアップしてからPython導入用と確認できたものだけを削除してください。`deepseek-harness/install.lock`、`dsh-home/`、`state/`、`sdk` は現在も使用します。`deepseek-harness/`全体は削除しないでください。旧profile・plugin・session履歴は取り込まれません。認証を変えない場合は`$DSH_HOME/.credentials.yaml`と`settings.yaml`を残し、install コマンドの実行後に新しいTAKT session/runを開始します。

**runtimeの所有と保持:** 別のTAKT processの正常なruntimeが共有homeを占有している場合、その終了を待つか別の`TAKT_CONFIG_DIR`を使います。これはcleanup失敗ではなく占有中の診断で、state削除による迂回は禁止です。idle runtimeは最近使った順に最大8件を保持し、古いものから終了します。実行中・待機中のturnは保護され、一時的に8件を超える場合があります。終了したruntimeのIDでは履歴を復元できず、継続を明示拒否します。対話では通知後の次の利用者turnから新sessionを開始します。自身のsupervisorがprocess groupの終了を確認した証跡があれば、SDK closeエラーだけで永久barrierを作りません。owner一覧が空なだけでは終了の証明にしません。証跡なし・owner破損・未登録runtimeは引き続き起動を拒否します。

source maintainer向け: `node scripts/verify-deepseek-sdk-lock.mjs --pack` で管理用 lock の固定版と npm pack に含まれる manifest・lock を検証できます。

SDK に permission control はないため、permission mode/callback、`bypassPermissions`、明示的な allowed-tools list を求める呼び出しは runtime 起動前に失敗します。空でない MCP server map、`maxTurns`、structured output、image attachment も適用できないため拒否します。provider の setup 時に渡す agent-level `systemPrompt` は SDK plugin 経由で runtime に適用されます。未対応の制約が必要な場合は対応する provider を使ってください。SDK notification/result は既存の text、thinking、tool、completion、error event へ正規化されます。

以前の Python/uv 管理ファイルと `takt deepseek-harness install` は使われません。TAKT は利用者の file を移行・削除しません。旧 managed environment を削除したい場合は内容を確認して手動で整理し、`~/.dsh` の credential store は別途管理してください。

通常の対話ではSDK標準toolを使います。`[]`を含む明示allowlistは未対応です。report/status phaseではtool禁止の空allowlistを維持し、resume、新sessionでのretry、DeepSeekへのfallbackのすべてでSDK起動前に拒否します。tool実行後の検出ではなく、副作用を実行前に防ぎます。これらのphaseには対応するproviderを使ってください。

personaのfirst-step情報ではtool未指定を`undefined`とし、明示`[]`と区別します。空・非空の明示listはどちらもDeepSeekのguardへ渡します。DeepSeekの対話では一般的なstale-session retryを使いません。制約拒否なら稼働中のsessionを残せますが、`session_continuation_unsupported`なら保存IDを解除します。そのエラーには、次の利用者turnが旧履歴なしの新しいSDK sessionになることを明記します。履歴復元はSDK対応待ちであり、ID変更は許容します。拒否されたturnの黙示再実行や制約緩和はしません。workflowでの継続には、引き続き新しいTAKT session/runが必要です。

TeamLeaderの`inspect_tools`もこの区別に従います。正規化で明示空listの指定元情報を残し、DeepSeekで空制約へ解決します。他providerの従来の既定動作は変えません。初期stepと表示用previewの未指定はともに`undefined`を保ち、toolなしではなくprovider標準と表示します。指定SDK IDは継続要求として扱い、対応するlive bindingがなければ、使用済みmarkerがなくてもSDK起動前に拒否します。通知後の新しい利用者turnがIDなしの場合にだけ、SDKが新IDを生成できます。cleanup barrierは新IDでも迂回できません。認証元・参照名・endpointの変更は再試行不可の`credential_binding_changed`で拒否し、保存IDを残します。変更後のbindingを使う限り後続turnも拒否し、fresh-session回復には流しません。変更後の認証先には新しいTAKT session/runを使ってください。元のbindingへ戻せば、その稼働中runtimeは再び利用できます。

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

runtime profile または capability preset で設定できます。legacy モードでは `provider_routing`、deprecated の `persona_providers`、project、global config からも設定できます。環境変数 `TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` でも上書きできます。

#### Codex の fast mode (`fast_mode`)

`provider_options.codex.fast_mode` で Codex の fast mode を明示的に設定できます。

```yaml
provider_options:
  codex:
    fast_mode: true
```

`true` と `false` はどちらも明示値として扱われます。省略した場合、TAKT は
`features.fast_mode` を Codex に渡さず、Codex 自身の既定値を維持します。環境変数では
`TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE=true` または
`TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE=false` を使用できます。

この設定は既存の provider option leaf の解決順序と source attribution に従います。
runtime profile、`provider_routing.personas`、`provider_routing.tags`、
`provider_routing.steps`、project または global の `provider_options`、環境変数 override
から設定できます。`takt exec` の assistant session も解決済み runtime default の
provider options を使用します。

#### Codex の permission control (`permission_control`)

Codex はデフォルトで TAKT の permission mode マッピングを使います。これは `permission_control: takt` と同じで、解決済みの TAKT `permission_mode` を Codex SDK の `sandboxMode` へ渡します。`network_access` を指定した場合は `networkAccessEnabled` にも渡します。省略時は Codex の既定値（`false`）を維持します。

Codex 側へ権限制御を委譲する場合だけ、明示的に opt-in します。

```yaml
provider_options:
  codex:
    permission_control: codex
    network_access: true
    reasoning_effort: high
    fast_mode: true
    skills:
      repo: true
```

`permission_control: codex` では通常の Codex 呼び出しと strict isolated structured 呼び出しの両方で TAKT は `sandboxMode` と `networkAccessEnabled` を渡しません。実効権限は Codex の `config.toml`、`default_permissions`、permission profile に委譲されます。capability、runtime profile、routing、project／global 設定、環境変数 override のいずれから解決された場合も、`network_access` は警告なしで受理され、これらの Codex 権限フィールドには使用されません。非対話実行を成立させるため `approvalPolicy: never` は引き続き設定され、`reasoning_effort`、`fast_mode`、`skills` などの非権限制御 option も従来どおり適用されます。明示的な opt-in のため、権限の結果は利用者の自己責任です。

Codex の設定プロファイルを名前で選択するには、`permission_control: codex` と一緒に `config_profile` を指定します。

```yaml
provider_options:
  codex:
    permission_control: codex
    config_profile: automation-review
```

環境変数 `TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE=automation-review` でも設定できます。

`config_profile` は ASCII の英字・数字・ハイフン・アンダースコアだけを含む名前を受け付けます。空文字や path は拒否され、`permission_control: codex` の場合だけ有効です。`permission_control` を省略した場合（既定値は `takt`）や `permission_control: takt` と併用した場合は設定エラーになります。TAKT は名前を `codex exec --profile <name>` として渡し、Codex が `$CODEX_HOME/<name>.config.toml` を解決します。そのファイル、基本設定、trusted project 設定、実行時 override の優先順位は Codex の仕様に従います。project・workflow・capability の provider options から profile を選べます。Codex はその profile の権限設定を実行に適用するため、信頼できる設定と profile だけを指定してください。

#### Codex Skill の継承 (`skills`)

TAKT workflow は repository scope と user scope の Codex Skill をデフォルトでは継承しません。workflow が環境依存の指示を利用すべき場合は runtime profile または `enable-skills` capability で対象 scope を明示的に有効化します。`takt exec` は解決した capability を生成 workflow に保持しますが、provider/model/options は runtime 設定に残ります。後の実行で指定した `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_*` 環境変数は引き続き最優先です。

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

TAKT は `claude-sdk`、`claude`、`claude-headless`、`claude-terminal` の filesystem Skill 探索をデフォルトで無効にします。repository または user Skill に意図的に依存する workflow だけで有効化してください。

```yaml
provider_options:
  claude:
    skills:
      enabled: true
```

`enabled: false` の場合、`claude-sdk` と別名 `claude` には `skills: []` を渡し、`claude-headless` と `claude-terminal` には `--disable-slash-commands` を渡します。この CLI flag は custom Claude slash command も無効にします。`enabled: true` の場合、TAKT は Skill 用の option/flag を追加せず、Claude の標準探索を維持します。この値は通常の provider option leaf 優先順位と `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED` に従い、retry と resume でも維持されます。

これは context filter であり sandbox ではありません。Skill file が Read/Bash から到達可能な場合は引き続き読めます。TAKT は `settingSources`、Claude settings、user/repository の Skill file を変更しません。同梱の Agent SDK version は `0.3.206` です。CLI session では `--disable-slash-commands` 対応が必要で、headless (`claude-headless`) と terminal (`claude-terminal`) の各 CLI session の開始前に確認し、非対応なら更新を促すエラーを返します。検証済みの Claude Code 最低 version は `2.1.220` です。

#### Claude Code の sandbox 制御 (`allow_unsandboxed_commands`)

Claude SDK は `permission_mode: edit` のとき Bash コマンドを macOS Seatbelt サンドボックス内で実行するため、`~/.gradle` への書き込みや JVM ベースのビルドツールが `Operation not permitted` で失敗することがあります。Bash コマンドだけサンドボックス外で実行したい場合は次のとおりです。

```yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

ファイル編集の権限は引き続き `permission_mode` で制御されます。

<a id="pi-resource-loading"></a>

#### Pi のリソース読み込み (`extensions`, `no_*`)

TAKT 実行時に Pi package / extension を読み込む、または探索する Pi リソース種別を制限するには `provider_options.pi` を使います。

```yaml
provider_options:
  pi:
    extensions:
      - npm:pi-fff
      # - git:https://github.com/example/pi-extension
      # - /absolute/path/to/local-extension
    no_extensions: true        # 探索を無効化。上記の明示した extension は読み込む
    no_skills: true            # Pi Skill の探索を無効化
    no_prompt_templates: true  # Pi prompt template の探索を無効化
    no_themes: true            # Pi theme の探索を無効化
    no_context_files: true     # Pi context file の探索を無効化
```

- `extensions` には npm package、Git source、local path を指定できます。
- version 指定のない明示 npm source は既存の project scope install、user scope install の順に再利用します。どちらも有効な resource に解決できない場合だけ temporary resolution に fallback し、永続 scope への新規 install は行いません。version 指定付き npm source は常に temporary resolution されます。
- npm 以外の明示した source は TAKT 実行時に temporary resolution されます。
- 明示した source は Pi settings には永続化されません。
- `no_extensions` は extension 探索を無効にしますが、`extensions` に列挙した source は読み込みます。
- その他の `no_*` オプションは、それぞれ対応するリソース種別の探索を無効にします。
- 暗黙の project-local Pi resource は信頼せず、読み込みません。project package storage から再利用するのは、明示した npm source に対して検出した絶対 path だけです。
- `readonly` と `edit` では、明示的に設定した各 extension のうち、builtin と異なる名前の tool を1つの trust unit としてまとめて有効化します。ambient に自動探索された extension tool は、これらの restrictive mode では有効化しません。非空の `allowedTools` は builtin の名前を絞り込み、同名の extension 版にも適用します。`allowedTools: []` は明示 extension tool を含むすべての tool を拒否します。空文字列や空白だけの項目しか含まないリストも同じ扱いです。
- permission mode 未指定時も、明示した `allowedTools` に登録元の検証を適用します。自動探索された extension の tool は、`allowedTools` に記載しても除外されます。extension の tool を有効にするには、`extensions` に読み込み元を明示し、`allowedTools` に tool 名を指定してください。extension を設定しても、リストにない tool は追加しません。skills・prompts・themes のみを含む package も、extension tool を許可せず従来どおり読み込みます。
- 明示的に設定した extension が factory 初期化時に builtin と同名の tool を登録すると、通常の Pi と同様に extension 版が builtin を置き換えます。`readonly` と `edit` では、mode が許可する builtin 名であり、かつ `allowedTools` を指定した場合はそのリストにも含まれる必要があります。permission mode 未指定で明示的な `allowedTools` を指定した場合、および `full` で readonly tool だけのリストを指定した場合も、tool 名をリストに含める必要があります。例えば `readonly` + `['grep']` では extension の `read` は有効にならず、`edit` + `['read']` では extension の `bash` は有効になりません。除外した名前の builtin 版への fallback もありません。これらの分岐では ambient の上書きも引き続き除外します。`full` を含む全 mode で provenance を検証できなければ Pi call を停止し、`session_start` で後から builtin の登録元を変更した場合も同様です。
- 登録元の整合性検証は、ツールの権限付与とは別です。`full` は `allowedTools` 未指定なら登録済みツールをすべて許可し、SDK が選択した正当な active-tool 一覧を維持します。登録元は cached call、registry refresh、直接のツール選択、通常・nested tool の実行直前で検証します。正当な動的登録は引き続き使えますが、登録元の改変を検出すると全ツールを無効化して実行を中断し、同じ logical session では失敗状態を解除しません。
- Pi の permission mode は active-tool allowlist であり、OS sandbox ではありません。信頼した明示 extension は `permission_mode: readonly` でも process を実行したり file を変更したりできます。明示 extension の読み込み失敗や provenance 検証失敗は、Pi call を error で停止します。
- 明示した extension は TAKT process 内で実行されるため、信頼できる local path と package source だけを設定してください。
- 認証情報を埋め込んだ URL や secret 系 query parameter を含む extension URL は拒否します。

これらの設定は通常の provider option leaf 優先順位に従い、`TAKT_PROVIDER_OPTIONS_PI_*` でも上書きできます。

<a id="pi-system-prompt"></a>

#### Pi の system prompt (`system_prompt_mode`)

`provider_options.pi.system_prompt_mode` は、TAKT の runtime prompt（ペルソナ、workflow context、step 指示）を Pi SDK に渡す方法を制御します。

```yaml
provider_options:
  pi:
    system_prompt_mode: append  # デフォルト
```

- `append`（デフォルト）: TAKT の runtime prompt を Pi 自身の system prompt の後に追加します。Pi 組み込みの指示（ドキュメント案内、tool の作法、skill catalog）は保持されます
- `replace`: TAKT の runtime prompt で Pi の system prompt を置き換えます。従来の挙動を維持したい場合や、Pi の system prompt を自分で制御したい場合に使います

Pi は SDK 型 provider のうち、組み込み prompt が大きく、捨てると振る舞いが変わる唯一の provider です。CLI 型ハーネスの provider（Codex・Cursor・Copilot・Kiro）は TAKT の prompt を渡しても自前の指示を失いません。そのため `append` が provider 間で一貫した挙動になります。`replace` はリクエストを短くできるため、persona・step 単位での使い分けにも向きます。

<a id="workflow-categories"></a>

## Workflow カテゴリ

`takt` の workflow 選択プロンプトでの UI 表示を改善するために、workflow をカテゴリに整理できます。

**推奨（正）の YAML キー**（同梱の `builtins/{lang}/workflow-categories.yaml` と一致）: トップレベル **`workflow_categories`**、各カテゴリオブジェクト直下の **`workflows`** 配列に **workflow 名**（各 workflow YAML の `name` フィールド。ビルトインなら `default` など）を列挙します。ファイルパスではありません。

カテゴリ構造には正準キーの **`workflow_categories`** と **`workflows`** を使います。加えて、トップレベルの任意設定 `show_others_category` / `others_category_name` も使えます。削除済みの旧カテゴリキーは受理されません。指定すると validation error になります。

### 設定方法

カテゴリは次の場所で設定できます。
- `builtins/{lang}/workflow-categories.yaml` — TAKT 同梱のデフォルト
- `~/.takt/preferences/workflow-categories.yaml` — ユーザー上書きファイル。`~/.takt/config.yaml` の `workflow_categories_file` で別パスも指定可能

`workflow_categories` を `~/.takt/config.yaml` 自体に書くことはできません。config スキーマは strict でこのキーを拒否します。`config.yaml` に書けるのはファイルパス（`workflow_categories_file`）だけで、カテゴリ本体は専用の上書きファイルに書きます。

```yaml
# ~/.takt/preferences/workflow-categories.yaml（または workflow_categories_file で指定したファイル）
workflow_categories:
  Development:
    workflows:
      - default: "標準の開発をする"   # 名前: 説明 で選択ラベルに説明を併記
      - simple
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
- **Workflow の説明** — `workflows:` のエントリを `- 名前: 説明` の形にすると選択ラベルに短い説明を併記します（文字列だけの従来形式も使えます）。複数カテゴリに列挙される workflow にはどのカテゴリでも同じ説明を書いてください。同じファイル内で異なる説明を付けると validation error になります。ユーザー overlay は builtin を workflow 名単位で上書きでき、ユーザー固有の名前も追加可能
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

一般デバッグログはプロセス単位で `.takt/runs/debug-{timestamp}/logs/debug-{timestamp}.log` に NDJSON 形式で出力されます。プロンプト/レスポンスログは workflow run 単位で `.takt/runs/<run>/logs/<sessionId>-prompts.jsonl` に出力されます。

### 詳細コンソール出力

`logging.level: debug` を設定すると、詳細なコンソール出力が有効になります。

```yaml
# ~/.takt/config.yaml
logging:
  level: debug
```

これは CLI 内部の verbose console mode も有効にします。さらに `logging.level: debug` だけで、上記のプロセス単位の一般デバッグログと workflow run 単位のプロンプト/レスポンスログが、`logging.debug` を別途設定しなくても出力されます。`logging.debug: true`、`logging.trace: true`、`logging.level: debug` のいずれかで有効になります。

## Companion の provider target

Companion には有効な `runtime.yaml` の provider section が必要です。参照する companion ごとに `provider.targets.companions` で割り当て、名前が未指定の場合は `provider.defaults` を使います。companion target は固定 profile のみ指定でき、pool と ladder は `runtime.yaml` の読み込み時に拒否されます。legacy `config.yaml` の provider 設定へはフォールバックせず、`companion` を使う workflow では移行案内付きで拒否します。

```yaml
version: 1
provider:
  profiles:
    review:
      provider: codex
      model: gpt-5
  defaults:
    profile: review
  targets:
    companions:
      security-reviewer:
        profile: review
```

Companion の structured call は他の TAKT 所有 structured agent と同じ provider-neutral な fresh-session transport を使います。native structured output 対応 provider ではそれを使い、それ以外では検証付き JSON fallback を使います。Companion reviewer、moderator、selector の呼び出しは常に `readonly` permission mode で実行し、解決された profile に設定された permission mode は適用しません。

| Provider | 実装エージェントの tool event |
|---|---:|
| `claude-sdk` / `claude` | ライブ |
| `codex` | ライブ |
| `claude-headless` | ライブ |
| `claude-terminal` | ターン後に再生 |
| `mock` | scenario に依存 |
| `opencode` | ライブ |
| `pi` | ライブ |
| `cursor`、`copilot`、`kiro` | 利用不可 |

ライブの tool event がない場合も完了レビューとターン境界での指摘配達は動作します。
## PR マージ workflow の設定

project と global に `merge` を保存できます。project のブロックが global 全体に優先し、省略項目は既定値になります。

```yaml
merge:
  workflow: merge-review-fix
  method: squash
  auto_start: false
  include_draft: false
  include_forks: false
  threat_check_max_diff_bytes: 200000
  where:
    author: alice
    labels: [ready, automation]
    base_branch: main
    head_branch: "takt/*"
    managed_by_takt: true
    same_repository: true
```

既定値は workflow `merge-review-fix`、方式 `squash`、自動起動無効、draft・fork 除外です。`method` は `squash`、`merge`、`rebase` を指定できます。GitLab での方式指定と新しい PR 状態取得は未対応で、対応していない操作はエラーになります。

`where` は既存 `pr_list` と同じ条件（`author`、`labels`、`base_branch`、`head_branch`、`managed_by_takt`、`same_repository`、`draft`）です。CLI 条件を指定すると `where`、`include_draft`、`include_forks` の設定全体を置き換えます。

draft の除外は `where` より先に適用します。`where.draft: true` で draft だけを選ぶ場合も、`include_draft: true` が必要です。
fork の除外も `where` より先に適用します。fork を対象にするには `include_forks: true` または CLI の `--include-forks` が必要です。PR 番号指定は選定条件を無視しますが、fork の脅威検査は行います。

`threat_check_max_diff_bytes` は fork の AI 評価へ渡す累積差分の上限で、正の整数（UTF-8 バイト数）です。既定は200,000です。上限超過では差分を切り詰めて判定せず、人間による確認を求める PR コメントを残して停止します。機械的検査で指示ファイル・CI 定義や危険な Git 設定を検出した場合、AI 評価と本体 workflow は実行しません。

`auto_start: true` は成功した workflow が PR を作成・更新した後、その PR 番号を直接渡して起動します。`caccia.enabled` とは独立しており、caccia が有効ならその終了後に起動します。手動 PR 作成への一律適用や再帰起動は行いません。
