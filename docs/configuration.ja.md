# 設定

[English](./configuration.md)

このドキュメントは TAKT の全設定オプションのリファレンスです。クイックスタートについては [README](../README.md) を参照してください。

## グローバル設定

`~/.takt/config.yaml` で TAKT のデフォルト設定を行います。このファイルは初回実行時に自動作成されます。すべてのフィールドは省略可能です。

```yaml
# ~/.takt/config.yaml
language: en                  # UI 言語: 'en' または 'ja'
default_piece: default        # 新規プロジェクトのデフォルト piece
log_level: info               # ログレベル: debug, info, warn, error
provider: claude              # デフォルト provider: claude, codex, または opencode
model: sonnet                 # デフォルトモデル（省略可、provider にそのまま渡される）
branch_name_strategy: romaji  # ブランチ名生成方式: 'romaji'（高速）または 'ai'（低速）
prevent_sleep: false          # 実行中に macOS のアイドルスリープを防止（caffeinate）
notification_sound: true      # 通知音の有効/無効
notification_sound_events:    # イベントごとの通知音切り替え（省略可）
  iteration_limit: false
  piece_complete: true
  piece_abort: true
  run_complete: true          # デフォルト有効。false で無効化
  run_abort: true             # デフォルト有効。false で無効化
concurrency: 1                # takt run の並列タスク数（1-10、デフォルト: 1 = 逐次実行）
task_poll_interval_ms: 500    # takt run での新規タスクポーリング間隔（100-5000、デフォルト: 500）
interactive_preview_movements: 3  # インタラクティブモードでの movement プレビュー数（0-10、デフォルト: 3）

# ランタイム環境デフォルト（piece_config.runtime で上書きしない限りすべての piece に適用）
# runtime:
#   prepare:
#     - gradle    # .runtime/ に Gradle キャッシュ/設定を準備
#     - node      # .runtime/ に npm キャッシュを準備

# persona ごとの provider / model 上書き（省略可）
# piece を複製せずに特定の persona を別の provider / model にルーティング
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
#     movement_permission_overrides:
#       ai_review: readonly
#   claude:
#     default_permission_mode: edit

# API キー設定（省略可）
# 環境変数 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY で上書き可能
# anthropic_api_key: sk-ant-...  # Claude（Anthropic）用
# openai_api_key: sk-...         # Codex（OpenAI）用
# opencode_api_key: ...          # OpenCode 用

# Codex CLI パス上書き（省略可）
# Codex SDK が使用する Codex CLI バイナリを上書き（実行可能ファイルの絶対パスが必要）
# 環境変数 TAKT_CODEX_CLI_PATH で上書き可能
# codex_cli_path: /usr/local/bin/codex

# ビルトイン piece フィルタリング（省略可）
# builtin_pieces_enabled: true           # false ですべてのビルトインを無効化
# disabled_builtins: [magi, passthrough] # 特定のビルトイン piece を無効化

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
| `default_piece` | string | `"default"` | 新規プロジェクトのデフォルト piece |
| `log_level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | ログレベル |
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` | `"claude"` | デフォルト AI provider |
| `model` | string | - | デフォルトモデル名（provider にそのまま渡される） |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | ブランチ名生成方式 |
| `prevent_sleep` | boolean | `false` | macOS アイドルスリープ防止（caffeinate） |
| `notification_sound` | boolean | `true` | 通知音の有効化 |
| `notification_sound_events` | object | - | イベントごとの通知音切り替え |
| `concurrency` | number (1-10) | `1` | `takt run` の並列タスク数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新規タスクのポーリング間隔 |
| `interactive_preview_movements` | number (0-10) | `3` | インタラクティブモードでの movement プレビュー数 |
| `worktree_dir` | string | - | 共有クローンのディレクトリ（デフォルトは `../{clone-name}`） |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `verbose` | boolean | - | 詳細出力モード |
| `minimal_output` | boolean | `false` | AI 出力を抑制（CI 向け） |
| `runtime` | object | - | ランタイム環境デフォルト（例: `prepare: [gradle, node]`） |
| `persona_providers` | object | - | persona ごとの provider / model 上書き（例: `coder: { provider: codex, model: o3-mini }`） |
| `provider_options` | object | - | グローバルな provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |
| `anthropic_api_key` | string | - | Claude 用 Anthropic API キー |
| `openai_api_key` | string | - | Codex 用 OpenAI API キー |
| `opencode_api_key` | string | - | OpenCode API キー |
| `codex_cli_path` | string | - | Codex CLI バイナリパス上書き（絶対パス） |
| `enable_builtin_pieces` | boolean | `true` | ビルトイン piece の有効化 |
| `disabled_builtins` | string[] | `[]` | 無効化する特定のビルトイン piece |
| `pipeline` | object | - | pipeline テンプレート設定 |
| `bookmarks_file` | string | - | ブックマークファイルのパス |
| `piece_categories_file` | string | - | piece カテゴリファイルのパス |

## プロジェクト設定

`.takt/config.yaml` でプロジェクト固有の設定を行います。このファイルはプロジェクトディレクトリで初めて TAKT を使用した際に作成されます。

```yaml
# .takt/config.yaml
piece: default                # このプロジェクトの現在の piece
provider: claude              # このプロジェクトの provider 上書き
auto_pr: true                 # worktree 実行後に PR を自動作成
verbose: false                # 詳細出力モード

