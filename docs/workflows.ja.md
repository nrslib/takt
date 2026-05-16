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
    persona: coder                   # persona キー（personas マップを参照）
    persona_name: coder              # 表示名（省略可）
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
```

step はキー名で section map を参照します (例: `persona: coder`)。ファイルパスではありません。section map の中のパスは workflow YAML ファイルのディレクトリからの相対で解決されます。

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
        persona: architecture-reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
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
      max_parts: 3
      timeout_ms: 600000
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
| `policy` | - | policy キーまたはキー配列 |
| `knowledge` | - | knowledge キーまたはキー配列 |
| `instruction` | - | instruction キー（section map 参照） |
| `edit` | - | step がプロジェクトファイルを編集できるか (`true` / `false`) |
| `pass_previous_response` | `true` | 前の step の出力を `{previous_response}` に渡す |
| `provider_options.claude.allowed_tools` | - | step または workflow に対する Claude ツール許可リスト |
| `provider_options.claude.effort` | - | Claude reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`（`xhigh` は Opus 4.7 が必要） |
| `provider_options.opencode.variant` | - | OpenCode の model variant。プロバイダー / model 固有の文字列としてパススルー |
| `provider_options.codex.network_access` | - | Codex サンドボックスからのネットワークアクセスを許可（[configuration ガイド](./configuration.ja.md#ネットワークアクセス-network_access) 参照） |
| `provider_options.claude.sandbox.allow_unsandboxed_commands` | - | Claude の Bash を macOS Seatbelt サンドボックス外で実行（[configuration ガイド](./configuration.ja.md#claude-code-の-sandbox-制御-allow_unsandboxed_commands) 参照） |
| `provider` | - | この step の provider を上書き (`claude`, `claude-sdk`, `codex`, `opencode`, `cursor`, `copilot`) |
| `model` | - | この step の model を上書き |
| `promotion` | - | 実行回数ごとの provider / model / options 昇格（[Step レベルのプロバイダープロモーション](#step-レベルのプロバイダープロモーション) 参照） |
| `mcp_servers` | - | step ごとの MCP サーバー設定 (stdio / HTTP / SSE) |
| `allow_git_commit` | `false` | step 指示内での `git add` / `commit` / `push` を許可。デフォルトは禁止（1 PR = 1 タスクを保つため） |
| `required_permission_mode` | - | 最低限の権限モード: `readonly`, `edit`, `full` |
| `output_contracts` | - | レポートファイル設定（name, format） |
| `quality_gates` | - | step 完了の品質基準（AI 向け指示） |

## Workflow レベルの設定

workflow のトップレベルフィールドは、実行全体の挙動を制御します。

### `interactive_mode`

`takt` を引数なしで起動したときのデフォルト interactive mode。`assistant`（デフォルト） / `passthrough` / `quiet` / `persona` のいずれか。

```yaml
interactive_mode: assistant
```

### `workflow_config.provider_options`

workflow 全体のプロバイダーオプション。step / persona / project / global の各レイヤーとマージされます。同じ leaf については step レベルが優先されます。

```yaml
workflow_config:
  provider_options:
    codex:
      network_access: true
    claude:
      sandbox:
        allow_unsandboxed_commands: true
```

### `workflow_config.runtime`

workflow 実行前に走る prepare スクリプト。ビルトインプリセットの `node` / `gradle` は常に許可されます。カスタムスクリプトパスを使うには config 側で `workflow_runtime_prepare.customScripts: true` を有効にする必要があります。

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
      persona: supervisor
      instruction: "fix ループに進捗があるかを評価してください..."
      rules:
        - condition: "進捗あり"
          next: fix
        - condition: "進捗なし"
          next: ABORT
```

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
