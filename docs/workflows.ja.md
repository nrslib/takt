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

### 再利用可能な step fragment

`steps/` 直下の `<name>.yaml` または `<name>.yml` に step object をちょうど1つ定義し、`uses` で参照できます。`uses` は top-level の agent / `workflow_call` step、parallel parent、parallel sub-step で利用できます。loader が workflow schema 検証前に展開するため、runtime、doctor、preview は同じ通常 step として扱います。

```yaml
steps:
  - name: final-gate
    uses: final-gate
    rules:
      - condition: COMPLETE
        next: COMPLETE
```

例えば `.takt/steps/final-gate.yaml` は次のように定義できます。

```yaml
kind: workflow_call
call: merge-readiness-finding-contract-final-gate
```

`uses` を宣言する concrete workflow step は、parallel sub-step を含め、呼び出し側に空でない rule 定義を必ず持ちます。非 parallel fragment の呼び出し側は `rules` 配列を、parallel fragment の呼び出し側は次に示す rule tree を使います。fragment は root と parallel sub-step のどちらにも `rules` を定義できません。これにより、遷移先の step 名を知る workflow が routing を所有します。fragment から別 fragment を参照する中間 `uses` は、concrete workflow がその参照 chain を呼び出すまではこの必須条件の対象外です。loader は rule のコピー、継承、fallback の自動生成を行いません。

step fragment は root の `params` で必須の型付き facet parameter を宣言し、各 `uses` caller は `with` で値を束縛できます。宣言できる型は `facet_ref` / `facet_ref[]`、`facet_kind` は `policy` / `knowledge` / `instruction` / `report_format` で、default と optional parameter はありません。`{ $param: name }` を置けるのは `policy`、`knowledge`、`instruction`、`output_contracts.report[].format`、`workflow_call.args` の直接の値、または nested fragment caller の `with` だけです。nested fragment は lexical scope を使い、outer parameter を暗黙 capture できません。`with: { child_param: { $param: outer_param } }` と明示的に渡します。callable workflow parameter も同じ方法で渡せ、fragment 展開後に解決されます。resolver は未知・不足 binding、scalar/list 不一致、kind 不一致、未宣言参照、未対応 field の参照を拒否します。`params` と `with` は schema 検証前に消費され、`workflow_call` fragment 自身の `args` は保持・展開され、通常の caller overlay は parameter 展開後に適用されます。

fragment が parallel step に解決される場合、呼び出し側は通常の配列ではなく strict な rule tree を指定します。`self` に parallel parent の空でない rule 配列を、`parallel` に明示的かつ一意な全 final child 名と各 child の空でない rule 配列を定義します。workflow の parallel step は nested にできないため、child rule tree は無効です。全 child を過不足なく1回ずつ列挙する必要があり、不明な child は指定できません。loader は fragment の展開後に rule tree を適用し、schema 検証前に各 step の通常の `rules` 配列へ変換します。

```yaml
steps:
  - name: reviewers
    uses: reviewers
    rules:
      self:
        - condition: all("approved")
          next: COMPLETE
      parallel:
        architecture:
          - condition: approved
          - condition: needs_fix
        security:
          - condition: approved
          - condition: needs_fix
```

呼び出し側のフィールドが fragment を上書きします。object は deep merge、`parallel` などの配列は呼び出し側の配列全体で置換します。ただし、呼び出し側の rule tree は resolver 専用の routing overlay であり、fragment が所有する parallel 構造を置換しません。名前は呼び出し側の `name`、fragment の `name`、`uses` の末尾名の順に決まります。YAML key の記述順は runtime の動作に影響しませんが、例では可読性のため `name`、`uses`、その他の field、`rules` の順に記述します。fragment から別 fragment を参照できますが、循環参照は設定エラーです。bare name は project、global、言語別 builtin、共有 builtin の `steps/` を順に検索し、package workflow では package-local `steps/` が最優先です。各候補層では `.yaml` を `.yml` より先に最初の一致として採用し、nested bare 参照は親 fragment の解決元以降の候補層を検索します。workflow 全体で nested 展開は64段、参照は512個までで、各 fragment は1 MiB以下の読み取り可能な通常ファイルでなければなりません。不明な参照、不正な scoped 参照、object 以外のfragment、読み取り不能なファイル、循環参照、上限超過、絶対 path、traversal、ネストしたpath、symlink の `steps/` root、`steps/` root 外を指す symlink、解決後の `system` step は設定エラーになります。project trust の workflow は、project 外の fragment から `workflow_call` または `allow_git_commit: true` を受け取れません。fragment 由来の `allow_git_commit` は呼び出し側で明示的に `false` を指定して上書きできます。