# provider 固有オプション（グローバルを上書き、piece/movement で上書き可能）
# provider_options:
#   codex:
#     network_access: true

# provider 固有パーミッションプロファイル（プロジェクトレベルの上書き）
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     movement_permission_overrides:
#       ai_review: readonly
```

### プロジェクト設定フィールドリファレンス

| フィールド | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `piece` | string | `"default"` | このプロジェクトの現在の piece 名 |
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` \| `"mock"` | - | provider 上書き |
| `auto_pr` | boolean | - | worktree 実行後に PR を自動作成 |
| `verbose` | boolean | - | 詳細出力モード |
| `provider_options` | object | - | provider 固有オプション |
| `provider_profiles` | object | - | provider 固有のパーミッションプロファイル |

プロジェクト設定の値は、両方が設定されている場合にグローバル設定を上書きします。

## API キー設定

TAKT は3つの provider をサポートしており、それぞれに API キーが必要です。API キーは環境変数または `~/.takt/config.yaml` で設定できます。

### 環境変数（推奨）

```bash
# Claude（Anthropic）用
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）用
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode 用
export TAKT_OPENCODE_API_KEY=...
```

### 設定ファイル

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # Claude 用
openai_api_key: sk-...         # Codex 用
opencode_api_key: ...          # OpenCode 用
```

### 優先順位

環境変数は `config.yaml` の設定よりも優先されます。

| Provider | 環境変数 | 設定キー |
|----------|---------|---------|
| Claude (Anthropic) | `TAKT_ANTHROPIC_API_KEY` | `anthropic_api_key` |
| Codex (OpenAI) | `TAKT_OPENAI_API_KEY` | `openai_api_key` |
| OpenCode | `TAKT_OPENCODE_API_KEY` | `opencode_api_key` |

### セキュリティ

- `config.yaml` に API キーを記載する場合、このファイルを Git にコミットしないよう注意してください。
- 環境変数の使用を検討してください。
- 必要に応じて `~/.takt/config.yaml` をグローバル `.gitignore` に追加してください。
- API キーを設定すれば、対応する CLI ツール（Claude Code、Codex、OpenCode）のインストールは不要です。TAKT が対応する API を直接呼び出します。

### Codex CLI パス上書き

Codex CLI バイナリパスは環境変数または設定ファイルで上書きできます。

```bash
export TAKT_CODEX_CLI_PATH=/usr/local/bin/codex
```

```yaml
# ~/.takt/config.yaml
codex_cli_path: /usr/local/bin/codex
```

パスは実行可能ファイルの絶対パスである必要があります。`TAKT_CODEX_CLI_PATH` は設定ファイルの値よりも優先されます。

## モデル解決

各 movement で使用されるモデルは、次の優先順位（高い順）で解決されます。

1. **Piece movement の `model`** - piece YAML の movement 定義で指定
2. **カスタムエージェントの `model`** - `.takt/agents.yaml` のエージェントレベルのモデル
3. **グローバル設定の `model`** - `~/.takt/config.yaml` のデフォルトモデル
4. **Provider デフォルト** - provider のビルトインデフォルトにフォールバック（Claude: `sonnet`、Codex: `codex`、OpenCode: provider デフォルト）

### Provider 固有のモデルに関する注意

**Claude Code** はエイリアス（`opus`、`sonnet`、`haiku`、`opusplan`、`default`）と完全なモデル名（例: `claude-sonnet-4-5-20250929`）をサポートしています。`model` フィールドは provider CLI にそのまま渡されます。利用可能なモデルについては [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code) を参照してください。

**Codex** は Codex SDK を通じてモデル文字列をそのまま使用します。未指定の場合、デフォルトは `codex` です。利用可能なモデルについては Codex のドキュメントを参照してください。

**OpenCode** は `provider/model` 形式のモデル（例: `opencode/big-pickle`）が必要です。OpenCode provider でモデルを省略すると設定エラーになります。

### 設定例

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # すべての movement のデフォルトモデル（上書きされない限り）
```

```yaml
# piece.yaml - movement レベルの上書きが最高優先
movements:
  - name: plan
    model: opus       # この movement はグローバル設定に関係なく opus を使用
    ...
  - name: implement
    # model 未指定 - グローバル設定（opus）にフォールバック
    ...
```

## Provider プロファイル

Provider プロファイルを使用すると、各 provider にデフォルトのパーミッションモードと movement ごとのパーミッション上書きを設定できます。異なる provider を異なるセキュリティポリシーで運用する場合に便利です。

