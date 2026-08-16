# ワークフローYAML スキーマリファレンス

このドキュメントは workflow YAML の構造を定義する。具体的な workflow 定義は含まない。

## トップレベルフィールド

```yaml
name: workflow-name           # workflow 名（必須）。カテゴリの workflow_categories 下の workflows でもこの名前を使う
description: 説明テキスト      # 任意
max_steps: 10                 # 最大イテレーション数（省略時デフォルトあり）
initial_step: plan            # 最初に実行する step 名（省略時は steps の先頭）

all_steps:                    # workflow 全体に適用する宣言（任意）
  rules:
    - findings-handling       # workflows/rules/findings-handling.md
    - ref: careful-findings
      position: before_instruction

# ワークフロー全体の provider / runtime 等
workflow_config:
  provider_options:
    codex:
      network_access: true

# セクションマップ（キー → ファイルパスの対応表）
policies:                     # ポリシー定義（任意）
  coding: ../policies/coding.md
  review: ../policies/review.md
personas:                     # ペルソナ定義（任意）
  coder: ../personas/coder.md
  reviewer: ../personas/architecture-reviewer.md
instructions:                 # 指示テンプレート定義（任意）
  plan: ../instructions/plan.md
  implement: ../instructions/implement.md
report_formats:               # レポートフォーマット定義（任意）
  plan: ../output-contracts/plan.md
  review: ../output-contracts/architecture-review.md
knowledge:                    # ナレッジ定義（任意）
  architecture: ../knowledge/architecture.md

steps: [...]                  # step 定義の配列（推奨キー名）
loop_monitors: [...]          # ループ監視設定（任意）。cycle には step 名を並べる
```

`all_steps.rules` はすべての agent step の Phase 1 指示へ適用するルール参照です。参照は project `.takt/workflows/rules/`、global `~/.takt/workflows/rules/`、builtin の順に `<ref>.md` を解決します。文字列は自動実行ルールの後、object の `position: before_instruction` は `Instructions` の直前に挿入されます。ルールは `workflow_call` の子へ親から子の順で加算継承されます。親子で `ref`・`position`・解決済み内容がすべて一致する場合は親側を残して1回だけ適用し、同じ `ref` でも位置または内容が異なる場合は両方を維持します。レポート出力・ステータス判定・companion には適用されず、必須出力見出しと `{report:...}` を含むルールファイルはロード時に拒否されます。`all_steps` を省略した場合は従来の prompt を維持します。

### セクションマップの解決

各セクションマップのパスは **workflow YAML ファイルのディレクトリからの相対パス** で解決する。
step 定義内では**キー名**で参照する（パスを直接書かない）。

例: workflow が `{スキルルート}/workflows/coding.yaml` にあり、`personas:` セクションに `coder: ../personas/coder.md` がある場合
→ 絶対パスは `{スキルルート}/personas/coder.md`（`スキルルート` は Claude Code では `~/.claude/skills/takt`、Codex では `~/.agents/skills/takt` など、インストール先に応じて置き換える）
→ step では `persona: coder` で参照

## Step 定義（`steps` の各要素）

`uses: <name>` で `steps/<name>.yaml` または `steps/<name>.yml` の単一 step fragment を参照できる。top-level agent / `workflow_call` step、parallel parent、parallel sub-step で利用できる。fragment は root と parallel sub-step のどちらにも `rules` を定義できず、concrete workflow の各 `uses` 呼び出し側が空でない rule 定義を持つ。非 parallel fragment の呼び出し側は `rules` 配列を使う。parallel fragment の呼び出し側は `{ self: Rule[], parallel: Record<finalChildName, Rule[]> }` を使い、`self` と全 final child の配列を空にできず、child 名を過不足なく列挙する。child rule tree は無効である。bare name は project、global、選択言語の builtin の順に検索し、repertoire workflow は package-local を最優先にする。`@owner/repo/name` は指定した repertoire package の fragment を参照する。候補層ごとに `.yaml` を `.yml` より先に採用し、nested bare 参照は親 fragment の解決元以降の候補層だけを検索する。展開は64段、参照は512個までで、fragment は1 MiB以下の読み取り可能な通常ファイルでなければならない。呼び出し側の object field は deep merge で上書きし、配列 field は呼び出し側の値で全置換する。ただし、parallel caller の rule tree は resolver 専用の overlay であり、fragment の `parallel` 配列を置換しない。名前は呼び出し側、fragment、`uses` の順で決定する。不明な参照、読み取り不能、循環、上限超過、object 以外の定義、解決後の `system`、絶対 path、traversal、ネストしたpath、symlink の root、root 外 symlink は設定エラーになる。project trust の workflow は、project 外の fragment から `workflow_call` または `allow_git_commit: true` を受け取れない。fragment 由来の `allow_git_commit` は呼び出し側で明示的に `false` を指定して上書きできる。