`persona_name` は表示名専用です。config の `provider_routing.personas` は raw `persona` キーに一致し、`provider_routing.tags` は step の任意の `tags` 配列に書かれた順で一致します。同じ provider / model / provider_options leaf では後ろの tag が前の tag を上書きします。

`session_key` は通常の agent step、parallel sub-step、`loop_monitors.judge` で指定できます。system step、workflow-call step、parallel parent step では agent session を所有しないため指定できません。同じ persona を使う複数の agent step のセッションを分離したい場合、または別の agent step で意図的に同じセッションを共有したい場合に使います。実行時の有効キーは `session_key` に解決済み provider を付けた形になり、例: `shared-coder:claude` です。`session_key` を省略した場合は persona キー、persona が無い場合は step 名が使われます。空文字列と空白のみの値は workflow 検証で拒否されます。

`quality_gates` の文字列は従来どおり agent step の AI への完了条件としてプロンプトに含まれます。`type: command` の gate は agent step 完了後に worktree 内で実行され、終了コード `0` の場合のみ成功します。workflow YAML の command gate を使うには config 側で `workflow_command_gates.custom_scripts: true` を有効にする必要があります。失敗時は command のメタデータ、cwd、終了コードまたは timeout / output limit 情報、非公開 output log path が同じ agent step の差し戻し入力に含まれます。サニタイズ済み stdout / stderr はローカルの非公開ログだけに保存され、agent feedback には挿入されません。`system` と `workflow_call` step では `quality_gates` を指定できません。

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
| 意味ラベル | `approved` | status judge が重複排除したラベルを一度だけ選択 |
| 状態 predicate | `when(...)` | workflow state を決定的に評価 |
| 集約 | `all("X")` / `any("X")` | 並列サブ step の結果を集約 |
| 複合 | `approved && when(...)` | 選択ラベルと状態 predicate の両方を要求 |
| 集約 + 状態 | `all("X") && when(...)` / `any("X") && when(...)` | 集約結果と状態 predicate の両方を要求 |

rule は YAML 記述順で評価され、最初に成立した rule を採用します。condition 種別による暗黙の優先順位や fallback 遷移はありません。どの rule も成立しない場合、workflow は `rule_no_match` で ABORT します。

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

### Finding Contract reviewer 出力の normalization

Finding Contract reviewer は既定でnative structured outputを使います。
runtime configの`finding_contract.intake_normalize`により、解決済みreviewerの
provider/model完全一致を条件として、通常Markdownと隔離extractorを選択できます。

### Dynamic Parallel Step

`parallel` には、常時実行する `fixed` と selector が選ぶ `pool` を指定するオブジェクト形式も使えます。TAKT は step へ進入した時点で read-only の内部 selector を実行します。selector は workflow step ではなく、agent や workflow 定義を生成・変更できません。selector は read-only 権限、permission bypass 無効、MCP server 非継承、TAKT が所有する structured output contract で実行されます。

```yaml
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture-reviewer
          instruction: Review architecture
          rules: [{ condition: approved }]
      pool:
        - name: frontend
          persona: frontend-reviewer
          description: Review frontend and UI changes
          instruction: Review frontend
          rules: [{ condition: approved }]
        - name: backend
          persona: backend-reviewer
          description: Review API and persistence changes
          instruction: Review backend
          rules: [{ condition: approved }]
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
```