### パーミッションモード

TAKT は provider 非依存の3つのパーミッションモードを使用します。

| モード | 説明 | Claude | Codex | OpenCode |
|--------|------|--------|-------|----------|
| `readonly` | 読み取り専用、ファイル変更不可 | `default` | `read-only` | `read-only` |
| `edit` | 確認付きでファイル編集を許可 | `acceptEdits` | `workspace-write` | `workspace-write` |
| `full` | すべてのパーミッションチェックをバイパス | `bypassPermissions` | `danger-full-access` | `danger-full-access` |

### 設定方法

Provider プロファイルはグローバルレベルとプロジェクトレベルの両方で設定できます。

```yaml
# ~/.takt/config.yaml（グローバル）または .takt/config.yaml（プロジェクト）
provider_profiles:
  codex:
    default_permission_mode: full
    movement_permission_overrides:
      ai_review: readonly
  claude:
    default_permission_mode: edit
    movement_permission_overrides:
      implement: full
```

### パーミッション解決の優先順位

パーミッションモードは次の順序で解決されます（最初にマッチしたものが適用）。

1. **プロジェクト** `provider_profiles.<provider>.movement_permission_overrides.<movement>`
2. **グローバル** `provider_profiles.<provider>.movement_permission_overrides.<movement>`
3. **プロジェクト** `provider_profiles.<provider>.default_permission_mode`
4. **グローバル** `provider_profiles.<provider>.default_permission_mode`
5. **Movement** `required_permission_mode`（最低限の下限として機能）

movement の `required_permission_mode` は最低限の下限を設定します。provider プロファイルから解決されたモードが要求モードよりも低い場合、要求モードが使用されます。たとえば、movement が `edit` を要求しているがプロファイルが `readonly` に解決される場合、実効モードは `edit` になります。

### Persona Provider

piece を複製せずに、特定の persona を別の provider や model にルーティングできます。

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder:
    provider: codex        # coder persona を Codex で実行
    model: o3-mini         # 使用モデル（省略可）
  ai-antipattern-reviewer:
    provider: claude       # レビュアーは Claude のまま
```

`provider` と `model` はいずれも省略可能です。`model` の解決優先度: movement YAML の `model` > `persona_providers[persona].model` > グローバル `model`。

これにより、単一の piece 内で provider や model を混在させることができます。persona 名は movement 定義の `persona` キーに対してマッチされます。

## Piece カテゴリ

`takt switch` や piece 選択プロンプトでの UI 表示を改善するために、piece をカテゴリに整理できます。

### 設定方法

カテゴリは次の場所で設定できます。
- `builtins/{lang}/piece-categories.yaml` - デフォルトのビルトインカテゴリ
- `~/.takt/config.yaml` または `piece_categories_file` で指定した別のカテゴリファイル

```yaml
# ~/.takt/config.yaml または専用カテゴリファイル
piece_categories:
  Development:
    pieces: [default, simple]
    children:
      Backend:
        pieces: [expert-cqrs]
      Frontend:
        pieces: [expert]
  Research:
    pieces: [research, magi]

show_others_category: true         # 未分類の piece を表示（デフォルト: true）
others_category_name: "Other Pieces"  # 未分類カテゴリの名前
```

### カテゴリ機能

- **ネストされたカテゴリ** - 階層的な整理のための無制限の深さ
- **カテゴリごとの piece リスト** - 特定のカテゴリに piece を割り当て
- **その他カテゴリ** - 未分類の piece を自動収集（`show_others_category: false` で無効化可能）
- **ビルトイン piece フィルタリング** - `enable_builtin_pieces: false` ですべてのビルトインを無効化、または `disabled_builtins: [name1, name2]` で選択的に無効化

### カテゴリのリセット

piece カテゴリをビルトインのデフォルトにリセットできます。

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
| `{report}` | PR 本文 | Piece 実行レポート |

### Pipeline CLI オプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | pipeline（非インタラクティブ）モードを有効化 |
| `--auto-pr` | 実行後に PR を作成 |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（piece のみ実行） |
| `--repo <owner/repo>` | PR 作成用のリポジトリを指定 |
| `-q, --quiet` | 最小出力モード（AI 出力を抑制） |

## デバッグ

### デバッグログ

`~/.takt/config.yaml` で `debug_enabled: true` を設定するか、`.takt/debug.yaml` ファイルを作成してデバッグログを有効化できます。

```yaml
# .takt/debug.yaml
enabled: true
```

デバッグログは `.takt/logs/debug.log` に NDJSON 形式で出力されます。

### 詳細モード

空の `.takt/verbose` ファイルを作成すると、詳細なコンソール出力が有効になります。これにより、デバッグログも自動的に有効化されます。

または、設定ファイルで `verbose: true` を設定することもできます。

```yaml
# ~/.takt/config.yaml または .takt/config.yaml
verbose: true
```