fragment root の `params` は必須の型付き parameter を宣言し、`uses` caller の `with` が全値を束縛する。facet parameter は `type: facet_ref` / `facet_ref[]` と、`policy` / `knowledge` / `instruction` / `persona` / `report_format` のいずれかの `facet_kind` を指定する。workflow の呼び出し先を表す parameter は `type: workflow_ref` とし、`facet_kind` は指定しない。fragment params では `default`・`optional`・`alias` を利用できない。この制約は fragment params 固有であり、`subworkflow.params` では `default` を指定でき、`facet_ref[]` の arg / default は空配列も許可される。

`{ $param: name }` は宣言と対応する `policy`、`knowledge`、`persona`、`instruction`、`output_contracts.report[].format`、または `workflow_call.call` に配置する。`facet_ref` / `facet_ref[]` parameter は `policy` / `knowledge` の配列要素として固定参照と混在でき、配列値は順序を保ってその位置へ展開される。空の `facet_ref[]` は要素を追加しない。すべての parameter 型は `workflow_call.args` の直接の値、または nested fragment caller の `with` に渡せる。nested fragment は outer parameter を暗黙 capture できないため、`with: { child_param: { $param: outer_param } }` と明示的に渡す。resolver は未知・不足 binding、scalar/list 不一致、kind 不一致、未宣言参照、未対応 field の参照を拒否する。`params` / `with` は schema 検証前に消費され、`workflow_call` fragment 自身の `args` は保持・展開され、caller overlay は parameter 展開後に適用される。

### 通常の step

```yaml
- name: step-name              # step 名（必須、workflow 内で一意）
  persona: coder               # ペルソナキー（personas マップを参照、任意）
  policy: coding               # ポリシーキー（policies マップを参照、任意）
  instruction: implement       # 指示（instructions マップのキー参照、またはインライン、任意）
  knowledge: architecture      # ナレッジキー（knowledge マップを参照、任意）
  edit: true                   # ファイル編集可否（必須）
  required_permission_mode: edit # 必要最小権限: edit / readonly / full（任意）
  session: refresh             # セッション管理: continue / refresh / compact（任意）
  pass_previous_response: true # 前の出力を渡すか（デフォルト: true）
  allowed_tools: [...]         # 許可ツール一覧（任意、参考情報）
  output_contracts: [...]      # 出力契約設定（任意）
  quality_gates: [...]         # agent step 用の品質 gate（文字列指示 / command gate、任意）
  rules: [...]                 # 遷移ルール（必須）
```

`session` は通常の agent step と parallel sub-step でのみ指定できる。`continue` は保存済み session を resume し、`refresh` は resume せず開始する。`compact` は保存済み persona session を resume したうえで Phase 1 前だけ provider の圧縮 capability を呼び出す。report phase / status phase 前には圧縮しない。圧縮 capability がない provider ではそのまま続行し、圧縮失敗時は warning を出して未圧縮 session で続行する。

複数ポリシー指定（配列）:

```yaml
- name: step-name
  policy: [coding, testing]
```

参照形式:

```yaml
- name: step-name
  instruction: implement
```

インライン形式:

```yaml
- name: step-name
  instruction: |
    指示内容...
```

**`instruction`**: セクションマップ → パス → 3-layer facet → インラインの順で解決する正式フィールド。`instruction_template` は受理されない。

### Parallel step（親 + `parallel`）

```yaml
- name: reviewers              # 親 step 名（必須）
  parallel:                    # 並列サブステップ配列（これがあると parallel step）
    - name: arch-review
      persona: architecture-reviewer
      policy: review
      knowledge: architecture
      edit: false
      instruction: review-arch
      output_contracts:
        report:
          - name: 05-architect-review.md
            format: architecture-review
      rules:
        - condition: "approved"
        - condition: "needs_fix"

    - name: testing-review
      persona: testing-reviewer
      policy: testing
      knowledge:
        - unit-testing
        - e2e-testing
      edit: false
      instruction: review-test
      rules:
        - condition: "approved"
        - condition: "needs_fix"

  rules:                       # 親の rules（aggregate 条件で遷移先を決定）
    - condition: all("approved")
      next: supervise
    - condition: any("needs_fix")
      next: fix
```

**重要**: サブステップの `rules` は結果分類のための condition 定義のみ。`next` は無視される（親の rules が遷移先を決定）。

### Team Leader step

```yaml
- name: implement
  team_leader:
    max_concurrency: 2
    initial_max_parts: 2
    fail_on_part_error: true
    refill_threshold: 0 # 互換キー。省略または 0 のみ
  instruction: implement
```

Team Leader はタスクを独立 part に分解する。`initial_max_parts` を指定した場合のみ初回 batch の part 数を制限し、未指定時は初回 part 数にも上限を設けない。`max_concurrency` は同時実行上限であり、全 batch 合計の上限はない。同一 batch の part は互いに独立でなければならず、実装結果を必要とする検証は全 part 完了後の後続 batch に置く。`fail_on_part_error: true` は回復 part 実行後も親 step を error にする。`refill_threshold` は逐次 refill と batch 障壁が両立しないため互換キーとして 0 のみ受理し、非0はロード時エラーになる。



## Rules 定義