- `pool` は 1 件以上必要で、各候補には空でない `description` が必要です。
- `fixed` または `pool` の項目で `uses` を宣言する場合、`rules` はその呼び出し箇所に定義します。参照先 fragment には定義できません。
- `fixed` は必ず実行されます。selector は展開後の `pool` step 名だけを選べ、実行順は YAML の定義順です。
- `replace`（既定）は新しい round で以前の pool 選択を置き換えます。`cumulative` は過去の round で選んだ候補を維持します。
- 同じ round の resume は保存済み effective selection を復元し、selector を再実行しません。
- `all()` と `any()` は当該 round で実行する fixed と選択済み pool だけを集約します。固定位置に依存する aggregate 式は dynamic parallel では使えません。
- 不正な selector 出力、pool 外の ID、保存済み選択の不整合は fixed/pool agent の起動前に失敗します。全 pool を実行する fallback はありません。
- ロード時には、`pool` の未指定・空配列、pool の空 `description`、fragment 展開失敗、展開後の名前重複、agent sub-step 以外の fixed/pool、無効な `selection.mode`、または全候補が定義しない aggregate 結果ラベルを検出して実行前に失敗します。selector の provider 未解決・strict 出力不正、fixed と選択済み pool を結合した実行対象の空集合、resume 時の identity・保存 ID 不整合も reviewer 起動前に失敗します。
- selector には、タスク、現在の workflow-call scope で参照できるレポート、`HEAD` に対する現在の staged・unstaged・削除・未追跡変更、候補 ID と説明、`cumulative` の過去の選択、および初回か新しい round かを渡します。出力は `selected_ids` と `rationale` だけを持つ完了済み JSON object でなければならず、非配列・非文字列 ID・重複 ID・追加プロパティは拒否します。
- selector の証拠入力は、成功時には全文を含み、上限は UTF-8 byte 数で判定します。各 report と各変更 path の payload は 64 KiB 以下、変更 path は 1,024 件以下、各 Git path list は 1 MiB 以下、render 済み report と現在の diff の合計は 1 MiB 以下です。上限ちょうどは受理し、1 byte または 1 path でも超えると selector と全 participant の起動前に失敗します。`.takt/runs/` 配下は除外します。未追跡 symbolic link は link target の文字列だけを入力し、参照先を読みません。それ以外の非通常ファイルは拒否します。
- 現在の diff には run 開始前から存在する変更も含まれます。run 中に commit された変更は `HEAD` との差分ではなくなるため、後続の selector 入力へ残ることを保証しません。前段レポートは別の証拠として引き続き参照できます。正常な空差分は明示的に渡します。非 Git directory、Git command の取得失敗、または `HEAD` が存在しない repository は agent 起動前に失敗します。
- 保存する参加者 manifest のキーには workflow invocation path、workflow-call instance path、parallel step を含めます。report 継承と aggregate 評価はこの manifest を使用するため、`replace` により外れた reviewer の古い report や finding は現在 round に混入しません。

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

レポートはnormalizationより先に保存され、normalizerにはその1件のレポートだけが
toolなしの新規sessionで渡されます。

指定した値は Finding Manager の step レベル `provider` / `model` として扱われます。CLI と環境変数の明示 override は、これらより高い優先順位を維持します。manager の値は `provider_routing`、deprecated の `persona_providers.findings-manager`、effective auto routing、workflow/project/global fallback より優先されます。両方とも未指定の場合、manager は通常の workflow step provider/model 解決を維持します。`provider` だけを指定すると、下位優先度の model fallback は停止し、選択した provider 自身のデフォルトを使います。明示 model が必須の provider では検証エラーになります。

### Finding Contract の provisional finding と完了ゲート

すべての raw finding には必ず行き先が与えられます。台帳へ確定 finding として適用されるか、active conflict として記録されるか、**provisional finding** — 意味を確定できなかった観測を表す、`provisional` メタデータ付きの open な台帳エントリ — として保持されます（relation/target ラベリングの矛盾、reviewer 出力のハード上限超過、解釈の中断、保存時前提条件の失効、解釈予算の枯渇）。1件の不正な raw finding、Finding Manager の壊れた応答、解釈予算の超過が run を abort させることはありません。

