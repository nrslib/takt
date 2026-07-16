# Workflow ガイド

このガイドでは TAKT の workflow を作成・カスタマイズする方法を説明します。

## workflow の基本

workflow は AI エージェントが実行する step の並びを定義した YAML ファイルです。各 step は次を指定します。

- どの persona を使うか
- どのような指示を与えるか
- 次の step へのルーティングルール

## ファイルの配置

- ビルトイン workflow は npm パッケージに同梱されています (`dist/resources/`)
- `~/.takt/workflows/` — ユーザー workflow (同名のビルトインを上書きします)
- `takt eject <workflow>` でビルトインを `~/.takt/workflows/` にコピーしてカスタマイズできます

## workflow カテゴリ

workflow 選択 UI をカテゴリ単位で整理するには `workflow_categories` を設定します。詳細は [Configuration Guide](./configuration.ja.md#workflow-カテゴリ) を参照してください。

## workflow ファイルの作成

`takt workflow init <name>` で `.takt/workflows/` (または `--global` 指定で `~/.takt/workflows/`) に新規 workflow の雛形を作成できます。

- `--template minimal`: 汎用的なルーティングを持つ単体雛形を生成
- `--template faceted`: workflow とローカルの persona / instruction facet ファイルをセットで生成

雛形を編集したら `takt workflow doctor <name or path>` で参照・ルーティング先・到達不能 step を検証してから実行してください。

## workflow スキーマ

```yaml
name: my-workflow
description: 任意の説明
max_steps: 10
initial_step: first-step          # 省略可、デフォルトは最初の step

# セクションマップ（キー → workflow YAML からの相対パス）
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md
policies:
  coding: ../facets/policies/coding.md
  review: ../facets/policies/review.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
  implement: ../facets/instructions/implement.md
report_formats:
  plan: ../facets/output-contracts/plan.md

steps:
  - name: step-name
    session_key: shared-coder        # 任意の明示セッションキー
    persona: coder                   # persona キー（personas マップを参照）
    persona_name: coder              # 表示名（省略可、provider_routing.personas には影響しない）
    tags: [implementation, edit]     # provider routing 用 tag（省略可）
    policy: coding                   # policy キー（単一またはキー配列）
    knowledge: architecture          # knowledge キー（単一またはキー配列）
    instruction: implement           # instruction キー（instructions マップを参照）
    edit: true                       # step がファイルを編集できるか
    required_permission_mode: edit   # 最低限の権限: readonly, edit, full
    provider_options:
      claude:
        allowed_tools:               # 任意の Claude ツール許可リスト
          - Read
          - Glob
          - Grep
          - Edit
          - Write
          - Bash
    rules:
      - condition: "Implementation complete"
        next: next-step
      - condition: "Cannot proceed"
        next: ABORT
    instruction: |                   # インライン指示
      ここに {variables} を含む指示を書きます
    output_contracts:                # レポートファイル設定
      report:
        - name: 00-plan.md
          format: plan               # report_formats マップを参照
    quality_gates:                   # agent step 完了時の品質 gate
      - "レビュー前に実装を確認する" # AI への指示
      - type: command                # 機械的に実行される command gate
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        cwd: "."
        timeout_ms: 300000
```

step はキー名で section map を参照します (例: `persona: coder`)。ファイルパスではありません。section map の中のパスは workflow YAML ファイルのディレクトリからの相対で解決されます。

`persona_name` は表示名専用です。config の `provider_routing.personas` は raw `persona` キーに一致し、`provider_routing.tags` は step の任意の `tags` 配列に書かれた順で一致します。同じ provider / model / provider_options leaf では後ろの tag が前の tag を上書きします。

`session_key` は通常の agent step、parallel sub-step、`loop_monitors.judge` で指定できます。system step、workflow-call step、parallel parent step では agent session を所有しないため指定できません。同じ persona を使う複数の agent step のセッションを分離したい場合、または別の agent step で意図的に同じセッションを共有したい場合に使います。実行時の有効キーは `session_key` に解決済み provider を付けた形になり、例: `shared-coder:claude` です。`session_key` を省略した場合は persona キー、persona が無い場合は step 名が使われます。空文字列と空白のみの値は workflow 検証で拒否されます。

`quality_gates` の文字列は従来どおり agent step の AI への完了条件としてプロンプトに含まれます。`type: command` の gate は agent step 完了後に worktree 内で実行され、終了コード `0` の場合のみ成功します。workflow YAML の command gate を使うには config 側で `workflow_command_gates.custom_scripts: true` を有効にする必要があります。失敗時は command のメタデータ、cwd、終了コードまたは timeout / output limit 情報、output log path、上限付きでサニタイズされた stdout / stderr が同じ agent step の差し戻し入力に含まれます。raw stdout / stderr はローカルの output log にも保存されます。`system` と `workflow_call` step では `quality_gates` を指定できません。

## 利用可能な変数

| 変数 | 説明 |
|------|------|
| `{task}` | ユーザーの元のリクエスト（テンプレートに無ければ自動注入） |
| `{iteration}` | workflow 全体の実行回数（実行された step の総数） |
| `{max_steps}` | 上限となる step 数 |
| `{step_iteration}` | この step を実行した回数 |
| `{previous_response}` | 前の step の出力（テンプレートに無ければ自動注入） |
| `{user_inputs}` | workflow 中に追加で得たユーザー入力（テンプレートに無ければ自動注入） |
| `{report_dir}` | レポートディレクトリのパス (例: `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | `{report_dir}/filename` の内容を埋め込む |

> **補足**: `{task}` / `{previous_response}` / `{user_inputs}` は instruction に自動注入されます。テンプレート内の位置を制御したいときだけ明示的なプレースホルダを置いてください。

## ルール

ルールは各 step から次の step へのルーティングを定義します。instruction builder は「どのタグを出力すれば良いか」を AI が理解できるよう、ステータス出力ルールを自動注入します。

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Cannot proceed"
    next: ABORT
    appendix: |
      何が進行を妨げているかを説明してください。
```

### ルール条件のタイプ

| タイプ | 構文 | 説明 |
|--------|------|------|
| タグベース | `"condition text"` | エージェントが `[STEP:N]` タグを出力し、インデックスで照合 |
| AI 判定 | `ai("condition text")` | step 出力に対して AI が条件を評価 |
| 集約 | `all("X")` / `any("X")` | 並列サブ step の結果を集約 |

### 特殊な `next` 値

- `COMPLETE` — workflow を成功で終了
- `ABORT` — workflow を失敗で終了

### ルールフィールド: `appendix`

任意の `appendix` フィールドは、そのルールにマッチしたときに AI が追加出力するためのテンプレートを与えます。構造化されたエラーレポートや特定情報の要求に便利です。

## Step タイプ

TAKT は 5 種類の step をサポートしています。必要な構造に応じて使い分けます。

### Normal Step

1 体のエージェントが step を実行します。これがデフォルトで、前述の例はすべて Normal です。

### Parallel Step

サブ step が並列で実行され、親が `all()` / `any()` でサブ step のマッチを集約します。

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        session_key: arch-review
        persona: architecture-reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        session_key: security-review
        persona: security-reviewer
        policy: review
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:
      - condition: all("approved")
        next: COMPLETE
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: すべてのサブ step が条件 X にマッチしたら true
- `any("X")`: いずれかのサブ step が条件 X にマッチしたら true
- サブ step の `rules` は取りうる結果を定義し、`next` は省略可能（親がルーティングを担当）
- 並列サブ step は `promotion` をサポートしません

### Finding Contract manager の provider/model

`finding_contract.manager` では、合成 Finding Manager step 専用の provider と model を指定できます。

```yaml
finding_contract:
  ledger_path: .takt/findings/review.json
  raw_findings_path: .takt/findings/review/raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: gpt-5.5
```

指定した値は Finding Manager の step レベル `provider` / `model` として扱われます。`provider_routing`、deprecated の `persona_providers.findings-manager`、workflow 既定値、解決済み入力 provider/model より優先されます。両方とも未指定の場合、manager は通常の workflow step provider/model 解決を維持します。`provider` だけを指定すると、下位優先度の model fallback は停止し、選択した provider 自身のデフォルトを使います。明示 model が必須の provider では検証エラーになります。

### Finding Contract parallel の retry 失敗ルーティング

workflow に `finding_contract` がある場合、各 parallel 親 step は Finding Manager output が retry 後も意味論的に invalid なときの決定的な rule を宣言する必要があります。この rule により、invalid manager output で workflow を abort したり ledger を更新したりしません。

許可される rule は、選択優先順に次のとおりです。

1. `return: need_replan`（推奨）
2. `return: needs_fix`
3. 非AIの `next: fix`

`fix` へ向かう `ai("...")` rule は、この失敗経路では選択されません。許可される rule がない場合、workflow validation が実行前に失敗します。

### Arpeggio Step（データ駆動バッチ）

CSV / JSON などのデータソースを反復し、同じ step テンプレートを各行に適用します。並列度には上限があります。

```yaml
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv
      batch_size: 5
      concurrency: 3
      template: ./templates/process.txt
      max_retries: 2
      retry_delay_ms: 1000
      merge:
        strategy: concat
        separator: "\n---\n"
      output_path: ./output/result.txt
    rules:
      - condition: "Processing complete"
        next: COMPLETE
```

ファイル一覧 / Issue 一覧 / 生成テストケースなど、同じ操作を多数の入力に適用したいときに便利です。

### Team Leader Step（動的タスク分解）

エージェントがリーダー役として、実行時にタスクを独立したサブパートに分解し、各パートを worker エージェントに割り当てます。

```yaml
  - name: implement
    team_leader:
      max_concurrency: 2
      max_total_parts: 8
      timeout_ms: 600000
      inspect_tools: [read, glob, grep]
      part_tags: [coding]
      part_persona: coder
      part_edit: true
      part_permission_mode: edit
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction: |
      このタスクを独立したサブタスクに分解してください。
    rules:
      - condition: "All parts completed"
        next: review
```

大きなタスクを「事前にユニット境界を決めなくても並列で進められる単位」に分解したいときに便利です。

`max_concurrency` は同時に実行する part 数、`max_total_parts` はその step 全体で計画できる総 part 数（最大 20）を制御します。旧名の `max_parts` は互換性のため `max_concurrency` として扱われます。`part_tags` は生成される part step の provider routing tag です。未指定時は親 step の `tags` を継承します。空文字や空白のみの tag は無効です。`part_tags` は通常の `provider_routing.tags` として解決されるため、`part_persona` による persona routing より優先されます。

`inspect_tools` は親 Team Leader のタスク分解フェーズだけで read-only inspection tools (`read`, `glob`, `grep`) を許可します。不正な tool 名は workflow ロード時にエラーになります。生成される子 part には影響せず、子 part の tool は引き続き `part_allowed_tools` で別に制御されます。inspection tools は Claude 系 provider や OpenCode など、`allowedTools` に対応する provider で利用できます。Team Leader inspection tools に対応しない provider では、実行時に明確なエラーになります。

### Workflow Call Step（サブワークフロー）

step が別の workflow を名前で呼び出します。子 workflow は同じ run の中で実行され、結果は親の `rules` でルーティングされます。

```yaml
  - name: peer-review
    workflow_call:
      workflow: peer-review
      params:
        impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

呼ばれる側の workflow は `subworkflow.params` を宣言することで、親から `impl_knowledge` や `fix_knowledge` などの値を受け取って動作を変えられます。step 定義の重複を避けられます。`subworkflow` の宣言については [Workflow レベルの設定](#workflow-レベルの設定) を参照してください。

## Output Contracts（レポートファイル）

step はレポートディレクトリ配下にレポートファイルを生成できます。

```yaml
# format を指定したレポート 1 件（report_formats マップを参照）
output_contracts:
  report:
    - name: 00-plan.md
      format: plan

# インライン format のレポート 1 件
output_contracts:
  report:
    - name: 00-plan.md
      format: |
        # Plan
        ...

# 複数レポート（ラベル付き）
output_contracts:
  report:
    - Scope: 01-scope.md
    - Decisions: 02-decisions.md
```

## Step レベルのプロバイダープロモーション

step は、その step の実行回数や AI 判定に応じて `provider` / `model` / `provider_options` を昇格させられます。`promotion` の各エントリは `at: <N>`（この step の N 回目の実行以降にマッチ）か `condition: ai("...")` の少なくとも 1 つを持ち、加えて 1 つ以上の override 先を指定します。

```yaml
steps:
  - name: review
    persona: reviewer
    promotion:
      - at: 3
        model: opus
      - condition: ai("レビュアーが reject を続けて進捗が止まっている")
        provider: claude
        model: opus
      - at: 5
        provider:
          type: codex
          model: gpt-5.5
          network_access: true
```

エントリは宣言順に評価され、**最後にマッチしたものが採用**されます。promotion は provider / model / provider_options 解決の **最優先ソース**（step レベルの `provider` / `model` よりも上）です。

promotion は並列サブ step ではサポートされません。

## Step オプション

| オプション | デフォルト | 説明 |
|--------|---------|------|
| `persona` | - | persona キー（section map 参照）またはファイルパス |
| `persona_name` | - | ログやプロンプト用の表示名。`provider_routing.personas` には影響しない |
| `session_key` | - | 通常の agent step と parallel sub-step の明示セッションキー。実行時キーには解決済み provider が付く。空文字・空白のみは無効 |
| `session` | `continue` | 通常の agent step と parallel sub-step のセッション扱い。`continue` は保存済み persona session を resume し、`refresh` は resume せず開始し、`compact` は resume 後に Phase 1 前だけ provider へ圧縮を依頼する。report phase / status phase 前には圧縮しない。圧縮 capability がない provider ではそのまま続行し、圧縮失敗時も warning を出して未圧縮 session で続行する |
| `requires_user_input` | `false` | 通常の agent step がユーザー入力待ち可能であることを示す。system step、workflow-call step、parallel parent step では指定不可。`requires_user_input: true` の step は agent 実行前から interactive mode と user input handler が必須で、未設定の場合はその agent を実行せず workflow を abort する。実際の入力待ちは、一致した rule 側の `requires_user_input: true` でのみ発生する |
| `tags` | - | config の `provider_routing.tags` に一致させる順序付き routing tag |
| `policy` | - | policy キーまたはキー配列 |
| `knowledge` | - | knowledge キーまたはキー配列 |
| `instruction` | - | instruction キー（section map 参照） |
| `edit` | - | step がプロジェクトファイルを編集できるか (`true` / `false`) |
| `pass_previous_response` | `true` | 前の step の出力を `{previous_response}` に渡す |
| `provider_options.claude.allowed_tools` | - | step または workflow に対する Claude ツール許可リスト |
| `provider_options.claude.base_url` | - | `claude` / `claude-sdk` 用の Anthropic 互換 base URL（[configuration ガイド](./configuration.ja.md#provider-base-url-base_url) 参照） |
| `provider_options.claude.effort` | - | Claude reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`（`xhigh` は Opus 4.7 が必要） |
| `provider_options.opencode.allowed_tools` | - | OpenCode のツール許可リスト。ツール名は `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch` のように lowercase |
| `provider_options.opencode.variant` | - | OpenCode の model variant。プロバイダー / model 固有の文字列としてパススルー |
| `provider_options.codex.base_url` | - | Codex SDK constructor option 用の OpenAI 互換 base URL（[configuration ガイド](./configuration.ja.md#provider-base-url-base_url) 参照） |
| `provider_options.codex.network_access` | - | Codex サンドボックスからのネットワークアクセスを許可（[configuration ガイド](./configuration.ja.md#ネットワークアクセス-network_access) 参照） |
| `provider_options.claude.sandbox.allow_unsandboxed_commands` | - | Claude の Bash を macOS Seatbelt サンドボックス外で実行（[configuration ガイド](./configuration.ja.md#claude-code-の-sandbox-制御-allow_unsandboxed_commands) 参照） |
| `provider_options.kiro.agent` | - | Kiro CLI の custom agent 名。`kiro-cli chat --agent` として渡される。未指定の step は Kiro CLI 側の default agent を使用 |
| `provider` | - | この step の provider を上書き (`claude`, `claude-sdk`, `claude-terminal`, `codex`, `opencode`, `cursor`, `copilot`, `kiro`, `mock`) |
| `model` | - | この step の model を上書き |
| `promotion` | - | 実行回数ごとの provider / model / options 昇格（[Step レベルのプロバイダープロモーション](#step-レベルのプロバイダープロモーション) 参照） |
| `mcp_servers` | - | step ごとの MCP サーバー設定 (stdio / HTTP / SSE) |
| `allow_git_commit` | `false` | step 指示内での `git add` / `commit` / `push` を許可。デフォルトは禁止（1 PR = 1 タスクを保つため） |
| `required_permission_mode` | - | 最低限の権限モード: `readonly`, `edit`, `full` |
| `output_contracts` | - | レポートファイル設定（name, format） |
| `quality_gates` | - | agent step 完了 gate。文字列は AI 向け指示、`type: command` は step 完了後に実行し、失敗時は同じ agent step に差し戻す |

通常の agent step、parallel sub-step、`loop_monitors.judge` では、`model: null` は model の明示的な省略を表します。`model` 未指定とは異なります。未指定は routing、workflow、loop monitor judge のトリガー元 step、入力由来の model など、適用可能な下位優先度のソースへフォールバックしますが、`null` はその entry で model 解決を止めます。明示 model が必須の provider では検証エラーになります。

実効ツール一覧は、設定値より狭くなる場合があります。`edit: false` の場合、または step に `output_contracts` があり `edit: true` ではない場合、TAKT は provider 呼び出し前に `provider_options.*.allowed_tools` からコマンド・編集系 tool を除去します。Claude 系 provider では、カンマ区切り entry を atomic な tool spec に正規化し、`Bash(...)` は `(` より前の canonical tool 名で判定してから、`Bash`、`Edit`、`Write`、`Apply_Patch`、`Patch` を除去します。OpenCode では `bash`、`edit`、`write` など lowercase の tool を除去します。同じ read-only フィルタは、`part_edit: false` または継承された `edit: false` などにより part の実効 edit 設定が false の場合の `team_leader.part_allowed_tools` にも適用されます。

## Workflow レベルの設定

workflow のトップレベルフィールドは、実行全体の挙動を制御します。

### `interactive_mode`

`takt` を引数なしで起動したときのデフォルト interactive mode。`assistant`（デフォルト） / `passthrough` / `quiet` / `persona` のいずれか。

```yaml
interactive_mode: assistant
```

### `workflow_config.provider_options`

workflow 全体のプロバイダーオプション。多くの provider option leaf では、env または CLI 起源の config 値が最優先されます。それ以外は step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated の `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml` の順です。`base_url` は例外で、step と workflow routing の leaf が TAKT env override より優先され、同じ step-to-global 順序の後に `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` または `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL` が使われます。workflow YAML と project `.takt/config.yaml` の `base_url` は loopback host のみ指定できます。非 loopback endpoint は global config または TAKT env を使ってください。

```yaml
workflow_config:
  provider_options:
    codex:
      network_access: true
    claude:
      sandbox:
        allow_unsandboxed_commands: true
```

`provider_options` は名前で共通 YAML プリセットを参照できます。名前は `.takt/provider-options`、`~/.takt/provider-options`、`builtins/{lang}/provider-options` の順に first-match で解決されます。repertoire package 内の workflow では package-local の `provider-options` が最優先され、`@owner/repo/name` でその package のプリセットも参照できます。参照先が base になり、inline の値が同じ leaf を上書きします。

`provider_options.extends` は、preset または path を解決できない場合、scoped ref が利用可能な repertoire package を指していない場合、参照先 YAML が不正または provider-options object でない場合、extends チェーンが循環している場合、削除済みの `$ref` キーが使われた場合に、設定エラーとして fail fast します。相対 path は workflow file 基準で解決され、symlink 解決後も workflow directory 内に留まる必要があります。絶対 path と、実体が workflow directory 外へ出る path は拒否されます。

```yaml
workflow_config:
  provider_options:
    extends: review-readonly

steps:
  - name: implement
    provider_options:
      extends: edit
      opencode:
        allowed_tools: [read, grep, bash]
```

workflow ファイルからの相対パスも、workflow-local な共通ファイル用に引き続き使用できます。

共通ファイルの例:

```yaml
claude:
  allowed_tools: [Read, Glob, Grep, Bash, WebSearch, WebFetch]
opencode:
  allowed_tools: [read, glob, grep, bash, websearch, webfetch]
```

### `workflow_config.runtime`

workflow 実行前に走る prepare スクリプト。ビルトインプリセットの `node` / `gradle` は常に許可されます。カスタムスクリプトパスを使うには config 側で `workflow_runtime_prepare.custom_scripts: true` を有効にする必要があります。

```yaml
workflow_config:
  runtime:
    prepare: [node, gradle, ./custom-script.sh]
```

### `loop_monitors`

step 間の循環パターン（例: `review` → `fix` → `review` の無限ループ）を検出し、進捗があるかを AI に判定させます。

```yaml
loop_monitors:
  - cycle: [review, fix]
    threshold: 3
    judge:
      session_key: loop-supervisor
      persona: supervisor
      instruction: "fix ループに進捗があるかを評価してください..."
      rules:
        - condition: "進捗あり"
          next: fix
        - condition: "進捗なし"
          next: ABORT
```

`loop_monitors.judge` は agent step と同じ provider/model 検証で `provider`、`model`、`provider_options` を指定できます。`provider` を省略した場合、judge はトリガー元 step の provider と model を継承します。`provider` を指定して `model` を省略した場合、継承 model はクリアされます。トリガー元 step に解決済み model があっても provider または CLI のデフォルトを使わせたい場合は、`model: null` を指定してください。

`loop_monitors.judge.session_key` も step の `session_key` と同じく、実行時は provider suffix 付きのキーになります。同じ persona を使う複数の監視 judge が同じセッションを resume してはいけない場合に指定してください。

### `rate_limit_fallback`

step 実行中に Claude / Codex / OpenCode の rate limit に遭遇した場合、中断された step をチェーン上の次の provider で再実行することで run を継続できます。新しいセッションには「なぜ前のセッションが中断されたか」を伝える fallback notice 指示が挿入され、AI はディスク上の既存レポートからコンテキストを再構築できます。

```yaml
rate_limit_fallback:
  switch_chain:
    - provider: claude-sdk
      model: opus
    - provider: codex
      model: gpt-5.5
```

1 つのチェーン内の試行履歴は workflow state に記録され、step 成功時にリセットされます。同じフィールドは `~/.takt/config.yaml` および `.takt/config.yaml` でも受け入れられ、プロジェクト全体 / ユーザー全体のデフォルトとして機能します。

### `subworkflow`

その workflow を「親 workflow の `workflow_call` からパラメータを受け取るサブワークフロー」として宣言します。サブワークフローは workflow 選択 UI には現れません。

```yaml
subworkflow:
  visibility: internal
  params:
    - name: impl_knowledge
      required: true
```

## 例

### シンプルな実装 workflow

```yaml
name: simple-impl
max_steps: 5

personas:
  coder: ../facets/personas/coder.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      指示された変更を実装してください。
```

### レビュー付きの workflow

```yaml
name: with-review
max_steps: 10

personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      指示された変更を実装してください。

  - name: review
    persona: reviewer
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction: |
      実装をコード品質とベストプラクティスの観点でレビューしてください。
```

### step 間でデータを渡す

```yaml
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md

steps:
  - name: analyze
    persona: planner
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Analysis complete
        next: implement
    instruction: |
      このリクエストを解析し、計画を立ててください。

  - name: implement
    persona: coder
    edit: true
    pass_previous_response: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction: |
      次の解析結果に基づいて実装してください:
      {previous_response}
```

## ベストプラクティス

1. **イテレーション数を妥当に保つ** — 開発系 workflow では 10〜30 程度が一般的
2. **レビュー step では `edit: false`** — レビュアーがコードを変更しないようにする
3. **わかりやすい step 名を使う** — ログが読みやすくなる
4. **workflow は段階的にテストする** — 単純な構成から始めて複雑化する
5. **`/eject` でカスタマイズする** — ゼロから書くよりビルトイン workflow をコピーして編集する方が確実