```yaml
rules:
  - condition: 条件テキスト      # マッチ条件（必須）
    next: next-step             # 遷移先 step 名（必須、parallel 子では任意）
    requires_user_input: true   # ユーザー入力が必要（任意）
    interactive_only: true      # インタラクティブモードのみ（任意）
    appendix: |                 # 追加情報（任意）
      補足テキスト...
```

### Condition 記法

| 記法 | 説明 | 例 |
|-----|------|-----|
| 意味ラベル | status judge が一度だけ選択 | `approved` |
| `all("...")` | 全サブステップがマッチ（parallel 親のみ） | `all("approved")` |
| `any("...")` | いずれかがマッチ（parallel 親のみ） | `any("needs_fix")` |
| `all("X", "Y")` | 位置対応で全マッチ（parallel 親のみ） | `all("問題なし", "テスト成功")` |

rule は YAML 順の first-match で評価する。workflow rule では `ai(...)` と `when:` 別名を使わない。どの rule も成立しない場合は `rule_no_match` で ABORT する。

### 特殊な next 値

| 値 | 意味 |
|---|------|
| `COMPLETE` | workflow 成功終了 |
| `ABORT` | workflow 失敗終了 |
| step 名 | 指定された step に遷移 |

## Output Contracts 定義

Step の出力契約（レポート定義）。`output_contracts.report` 配列形式で指定する。

### 形式1: name + format（フォーマット参照）

```yaml
output_contracts:
  report:
    - name: 01-plan.md
      format: plan               # report_formats マップのキーを参照
```

`format` がキー文字列の場合、トップレベル `report_formats:` セクションから対応する .md ファイルを読み込み、出力契約指示として使用する。

### 形式1b: name + format（インライン）

```yaml
output_contracts:
  report:
    - name: 01-plan.md
      format: |                  # インラインでフォーマットを記述
        # レポートタイトル
        ## セクション
        {内容}
```

### 形式2: label + path（ラベル付きパス）

```yaml
output_contracts:
  report:
    - Summary: summary.md
    - Scope: 01-scope.md
    - Decisions: 02-decisions.md
```

各要素のキーがレポート種別名（ラベル）、値がファイル名。

## Quality Gates 定義

Step 完了時の品質 gate を定義する。文字列は AI への指示としてプロンプトに含まれる。`type: command` の object gate は step 完了後に worktree 内で機械実行され、exit code `0` の場合のみ成功する。workflow YAML の command gate は config 側の `workflow_command_gates.custom_scripts: true` が必要。失敗時は command metadata / cwd / exit code または timeout・output limit 情報 / 非公開 output log path が同じ step の差し戻し入力に含まれる。サニタイズ済み stdout / stderr はローカルの非公開ログだけに保存され、step への差し戻し入力には含まれない。

```yaml
quality_gates:
  - 全てのテストがパスすること
  - TypeScript の型エラーがないこと
  - ESLint 違反がないこと
  - type: command
    name: quality-check
    command: "./.takt/quality-gates/check.sh"
    cwd: "."
    timeout_ms: 300000
```

配列内で文字列 gate と command gate を混在できる。command gate が失敗した場合、後続 gate は実行されない。`quality_gates` は agent step 専用で、`system` / `workflow_call` step では指定できない。

## テンプレート変数

`instruction`（またはインストラクションファイル）内で使用可能な変数:

| 変数 | 説明 |
|-----|------|
| `{task}` | ユーザーのタスク入力（template に含まれない場合は自動追加） |
| `{previous_response}` | 前の step の出力（pass_previous_response: true 時、自動追加） |
| `{iteration}` | workflow 全体のイテレーション数 |
| `{max_steps}` | 最大イテレーション数 |
| `{step_iteration}` | この step の実行回数 |
| `{report_dir}` | レポートディレクトリ名 |
| `{report:ファイル名}` | 指定レポートファイルの内容を展開 |
| `{user_inputs}` | 蓄積されたユーザー入力 |
| `{cycle_count}` | loop_monitors 内で使用するサイクル回数 |

## Loop Monitors（任意）

```yaml
loop_monitors:
  - cycle: [step_a, step_b]           # 監視対象の step 名のサイクル
    ignore_steps: [verification]       # サイクル照合から除外する任意の中間 step
    threshold: 3                       # 発動閾値（サイクル回数）
    judge:
      persona: supervisor              # ペルソナキー参照
      instruction: |                   # 判定用指示
        サイクルが {cycle_count} 回繰り返されました。
        健全性を判断してください。
      rules:
        - condition: 健全（進捗あり）
          next: step_a
        - condition: 非生産的（改善なし）
          next: alternative_step
```

特定の step 間のサイクルが閾値に達した場合、judge が介入して遷移先を判断する。`ignore_steps` は任意回数の検証・再修正などを照合から除外する。`cycle` と同じ step は指定できない。

## allowed_tools について

`allowed_tools` は TAKT 本体のエージェントプロバイダーで使用されるフィールド。Skill 経由で実行する場合、実際に利用可能なツールはホスト側の設定（Claude Code の Task tool 設定や Codex のサンドボックス設定など）に従う。このフィールドは参考情報として扱い、`edit` フィールドの方を権限制御に使用する。