provisional finding は final gate を塞ぎます。

- `when()` rule で `findings.provisional.count`（と `findings.provisional.items`）が使えます。builtin workflow は `findings.provisional.count > 0` を再計画（plan）ステップへルーティングします — provisional はコード変更で直せない system finding です。
- エンジンは最終不変条件を強制します: provisional finding が1件でも open な状態で `COMPLETE` へ遷移すると、workflow は fail-fast で abort します（abort 理由に provisional の id / kind / reason が列挙されます）。`finding_contract` を使う custom workflow は、`COMPLETE` の rule より前に `findings.provisional.count` でルーティングしてください。

provisional finding を確定・解消できるのは後続ラウンドの clean なレビュー証拠だけです。同じ claim の clean な再観測は確定 finding へ昇格させ、既存 finding への決定的な対応づけは resolved にします。「後のラウンドで言及されなかった」だけでは決して解消されず、waive / invalidate / supersede もできません。

open finding の各 item は、fixer instruction と `when()` の rule state の両方で `familyTags` を公開します。配列順に依存せず family でルーティングするには、`exists()` 内で `contains()` を使います。

```yaml
- condition: when(exists(findings.open.items, contains(item.familyTags, "provider-e2e")))
  next: fix
```

ledger が既に存在しない raw finding を参照している場合、その id は黙って破棄されたり ledger 全体を読めなくしたりせず、`unknownRawFindingIds` に公開されます。どちらの配列も重複排除・ソート済みで、`contains(item.unknownRawFindingIds, "raw-id")` も同じ包含構文を使います。

invalid・欠落した Finding Manager の判断は provisional finding として台帳へ着地し、run は継続します。`COMPLETE` の rule より*前*に `when(findings.provisional.count > 0 && findings.conflicts.count == 0)` を再計画ステップへ向ける rule を追加してください（配線の参考は builtin の `takt-default-high` workflow）。`finding_contract` を使う workflow が `findings.provisional` を一切参照していない場合、`takt workflow doctor` が警告します。

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
      initial_max_parts: 2
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

`max_concurrency` は同時に実行する独立した part 数を制御します。`initial_max_parts` は指定した場合に限り、最初の分解バッチの part 数を制限します。step 全体の part 総数に上限はなく、Team Leader が追加作業不要と判断するか、新しい一意な part を返さなくなるまで batch を追加します。scheduler は現在のバッチの part がすべて完了してから次のバッチを要求するため、同じバッチ内の part は相互に依存してはいけません。実装結果が必要な検証は後続 batch に置きます。`fail_on_part_error: true` の場合、生成された part が失敗した後でも Team Leader は新たな回復 part を計画・実行し得ます。その後、この step は error で終了します。未指定時は通常の回復フローに従います。旧名の `max_parts` は互換性のため `max_concurrency` として扱われます。`refill_threshold` は互換キーであり、省略または `0` のみ指定できます。batch 障壁と両立しないため、非0は workflow ロード時にエラーになります。`part_tags` は生成される part step の provider routing tag です。未指定時は親 step の `tags` を継承します。空文字や空白のみの tag は無効です。`part_tags` は通常の `provider_routing.tags` として解決されるため、`part_persona` による persona routing より優先されます。

`inspect_tools` は親 Team Leader のタスク分解フェーズだけで read-only inspection tools (`read`, `glob`, `grep`) を許可します。不正な tool 名は workflow ロード時にエラーになります。生成される子 part には影響せず、子 part の tool は引き続き `part_allowed_tools` で別に制御されます。inspection tools は Claude 系 provider や OpenCode など、`allowedTools` に対応する provider で利用できます。Team Leader inspection tools に対応しない provider では、実行時に明確なエラーになります。

Finding Contract の修正ステップでは `team_leader.mode: finding_contract_fix` を指定できます。この mode は有効な `finding_contract` を必須とし、各 part を actionable finding へ明示的に割り当てます。assignment の `readPaths` は調査対象の目安となる作業ディレクトリからのリテラルな相対パスであり、completion の `changedPaths` は worker が実際に変更したファイルの申告です。どちらにもワイルドカードの `*` と `?` は使えず、`[]` などその他の文字は展開されずパスの一部として扱われます。part の編集範囲は通常の part 権限に従い、複数 part の変更が重なった場合は Team Leader が次の decision で後続の repair または verify part を計画し、最終状態を確認します。bounded index の `omittedPartCount` またはいずれかの `omittedChangedPathCount` が1以上なら `complete` にせず、後続の集約した repair または verify part で最終状態を確認します。Team Leader は過去の raw 応答を累積せず、最新 batch 全体で上限を設けた raw excerpt・engine 検証済みの finding 単位 claim digest と、過去 batch における finding ごとの最新 digest から `continue`、`complete`、`replan` を判断します。`complete` にはステップ開始時の全 actionable finding を覆う `fixCoverage` と成功した検証が必要です。これは reviewer へ引き渡せるという step-local な判断であり、ledger の finding を解決するのは引き続き Finding Manager です。遷移は `when(structured.fix.decision == "complete")` のような機械条件で定義します。

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

エントリは宣言順に評価され、**最後にマッチしたものが採用**されます。promotion は step レベルの `provider` / `model` / `provider_options` より優先されますが、明示的な CLI・環境変数による provider / model override の方が上位です。

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
| `provider_options.claude.skills.enabled` | `false` | `claude-sdk`、`claude`、`claude-terminal` の Claude filesystem Skill 探索を有効化する（[configuration ガイド](./configuration.ja.md#claude-skill-の継承-skills) 参照） |
| `provider_options.opencode.allowed_tools` | - | OpenCode のツール許可リスト。ツール名は `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch` のように lowercase |
| `provider_options.opencode.variant` | - | OpenCode の model variant。プロバイダー / model 固有の文字列としてパススルー |
| `provider_options.codex.base_url` | - | Codex SDK constructor option 用の OpenAI 互換 base URL（[configuration ガイド](./configuration.ja.md#provider-base-url-base_url) 参照） |
| `provider_options.codex.network_access` | - | Codex サンドボックスからのネットワークアクセスを許可（[configuration ガイド](./configuration.ja.md#ネットワークアクセス-network_access) 参照） |
| `provider_options.codex.skills.repo` | `false` | 実行 CWD から repository root までの `.agents/skills` にある Codex Skill を継承（[configuration ガイド](./configuration.ja.md#codex-skill-の継承-skills) 参照） |
| `provider_options.codex.skills.user` | `false` | user scope の Codex Skill を継承（[configuration ガイド](./configuration.ja.md#codex-skill-の継承-skills) 参照） |
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

`node` / `gradle` プリセットはキャッシュと一時ディレクトリを分離しますが、ランタイムのインストールやバージョン選択は行いません。カスタムスクリプトは `KEY=value` または `export KEY=value` を標準出力へ書くことで、`PATH` を含む環境変数を後続の provider 実行へ渡せます。

`runtime.prepare` を設定しても、タスク範囲のコード変更では解消できない環境要因により必須の検証を実行できない場合、組み込みの supervise workflow は `BLOCKED` として中断します。検証不能を実装不具合として修正ループへ戻しません。

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
  callable: true
  visibility: internal
  requires_finding_contract: true
  params:
    impl_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
```

子が継承した `findings.*` 状態や Finding Contract 用出力形式を使う場合、または同じ要件を持つ別のサブワークフローへ委譲する場合は、`requires_finding_contract: true` を指定します。直近の呼出元は `finding_contract` を宣言するか、さらに上位の呼出元へ同じ要件を宣言する必要があります。連鎖内の各子は独自の台帳を作らず、契約所有元と同じ契約・台帳を使用します。

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
