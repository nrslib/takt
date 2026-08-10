# Workflow ガイド

[English](./workflows.md)

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

section map は任意です。facet は bare name で直接参照できます（`personas` マップの項目がなくても `persona: coder` と書けます）。bare name は project `.takt/facets/<type>/` → global `~/.takt/facets/<type>/` → 同梱の `builtins/{lang}/facets/<type>/` の優先順で解決されます。section map が必要になるのは、カスタムエイリアスや明示的なファイルパスを使いたい場合だけです。

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

step fragment は root の `params` で必須の型付き parameter を宣言し、各 `uses` caller は `with` で値を束縛できます。facet parameter は `type: facet_ref` / `facet_ref[]` と、`policy` / `knowledge` / `instruction` / `persona` / `report_format` のいずれかの `facet_kind` を指定します。workflow の呼び出し先を表す parameter は `type: workflow_ref` とし、`facet_kind` は指定しません。dynamic facet pool 名を受け取る fragment は `facet_pool_ref` を `facet_kind` なしで指定できます。companion parameter は現在 callable workflow のみが対応し、step fragment の `params` では対応しません。fragment 自体には空でない companion の固定指定を置けます。fragment では default と optional parameter は利用できません。

`{ $param: name }` は宣言と対応する step fragment の `policy`、`knowledge`、`persona`、`instruction`、`output_contracts.report[].format`、`workflow_call.call`、`dynamic_facets.pool`、または callable workflow の通常 agent step の `companion` に配置します。`companion_ref[]` は固定 companion 名の配列へ展開されます。空配列の場合は `companion` フィールド自体を省略し、残存する未引用の `companion.*` state 参照を拒否します。したがって、空の raw `companion` や不正な companion 依存 route を許可せずに、generic wrapper の companion なし挙動を維持できます。指定した companion 名は通常の companion 定義解決でロード時に検証され、未知の参照は fail-fast します。`facet_ref` / `facet_ref[]` parameter は `policy` / `knowledge` の配列要素として固定参照と混在でき、配列値は順序を保ってその位置へ展開されます。空の `facet_ref[]` は要素を追加しません。`facet_pool_ref` は policy や knowledge facet ではなく、呼び出される callable workflow のトップレベル `facet_pools` map にある pool 名の scalar です。callable workflow parameter は `workflow_call.args` の直接の値として渡せます。step fragment の `with` で渡せるのは上記の fragment parameter 型です。nested fragment は lexical scope を使い、outer parameter を暗黙 capture できません。`with: { child_param: { $param: outer_param } }` と明示的に渡します。callable workflow parameter も同じ方法で渡せ、fragment 展開後に解決されます。resolver は未知・不足 binding、scalar/list 不一致、kind 不一致、未宣言参照、未対応 field の参照を拒否します。`params` と `with` は schema 検証前に消費され、`workflow_call` fragment 自身の `args` は保持・展開され、通常の caller overlay は parameter 展開後に適用されます。

fragment が parallel step に解決される場合、呼び出し側は通常の配列ではなく strict な rule tree を指定します。`self` に parallel parent の空でない rule 配列を、`parallel` に明示的かつ一意な全 final child 名と各 child の空でない rule 配列を定義します。workflow の parallel step は nested にできないため、child rule tree は無効です。全 child を過不足なく1回ずつ列挙する必要があり、不明な child は指定できません。loader は fragment の展開後に rule tree を適用し、schema 検証前に各 step の通常の `rules` 配列へ変換します。

例えば callable workflow は、step 定義を複製せず、fragment が使う実装 pool を child-local に差し替えられます。

```yaml
subworkflow:
  callable: true
  params:
    implementation_pool:
      type: facet_pool_ref
      default: coding-facets

facet_pools:
  coding-facets:
    candidates:
      - id: backend
        description: バックエンド変更を扱う
        knowledge: backend

steps:
  - name: implement
    uses: implementation-step
    with:
      implementation_pool:
        $param: implementation_pool
    dynamic_facets:
      pool:
        $param: implementation_pool
```

`facet_pool_ref` の引数と default は、callable child が宣言した pool 名の scalar でなければなりません。必須引数の未設定、配列値、未知の pool 名、`dynamic_facets.pool` の未解決・未宣言 `$param` は agent や selector の起動前にロードエラーになります。別 pool や全候補への暗黙 fallback はありません。

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

呼び出し側のフィールドが fragment を上書きします。object は deep merge、`parallel` などの配列は呼び出し側の配列全体で置換します。ただし、呼び出し側の rule tree は resolver 専用の routing overlay であり、fragment が所有する parallel 構造を置換しません。名前は呼び出し側の `name`、fragment の `name`、`uses` の末尾名の順に決まります。YAML key の記述順は runtime の動作に影響しませんが、例では可読性のため `name`、`uses`、その他の field、`rules` の順に記述します。fragment から別 fragment を参照できますが、循環参照は設定エラーです。bare name は project、global、選択言語の builtin `steps/` を順に検索し、package workflow では package-local `steps/` が最優先です。各候補層では `.yaml` を `.yml` より先に最初の一致として採用し、nested bare 参照は親 fragment の解決元以降の候補層を検索します。workflow 全体で nested 展開は64段、参照は512個までで、各 fragment は1 MiB以下の読み取り可能な通常ファイルでなければなりません。不明な参照、不正な scoped 参照、object 以外のfragment、読み取り不能なファイル、循環参照、上限超過、絶対 path、traversal、ネストしたpath、symlink の `steps/` root、`steps/` root 外を指す symlink、解決後の `system` step は設定エラーになります。project trust の workflow は、project 外の fragment から `workflow_call` または `allow_git_commit: true` を受け取れません。fragment 由来の `allow_git_commit` は呼び出し側で明示的に `false` を指定して上書きできます。

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
| `{review_scope}` | TAKT が算出した、このタスクの変更ファイル一覧 |

`{review_scope}` は実行の由来によって対象が変わります。

- 作業ツリー計算（常に行われます）: base コミット以降のコミット済み変更、未コミット変更、未追跡ファイル（ignored を除く）の和集合。タスクの変更が既にブランチへコミット済みで working tree 差分が空になる構成でも一覧に出ます
- PR 由来の実行（`takt --pr N` 等で PR context を持つ実行）: 上の作業ツリー計算に PR の diff range `base...head` を**加えた**和集合になります。`--pr` は PR のレビューコメントを取り込んで修正するフローで、同じ実行の中で作業ツリーが変わるため、両方を対象にします。diff range がローカルに用意されていない場合はその旨を述べ、ローカル変更だけを一覧にします

Finding Contract の証拠検証は上の作業ツリー計算と同じ結果を使います。PR diff range の合成はレビュアーへの指示注入だけの拡張で、証拠検証側には入りません（証拠検証は cwd の実体に対する byte-exact 照合のため）。

作業ディレクトリが Git リポジトリでない場合や変更が検出されない場合も、その事実を述べる文言に解決されます（空文字にはなりません）。ファイル数が 200 件を超える場合は残件数を明示して打ち切ります。組み込みの汎用レビュアーは partial `instructions/review-round-scope` 経由でこの変数を自動的に受け取ります。

base コミットは `refs/takt/pr-base/<branch>` → `refs/takt/base/<branch>` → 検出した default branch の順で最初に存在する ref との merge-base、およびブランチ reflog の分岐点から、より新しい方を採ります。既存ブランチをそのまま clone した resume 実行のように、どの base ref も残らず reflog も分岐点を持たない環境では base を特定できず、コミット済み変更が一覧から外れます。その場合はその旨が文言に明示されます。

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

### ルールフィールド: `interactive_only`

`interactive_only: true` を指定した rule は interactive 実行時にのみ評価対象になります。非 interactive 実行（`--pipeline` や `takt run` など）では、その rule は宣言されていないものとしてスキップされ、残りの rule で評価が続行されます。ユーザー入力を待つ遷移など、人間の介在が必要な遷移に使用します。

## Step タイプ

TAKT は Normal / Parallel / Dynamic Parallel / Arpeggio / Team Leader / Workflow Call / System の 7 種類の step をサポートしています。必要な構造に応じて使い分けます。

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
- 親 step には任意の `concurrency: <N>`（最小 1）を指定でき、同時実行するサブ step 数を制限できます。未指定時は全サブ step が同時に開始します

### Finding Contract reviewer 出力の normalization

経路は1本だけで、Finding Contract の reviewer は全員そこを通ります。reviewer は常に
通常の Markdown レビュー報告だけを書き（JSON も構造化出力契約も持ちません）、正規化係の
単発呼び出しがその報告を raw findings へ変換します。格上げ再レビューも同じ1本道です。
どのモデルが構造化契約を守れるかを宣言する仕組みはありません。reviewer に構造化契約を
持たせないからです。

コスト特性は「レビュアー×ラウンドごとに正規化1呼び出し」です。reviewer 自身のフェーズに
加えて毎ラウンド固定でかかる費用であり、失敗後に発生する追加費用ではありません。

3つの役割は別々の判断を持ちます。**reviewer は観察専任**です。何が・どこで・なぜ壊れて
いるかと、証拠として引用できる場所だけを、報告の `## Finding Contract Claims` 節へ
ラベル付きフィールド（Target files / Description / Evidence）で書きます。severity・
title・問題系列タグ・台帳 relation は書きません。**正規化係**はその観察を抽出し、
`severity`・`title`・`familyTag` の分類を claim の内容から付与します。捏造が禁止されるのは
観測事実（path、行範囲、引用、finding ID、lifecycle 判定）であり、この分類は対象外です。
publication には `classificationAuthority: intake-normalizer` が記録されるので、台帳の
severity を誰が付けたのかを後から追えます。**findings-manager** は台帳と照らして同一性を
裁定します（新規か、open な指摘の再主張か、解消の確認か）。したがって intake 契約が
reviewer に要求するのは観察の実質——claim 本文・対象・提示された証拠——だけで、severity や
タグの欠落が言い直しの差し戻し理由になることはありません。

正規化係の provider/model は、runtime.yaml の
`provider.targets.internal_agents['intake-normalizer']` seat → reviewer の profile が宣言する
`escalate` 先 → 通常の既定解決、の順で決まります。「通常の既定解決」は `findings-manager` と
同じ優先度ティアであり、`provider_routing` は従来どおり効きます。CLI や環境変数の明示 override は
他のステップと同じくこれらより上位です。先頭の候補は isolated structured execution に対応して
いる必要があり、対応していない場合は黙って続行せずその理由を示して停止します。ワークフローの
読み込みと `takt workflow doctor` も、agent を1つも起動する前にその構成を拒否します。

正規化係がラウンド唯一の関門になったため、失敗は原因で切り分けます。

**正規化係の出力側**に原因がある場合（スキーマ不成立、`rawExcerpt` と `candidate` の間で
claim を失う等）で、既存の訂正1回でも直らないときは、TAKT は同じ解決チェーンの**次の候補**
——すでに使った候補と `(provider, model)` が異なり、かつ isolated structured execution に
対応する最初のもの——で正規化をもう一度だけ実行します。やり直しはこの1回だけで、エンジン側
スキーマの不備は別 provider でやり直しません。それでも失敗した場合は、候補ごとの具体的な
理由（どの item がどの検証に落ちたか）をメッセージに含めて停止します。

**報告側**に原因がある場合、ランは止まりません。markdown の契約を無視したレビュアー——たとえば
報告本文そのものを JSON で出力したレビュアー——の抽出結果は、自分の報告本文に byte-exact で
見つからない引用になります。どの正規化係が読んでも同じ結論になるので、TAKT はそのレビュアーの
`protocol-anomaly` として台帳へ記録します。anomaly には報告本文を claim 抜粋として持たせ、
「通常の markdown 散文で書き直せ」という是正指示を添えて、既存の言い直し経路へ載せます。その
ラウンドのそのレビュアーからは台帳へ何も届きませんが、ラウンド自体は `review_budget` に計上され、
同じラウンドの他のレビュアーには影響しません。

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
- プロセスの resume は保存済みの選択を復元せず、現在の pool に対して selector を再実行します。
- `all()` と `any()` は当該 round で実行する fixed と選択済み pool だけを集約します。固定位置に依存する aggregate 式は dynamic parallel では使えません。
- 不正な selector 出力や pool 外の ID は fixed/pool agent の起動前に失敗します。全 pool を実行する fallback はありません。
- ロード時には、`pool` の未指定・空配列、pool の空 `description`、fragment 展開失敗、展開後の名前重複、agent sub-step 以外の fixed/pool、無効な `selection.mode`、または全候補が定義しない aggregate 結果ラベルを検出して実行前に失敗します。selector の provider 未解決・strict 出力不正、fixed と選択済み pool を結合した実行対象の空集合も reviewer 起動前に失敗します。削除された dynamic selection fields を含む resume point はサポートしません。
- selector には、タスク、現在の workflow-call scope で参照できるレポート、`HEAD` に対する現在の staged・unstaged・削除・未追跡変更、候補 ID と説明、`cumulative` の過去の選択、および初回か新しい round かを渡します。出力は `selected_ids` と `rationale` だけを持つ完了済み JSON object でなければならず、非配列・非文字列 ID・重複 ID・追加プロパティは拒否します。
- selector の証拠入力は、成功時には全文を含み、上限は UTF-8 byte 数で判定します。各 report と各変更 path の payload は 64 KiB 以下、変更 path は 1,024 件以下、各 Git path list は 1 MiB 以下、render 済み report と現在の diff の合計は 1 MiB 以下です。上限ちょうどは受理し、1 byte または 1 path でも超えると selector と全 participant の起動前に失敗します。`.takt/runs/` 配下は除外します。未追跡 symbolic link は link target の文字列だけを入力し、参照先を読みません。それ以外の非通常ファイルは拒否します。
- 現在の diff には run 開始前から存在する変更も含まれます。run 中に commit された変更は `HEAD` との差分ではなくなるため、後続の selector 入力へ残ることを保証しません。前段レポートは別の証拠として引き続き参照できます。正常な空差分は明示的に渡します。非 Git directory、Git command の取得失敗、または `HEAD` が存在しない repository は agent 起動前に失敗します。
- 保存する参加者 manifest のキーには workflow invocation path、workflow-call instance path、parallel step を含めます。report 継承と aggregate 評価はこの manifest を使用するため、`replace` により外れた reviewer の古い report や finding は現在 round に混入しません。

### Dynamic Facet Selection（facet pool）

通常の agent step は、main agent の起動直前に、検証済み候補 pool から追加の `policy` / `knowledge` facet を動的に選択できます。step が既に宣言している固定 facet は維持したまま、現在の状況が必要とする facet だけを追加します。例えば、レビューで transaction 境界の懸念が指摘された後にだけ transaction-correctness policy を選ぶ、といった運用が可能です。

pool はトップレベルの `facet_pools` map に定義し、step から `dynamic_facets` で参照します。pool は workflow 内に inline で定義するか、外部 resource ファイルとして定義できます。

`dynamic_facets.max_selected` は任意です。指定した場合は選択数の上限として扱い、省略した場合は pool の全候補数まで選択できます。selector の失敗時に全候補へ自動 fallback する挙動ではありません。

`dynamic_facets.pool` には、callable workflow が `type: facet_pool_ref` で宣言した parameter を `{ $param: implementation_pool }` として指定することもできます。値は通常の dynamic facet 検証前に解決されるため、その callable workflow の `facet_pools` map に存在する pool を指定する必要があります。未設定、scalar 以外、未知、未展開の値は agent や selector の起動前に fail-fast します。

#### inline pool

inline pool は workflow YAML 内に直接記述します。候補の `policy` / `knowledge` 参照は、通常の step と同じ workflow-local facet namespace で解決します。workflow の `policies` / `knowledge` section map による alias と、通常の bare facet lookup の両方が使えます。

```yaml
name: backend-fix

policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md

knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

facet_pools:
  fix:
    candidates:
      - id: backend
        description: API、repository、server-side 実装を扱う
        knowledge: backend-api
      - id: transaction
        description: transaction 境界、rollback、排他制御を扱う
        policy: transaction-correctness
        knowledge: database-transaction
      - id: backward-compatibility
        description: 公開 API や schema の互換性を維持する
        policy: backward-compatibility

steps:
  - name: fix
    persona: coder
    policy: [coding, testing]
    knowledge: architecture
    dynamic_facets:
      pool: fix
      max_selected: 4
    instruction: fix
    edit: true
    rules:
      - condition: 修正が完了した
        next: review
```

#### external pool

workflow は inline 定義の代わりに `uses` で名前付き外部 pool resource を参照できます。外部 pool は自己完結しており、候補の facet 参照は pool ファイル自身の `policies` / `knowledge` section map のみで解決し、相対 path は pool ファイル基準です。外部 pool は caller workflow の同名 alias を暗黙に capture せず、caller から pool の候補や section map を merge/override できません。

```yaml
facet_pools:
  fix:
    uses: implementation-fix

steps:
  - name: fix
    persona: coder
    policy: [coding, testing]
    knowledge: architecture
    dynamic_facets:
      pool: fix
      max_selected: 4
    instruction: fix
    edit: true
    rules:
      - condition: 修正が完了した
        next: review
```

参照先 `facet-pools/implementation-fix.yaml` は1つの pool resource を定義します。

```yaml
policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md

knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

candidates:
  - id: backend
    description: API、repository、server-side 実装を扱う
    knowledge: backend-api
  - id: transaction
    description: transaction 境界、rollback、排他制御を扱う
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: 公開 API や schema の互換性を維持する
    policy: backward-compatibility
```

外部 pool ファイルは nested `uses`、`params`、`$param` を受け付けません。1つの pool entry で `uses` と inline の `policies` / `knowledge` / `candidates` を混在させるとロード時に失敗します。

#### 外部 pool の探索

名前付き pool は step fragment と同じ階層で探索します。

1. package-local `facet-pools/`（repertoire package 由来の workflow の場合）
2. project `.takt/facet-pools/`
3. global `$TAKT_CONFIG_DIR/facet-pools/`
4. 言語固有 builtin `builtins/<lang>/facet-pools/`
5. 共有 builtin `builtins/facet-pools/`

bare name は各層で `<name>.yaml` を `<name>.yml` より優先して最初の一致を採用します。`@owner/repo/name` で repertoire package を明示できます。絶対 path、directory traversal、nested path、root 外 symlink、非通常ファイル、読み取り不能、size 上限超過を拒否します。provenance と依存 resource は `doctor`、`preview`、`eject`、`repertoire install` / `remove` で追跡できるように保持します。

#### candidate 契約

pool 内の全候補は同じ形を持ちます。

```yaml
- id: transaction
  description: transaction 境界と rollback を扱う
  policy:
    - transaction-correctness
  knowledge:
    - database-transaction
```

- `id` は pool 内で空でなく一意です。
- `description` は空でない文字列です。
- `policy` と `knowledge` は scalar または空でない配列です。
- `policy` または `knowledge` の少なくとも一方が必須です。
- 候補は単一 facet または小さな facet bundle を表せます。
- selector は複数候補を選択できます。
- 空選択は「追加 facet 不要」として正常です。
- 同一 pool 内の全候補は任意に組み合わせ可能とするのが pool author の契約です。`requires`、`conflicts_with`、排他 group は MVP では導入しません。

#### selector 契約

`dynamic_facets` を持つ step へ進入したとき、TAKT は main agent 起動前に内部の read-only selector を実行します。selector は workflow step ではなく、agent や workflow 定義を生成・変更できず、read-only 権限、permission bypass 無効、MCP server 非継承、TAKT が所有する structured output contract で fresh session で実行します。

selector には少なくとも次を渡します。

- ユーザー要求
- leaf workflow、workflow-call instance、step の identity
- 初回進入か再進入か、および step iteration
- 現在の workflow-call scope から参照できる前段 report
- 未解決 finding
- タスク開始時点からの累積差分
- 候補 ID と description

facet 本文は selector に渡しません。selector は厳格な structured output schema（`additionalProperties: false`、`selected_ids` は pool の候補 ID を `enum` とする unique array、加えて必須の `rationale` 文字列）に対して候補 ID と理由だけを返します。pool 外 ID、重複 ID、指定した `max_selected` の超過は拒否します。selector 失敗時は main agent を起動せず fail-fast し、全候補や空選択への暗黙 fallback はありません。selector 自身を dynamic facet selection や auto routing の対象にしません。

selector provider は #1136 の `runtime.yaml` の `provider.targets.internal_agents.selector` で解決します。未指定時は runtime の通常 default を使います。

#### facet 合成

固定 facet は既存の step fields に残します。実効 facet は次の通りです。

```text
effective policy   = fixed policy   + selected dynamic policy
effective knowledge = fixed knowledge + selected dynamic knowledge
```

- 固定 facet を先に、dynamic facet を後に配置します。
- dynamic 側は selector 返却順ではなく pool の候補定義順で合成します。
- 候補内では facet 記述順を維持します。
- 同じ解決済み facet resource を複数回参照した場合は重複除去し、固定側を優先します。内容が偶然一致する別 resource は同一 facet としては扱いません。
- security、privacy boundary、認可、必須品質条件など、AI 判断で外してはいけない facet は固定側に置きます。
- dynamic facet から persona、instruction、provider、permission、MCP、tool、output contract を変更できません。

#### round、session、resume

同じ step への再進入を新しい round として扱い、毎回 selector を再実行して前回の dynamic 選択を置き換えます。累積 mode はありません。

```text
round 1: frontend を選択
round 2: transaction を選択

round 2 effective facets:
  fixed + transaction
```

round 1 の frontend facet は round 2 に残りません。

- dynamic facet を使う main agent session は round ごとに分離します。
- プロセスの resume は空の run-local 選択状態から始まり、現在の facet pool に対して selector を再実行します。中断のない同一 run のメモリ状態だけを保持します。
- 新しい workflow 遷移として step へ再到達した場合は新しい round として再選択します。
- selector 結果と解決済み実効 facet 集合は main agent 起動前に runtime state へ渡します。
- ロード時に inline/external pool を同じ `ResolvedFacetPool` へ正規化するため、実行層は inline/external を区別しません。外部 pool ファイルを実行中に再読込しません。

MVP では実行途中の facet hot swap を行いません。必要領域が変わった場合は、次に同じ step に再到達した時点で再選択します。

#### Fail-fast 条件

ロード時に次のいずれかが成立すると実行前に失敗します。

- `facet_pools` の schema 不整合
- pool が空
- candidate ID の重複
- candidate の description 欠落
- `policy` と `knowledge` 両方がない candidate
- 未知の facet 参照または kind 不一致
- `uses` と inline fields の混在
- 外部 pool から caller workflow facet namespace への暗黙参照
- 外部 pool での nested `uses`、`params`、`$param`
- 外部 resource の探索、trust、file validation 違反
- `dynamic_facets.pool` が未知
- 指定した `max_selected` が不正または候補数を超える
- 通常 agent step 以外への `dynamic_facets` 指定

selector 実行時に次のいずれかが成立すると main agent 起動前に失敗します。

- selector provider を解決できない
- structured output が不成立
- `selected_ids` が配列でない
- 非文字列、重複、未知 ID
- 指定した `max_selected` の超過

暗黙 fallback はありません。

#### package、eject、authoring tool

- repertoire package で `facet-pools/` を install/remove でき、package-local / scoped pool は step fragment と同じ探索順で解決します。
- `takt workflow eject` は参照している外部 pool とその pool が所有する facet 依存を、既存 eject 契約の衝突処理と既存ユーザーファイル優先に従ってコピーします。
- `takt workflow doctor` は pool、candidate、facet 参照を検証します。
- `takt workflow preview` は dynamic pool 名、候補 ID、参照 facet、source を表示します。
- builtin の ja/en pool を提供する場合、候補 ID 集合を一致させます。

### Finding Contract 合成ロールの provider/model

workflow に provider や model の名前は書きません。`finding_contract.manager` と
`finding_contract.adjudicator` は `provider` / `model` フィールドを受け付けず、strict スキーマなので
書き残しはロード時に拒否されます。宛先は `runtime.yaml` の `internal_agents` seat で指名します。

```yaml
# runtime.yaml
provider:
  profiles:
    strong: { provider: codex, model: gpt-5.5 }
  targets:
    internal_agents:
      findings-manager:     { profile: strong }
      terminal-adjudicator: { profile: strong }
      loop-judge:           { profile: strong }
      escalation-reviewer:  { profile: strong }
      intake-normalizer:    { profile: strong }
```

レポートはnormalizationより先に保存され、normalizerにはその1件のレポートだけが
toolなしの新規sessionで渡されます。

**seat の指定はすべて任意です。** 未指定の seat は、そのロールが従来から使ってきた既定解決
（persona routing → workflow → project → global → provider 既定。正規化係ではレビュアー
profile の `escalate` 連鎖も含む）へそのまま落ちます。指定した seat はそのロールの
step レベル `provider` / `model` として扱われ、`provider_routing`、deprecated の
`persona_providers`、effective auto routing、workflow/project/global fallback より優先されます。
CLI と環境変数の明示 override はそれより高い優先順位を維持します。provider だけを指名した seat は
下位優先度の model fallback を止めるため、provider と model が食い違う組み合わせにはなりません。

`escalation-reviewer` seat だけは**宛先しか決めません**。格上げ再レビューは従来どおり、
レビュアーが解決された profile が `escalate` を宣言している場合にだけ発火します。seat を置いても、
格上げ先を持たないレビュアーの最終提示が本人から離れることはありません。

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

### conflict の裁定と接地再裁定

active conflict はまずエンジン合成の `finding-conflict-adjudication` step へ入ります。裁定結果が
`verification_undetermined` のとき、エンジンはその conflict についてそのラウンドに1回だけ、同じ
`terminal-adjudicator` seat、persona 解決、provider 予算、lease 経路で接地再裁定を行います。
workflow の step や新しい role は追加しません。

再裁定の prompt には immutable な review-scope snapshot から作った bounded window を添付します。
window は争点の finding の `target.paths` と file-quote evidence の行アンカーから構成し、
`evidence-search` と同じ digest 束縛の窓機構を使います。裁定者はその窓だけを根拠にし、live な作業
ツリーへ戻る fallback はありません。provider call の予約は呼び出し前に永続化するため、crash / replay
時も同じ attempt を再開し、重複呼び出しを発行しません。2回目も `verification_undetermined` なら
そのラウンドを未確定として確定し、元のレビューステップへ戻ります。

裁定 prompt の履歴参照は直近3件を本文として残し、それ以前は件数と digest に縮約します。
これにより異議対応の関係を判断できる参照を残しながら、入力サイズを有界に保ちます。

再裁定の snapshot identity には、争点の `target.paths` について review-scope capture が取得した
現在内容の digest も含まれます。台帳の射影が同じでも fix によって対象コードの digest が変われば、
新しい snapshot として再裁定できます。逆に対象コードも台帳射影も変わらない場合は再裁定しません。
非 regular file は例外です。安定した通常ファイル内容 digest を取得できないため、capture ごとに常に変化扱いとなり、fresh snapshot を追加して再裁定できます。ただし再裁定回数と workflow の上限による有限性は維持されます。
未確定かつコード無変化の反復では stop budget は進まないため、loop monitor または workflow の
`max_steps` が有限停止を担います。

conflict の ladder は `findings.rounds.budgetExhausted == false` の間、active conflict を fix / 再レビュー
ループへ戻さなければなりません。最後の `when(findings.conflicts.count > 0)` → `ABORT` は予算枯渇後だけの
出口であり、予算付きのループ rule より後ろに置きます。

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

`merge.strategy` は `concat`（デフォルト）または `custom` です。`concat` は各行の結果を任意の `separator` で連結し、`inline_js` と `file` は指定できません。`custom` は `inline_js`（インラインの JavaScript merge 関数）か `file`（merge スクリプトへのパス）のどちらかが必須です。どちらも指定しない `custom`、および `inline_js` / `file` を伴う `concat` は workflow ロード時にエラーになります。

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

`team_leader.persona` は、リーダー agent 自身の persona を任意で指定します（step の persona と同じ方法で解決され、provider routing の persona キーとしても使われます）。未指定時は step 自身の `persona` が適用されます。

`max_concurrency` は同時に実行する独立した part 数を制御します。`max_concurrency` と互換キーの `max_parts` はどちらも上限 `3` で、超える値は workflow ロード時にエラーになります。どちらも未指定の場合のデフォルトは `3` です。`initial_max_parts` は指定した場合に限り、最初の分解バッチの part 数を制限します。step 全体の part 総数に上限はなく、Team Leader が追加作業不要と判断するか、新しい一意な part を返さなくなるまで batch を追加します。scheduler は現在のバッチの part がすべて完了してから次のバッチを要求するため、同じバッチ内の part は相互に依存してはいけません。実装結果が必要な検証は後続 batch に置きます。`fail_on_part_error: true` の場合、生成された part が失敗した後でも Team Leader は新たな回復 part を計画・実行し得ます。その後、この step は error で終了します。未指定時は通常の回復フローに従います。旧名の `max_parts` は互換性のため `max_concurrency` として扱われます。`refill_threshold` は互換キーであり、省略または `0` のみ指定できます。batch 障壁と両立しないため、非0は workflow ロード時にエラーになります。`part_tags` は生成される part step の provider routing tag です。未指定時は親 step の `tags` を継承します。空文字や空白のみの tag は無効です。`part_tags` は通常の `provider_routing.tags` として解決されるため、`part_persona` による persona routing より優先されます。

`inspect_tools` は親 Team Leader のタスク分解フェーズだけで read-only inspection tools (`read`, `glob`, `grep`) を許可します。不正な tool 名は workflow ロード時にエラーになります。生成される子 part には影響せず、子 part の tool は引き続き `part_allowed_tools` で別に制御されます。inspection tools は Claude 系 provider や OpenCode など、`allowedTools` に対応する provider で利用できます。Team Leader inspection tools に対応しない provider では、実行時に明確なエラーになります。

Finding Contract の修正ステップでは `team_leader.mode: finding_contract_fix` を指定できます。この mode は有効な `finding_contract` を必須とし、各 part を actionable finding へ明示的に割り当てます。assignment の `readPaths` は調査対象の目安となる作業ディレクトリからのリテラルな相対パスであり、completion の `changedPaths` は worker が実際に変更したファイルの申告です。どちらにもワイルドカードの `*` と `?` は使えず、`[]` などその他の文字は展開されずパスの一部として扱われます。part の編集範囲は通常の part 権限に従い、複数 part の変更が重なった場合は Team Leader が次の decision で後続の repair または verify part を計画し、最終状態を確認します。bounded index の `omittedPartCount` またはいずれかの `omittedChangedPathCount` が1以上なら `complete` にせず、後続の集約した repair または verify part で最終状態を確認します。Team Leader は過去の raw 応答を累積せず、最新 batch 全体で上限を設けた raw excerpt・engine 検証済みの finding 単位 claim digest と、過去 batch における finding ごとの最新 digest から `continue`、`complete`、`replan` を判断します。`complete` にはステップ開始時の全 actionable finding を覆う `fixCoverage` と成功した検証が必要です。これは reviewer へ引き渡せるという step-local な判断であり、ledger の finding を解決するのは引き続き Finding Manager です。遷移は `when(structured.fix.decision == "complete")` のような機械条件で定義します。

### Workflow Call Step（サブワークフロー）

step が別の workflow を名前で呼び出します。子 workflow は同じ run の中で実行され、結果は親の `rules` でルーティングされます。

```yaml
  - name: peer-review
    kind: workflow_call
    call: peer-review
    args:
      impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

呼ばれる側の workflow は `subworkflow.params` を宣言することで、親から `args` 経由で `impl_knowledge` や `fix_knowledge` などの値を受け取って動作を変えられます。step 定義の重複を避けられます。`subworkflow` の宣言については [Workflow レベルの設定](#workflow-レベルの設定) を参照してください。

`workflow_call` の rules に書けるのは `COMPLETE`、`ABORT`、または子が宣言する semantic return label だけです。子 workflow は `subworkflow.returns` にラベルを列挙し（例: `returns: [approved, needs_fix]`、予約結果の `COMPLETE` / `ABORT` は列挙できません）、子 step の rule は `next:` の代わりに `return:` でラベルを返してサブワークフローを終了します。親の rules は上の例の `approved` / `needs_fix` のように、そのラベルでルーティングします。

`workflow_call` step は `overrides` を宣言して、子 workflow の step に適用する provider 設定を変更できます。`provider` / `model` / `provider_options` の少なくとも 1 つが必須で、`provider_options` には provider 固有の option を 1 つ以上含める必要があります。

```yaml
  - name: peer-review
    kind: workflow_call
    call: peer-review
    overrides:
      provider: codex
      model: gpt-5.5
    rules:
      - condition: COMPLETE
        next: COMPLETE
```

`max_steps` はルート workflow が所有し、すべての子孫で共有する予算です。`workflow_call` は制御ノードなので予算を消費せず、自身の provider / model も選択しません。iteration を消費するのは子 workflow 内の実行可能な step だけです。たとえば `plan → workflow_call(implement → review) → supervise` は4 iterationを消費するため、`implement` と `review` を callable workflow へ抽出しても `max_steps` を増やす必要はありません。nested call でも同じです。call lifecycle は invocation 番号と完全な call stack を伴って session log と trace から引き続き確認できます。

`workflow_call` step には、facet 参照ではない実行コンテキストを scalar の `vars` として指定することもできます。文字列、有限数、真偽値が nested workflow call の子孫まで継承され、下位の呼び出しが同じ key を宣言した場合はその値で上書きされます。agent の instruction facet では `{var:name}` で参照します。値がない場合は `unspecified` になるため、instruction 側で安全な fallback を明示できます。

```yaml
- name: follow-up-review
  kind: workflow_call
  call: peer-review-suite
  vars:
    review_mode: follow_up
  rules:
    - condition: COMPLETE
      next: COMPLETE
```

### System Step

system step は TAKT エンジン自身が実行する step で、agent は起動しません。`kind: system`（または短縮形の `mode: system`。両方の宣言は設定エラー）で宣言します。system step には `persona`、`instruction`、`provider`、`structured_output`、`output_contracts`、`quality_gates` などの agent 用フィールドを宣言できません。完全なスキーマは `src/core/models/workflow-system-schemas.ts` を参照してください。builtin の `auto-improvement-loop` workflow（`builtins/ja/workflows/auto-improvement-loop.yaml`）が参考実装で、system step と planner agent step だけで PR 対応・Issue 駆動計画・新規改善計画の間をルーティングします。

`system_inputs` はエンジンが提供するコンテキストを読み取り、各エントリを `as` で名前に束縛します。利用できる type は `task_context`、`branch_context`、`pr_context`、`issue_context`、`task_queue_context`、`pr_list`、`pr_selection`、`issue_list`、`issue_selection` です（`pr_list` / `pr_selection` は `where` フィルタを受け取り、両者の `where` は一致している必要があります）。binding 名は step 内で一意でなければなりません。束縛した値は `context.<step>.<binding>...` として `when()` rule を駆動し、後続の agent instruction からは `{context:step.binding.field}` で参照できます。

```yaml
  - name: route_context
    mode: system
    system_inputs:
      - type: task_queue_context
        source: current_project
        as: active_queue
        exclude_current_task: true
      - type: pr_selection
        source: current_project
        as: selected_pr
    rules:
      - condition: when(context.route_context.active_queue.pending_count > 0)
        next: wait_before_next_scan
      - condition: when(context.route_context.selected_pr.exists == true)
        next: plan_from_existing_pr
```

`effects` はエンジン側のアクションを実行します: `enqueue_task`、`comment_pr`、`sync_with_root`、`resolve_conflicts_with_ai`、`merge_pr`、`close_pr`。各 effect type は 1 step につき最大 1 回しか書けず、結果は `when(effect.<step>.<type>.<field>)` でルーティングします。

```yaml
  - name: prepare_merge
    mode: system
    effects:
      - type: sync_with_root
        pr: "{context:route_context.selected_pr.number}"
    rules:
      - condition: when(effect.prepare_merge.sync_with_root.success == true)
        next: merge_pr
      - condition: when(effect.prepare_merge.sync_with_root.conflicted == true)
        next: resolve_conflicts
```

`delay_before_ms` は step 実行前に指定ミリ秒だけ待機します。builtin workflow の `wait_before_next_scan` のようなポーリングループに便利です。

system step は agent step の `structured_output` と組み合わせて使います。agent step は `structured_output: { schema_ref: <name> }` を宣言し、`<name>` はトップレベルの `schemas:` マップを参照します。検証済みの出力は rule から `when(structured.<step>.<field> ...)` で、effect からは `{structured:step.field}` で参照できます。`structured_output` 自体は agent step のフィールドであり、system step には宣言できません。

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

# 複数レポート
output_contracts:
  report:
    - name: 01-scope.md
      format: scope
    - name: 02-decisions.md
      format: decisions
```

各レポートエントリには `name` と `format` が必須です。任意フィールドが2つあります。

- `use_judge`（デフォルト `true`）— そのレポートを Phase 3 のステータス判定に入力するかどうか。書き出すだけで判定の根拠にしないレポートには `use_judge: false` を指定します。rules の判定が必要な step では、少なくとも 1 件の `use_judge` レポートを残す必要があります。
- `order` — report format facet への参照（`format` と同じ方法で解決）で、その内容が Phase 2 のデフォルトのレポート作成指示を置き換えます。format テンプレートだけでは足りない、レポート作成手順のカスタム指示が必要なときに使います。

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
| `description` | - | 自由記述の step 説明。dynamic parallel の `pool` 項目では選択用の説明として使われ、必須になる |
| `persona` | - | persona キー（section map、または bare 名で project → user → builtin の順に解決）またはファイルパス |
| `persona_name` | - | ログやプロンプト用の表示名。`provider_routing.personas` には影響しない |
| `session_key` | - | 通常の agent step と parallel sub-step の明示セッションキー。実行時キーには解決済み provider が付く。空文字・空白のみは無効 |
| `session` | `continue` | 通常の agent step と parallel sub-step のセッション扱い。`continue` は保存済み persona session を resume し、`refresh` は resume せず開始し、`compact` は resume 後に Phase 1 前だけ provider へ圧縮を依頼する。report phase / status phase 前には圧縮しない。圧縮 capability がない provider ではそのまま続行し、圧縮失敗時も warning を出して未圧縮 session で続行する |
| `requires_user_input` | `false` | 通常の agent step がユーザー入力待ち可能であることを示す。system step、workflow-call step、parallel parent step では指定不可。`requires_user_input: true` の step は agent 実行前から interactive mode と user input handler が必須で、未設定の場合はその agent を実行せず workflow を abort する。実際の入力待ちは、一致した rule 側の `requires_user_input: true` でのみ発生する |
| `tags` | - | config の `provider_routing.tags` に一致させる順序付き routing tag |
| `policy` | - | policy キーまたはキー配列（section map、または bare 名で project → user → builtin の順に解決） |
| `knowledge` | - | knowledge キーまたはキー配列（section map、または bare 名で project → user → builtin の順に解決） |
| `instruction` | - | instruction キー（section map、または bare 名で project → user → builtin の順に解決） |
| `edit` | - | step がプロジェクトファイルを編集できるか (`true` / `false`) |
| `companion` | - | 通常の agent step と並行して隔離された read-only reviewer を実行（[Companion レビュアー](#companion-レビュアー)参照） |
| `pass_previous_response` | `true` | 前の step の出力を `{previous_response}` に渡す |
| `provider_options.claude.allowed_tools` | - | step または workflow に対する Claude ツール許可リスト |
| `provider_options.claude.base_url` | - | `claude` / `claude-sdk` 用の Anthropic 互換 base URL（[configuration ガイド](./configuration.ja.md#provider-base-url-base_url) 参照） |
| `provider_options.claude.effort` | - | Claude の provider 固有 reasoning effort 文字列。TAKT は値を provider へそのまま渡す（例: `low`、`high`、将来 provider が定義する値） |
| `provider_options.claude.skills.enabled` | `false` | `claude-sdk`、`claude`、`claude-terminal` の Claude filesystem Skill 探索を有効化する（[configuration ガイド](./configuration.ja.md#claude-skill-の継承-skills) 参照） |
| `provider_options.opencode.allowed_tools` | - | OpenCode のツール許可リスト。ツール名は `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch` のように lowercase |
| `provider_options.opencode.variant` | - | OpenCode の model variant。プロバイダー / model 固有の文字列としてパススルー |
| `provider_options.opencode.guards` | `standard` / 60分 | OpenCode の guard profile、先勝ちの `model_profiles`、call wall-clock、text/reasoning byte 上限（[configuration ガイド](./configuration.ja.md#opencode-実行ガード)参照） |
| `provider_options.codex.base_url` | - | Codex SDK constructor option 用の OpenAI 互換 base URL（[configuration ガイド](./configuration.ja.md#provider-base-url-base_url) 参照） |
| `provider_options.codex.network_access` | - | Codex サンドボックスからのネットワークアクセスを許可（[configuration ガイド](./configuration.ja.md#ネットワークアクセス-network_access) 参照） |
| `provider_options.codex.reasoning_effort` | - | Codex の provider 固有 reasoning effort 文字列。TAKT は値を provider へそのまま渡す |
| `provider_options.codex.skills.repo` | `false` | 実行 CWD から repository root までの `.agents/skills` にある Codex Skill を継承（[configuration ガイド](./configuration.ja.md#codex-skill-の継承-skills) 参照） |
| `provider_options.codex.skills.user` | `false` | user scope の Codex Skill を継承（[configuration ガイド](./configuration.ja.md#codex-skill-の継承-skills) 参照） |
| `provider_options.copilot.effort` | - | Copilot の provider 固有 reasoning effort 文字列。TAKT は値を provider へそのまま渡す |
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

### `max_steps`

run 全体の iteration 予算です。正の整数か、無限ループとして動かす workflow（builtin の `auto-improvement-loop` など）向けの `infinite` を指定します。予算はルート workflow が所有し、そこから呼ばれるすべての workflow で共有されます。callable なサブワークフローは独自の `max_steps` を宣言できません。

```yaml
max_steps: infinite
```

### `schemas`

`structured_output.schema_ref` のキーを structured output スキーマ名に対応づけるマップです。各名前は project `.takt/schemas/`、`~/.takt/schemas/`、同梱の `schemas/` ディレクトリの順で `<name>.json` に解決されます。マップにない `schema_ref` はそのままスキーマ名として使われます。

```yaml
schemas:
  followup-task: followup-task
  pr-followup-task: pr-followup-task
```

### `auto_routing`

workflow レベルの自動 provider ルーティングです。AI の `router`（provider + model）が step ごとに provider/model の `candidate` を選択します。`candidates` に選択可能な provider/model エントリを宣言し、`candidate_pools` で pool ごとの `fallback` 付きにグループ化し、`default_pool` でより特異的な一致がない場合の pool を指定し、`pool_rules` / `rules` で step の `tags`、`steps`（step 名）、`personas` ごとに pool や candidate を固定できます。rule は宣言済みの candidate / pool を参照する必要があり、未知の名前は検証エラーになります。

### `finding_contract`

workflow の Finding Contract を宣言します（実行時のセマンティクスは前述の Finding Contract 各節を参照）。`ledger_path`、`raw_findings_path`、`manager` は必須です。`manager` は `persona`、`instruction`、`output_contract` が必須で、`policy` / `knowledge` の追加は任意です。`manager` も `adjudicator` も `provider` / `model` フィールドは受け付けません（runtime.yaml の `findings-manager` / `terminal-adjudicator` seat で指名します）。任意の予算として `stop_budget`（`max_rounds`、デフォルト 40。`max_minutes` は未指定時は時間上限なし）と `review_budget`（`max_review_rounds`）を指定できます。

```yaml
finding_contract:
  ledger_path: .takt/findings/review.json
  raw_findings_path: .takt/findings/review/raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
  stop_budget:
    max_rounds: 40
```

### レビュアーの差し戻し（言い直し slot）

レビュアー由来の未決着（言い直し待ちの intake anomaly、および protocol-anomaly /
verdict-claims-mismatch のように後続の完全レビュー成立でしか決着しない anomaly）は、
**次のレビューラウンドへ回さず、同じラウンド内でそのレビュアーへ直接差し戻します**。
workflow YAML には何も現れません（step ではありません）。

- 発火点は「レビューラウンドの findings-manager 取り込みが終わった直後」です。対象の
  anomaly を持つレビュアーごとに、そのレビュアーの persona / policy / knowledge /
  MCP サーバ / report 形式を継承した合成ステップで provider call を1回発行します。
- 1回の差し戻しは「呼び出し → 正規化 → manager 取り込み」で1パスです。まだ言い直し待ちが
  残っていれば同じラウンド内で次のパスへ進み、提示予算（`presentationLimit` =
  `review_budget.max_review_rounds`）の範囲で反復します。提示は従来の
  「次ラウンドでの提示」と同じく `presentedReviewerAnomalyIds` へ計上されますが、
  slot のパスは `review_budget` / `stop_budget` のラウンドとしては数えません —
  レビューラウンドの内側の差し戻しであって新しいレビューラウンドではないためです。
- 言い直し要求は**1呼び出しあたり10件まで**です。超過分は同じラウンドの次のパスへ回ります。
- 照合ゲートが要求する claim 本文を選べない観測（description も抜粋も持たない）は、
  言い直し要求を作りません。どう答えても受理されないためです。この anomaly は提示を
  1回も行わずに kind `undemandable_claim_atom` でその場で終端します。outcome は
  observationClass に従い、`claim-bearing` なら `review_integrity_unresolved`、
  `protocol-noise` なら `non_claim_observation_rejected` です。どちらでも以後ゲートを
  塞ぎません。
- 終端経路の整理: intake anomaly は「言い直しの照合成立による昇格」「提示予算の枯渇」
  「言い直しで要求できる claim 本文が無い」のいずれかで終端します。後続の完全レビュー
  成立による取り下げ（withdrawal）が終端になるのは、言い直し予算を持たない非 intake
  anomaly（protocol-anomaly / verdict-claims-mismatch など）だけです。
- 後続の完全レビュー成立でしか決着しない anomaly を持つレビュアーには、言い直し専用では
  なく**完全な再レビュー**を発行します。レビュアー自身の指示文とツール集合をそのまま使い、
  言い直し要求があれば「レビューに加えてこれにも答える」形で同じ呼び出しに同梱します。この枠は
  1ラウンドにつきレビュアーごと1回までで、以降のパスは言い直し専用へ格下げされます。
  取り下げの根拠になるのは完全な再レビューだけで、言い直し専用の呼び出しは根拠になりません。
- 「この anomaly を言い直した」と申告した主張が照合ゲートを通らなかった場合、新規の
  product finding は作りません。当該 anomaly への再試行として記録します。
- 言い直し提示数が `presentationLimit` に達した claim-bearing anomaly は、終端処分の
  直前に **evidence-search を1 anomaly につき生涯1回だけ**実行します。エンジンが
  `target.paths` の実ファイルを読み、ファイルが大きい場合は主張された行範囲の周辺窓に
  絞り、元の claim・提示履歴とともに既存の isolated structured 正規化係へ渡します。
  正規化係にはツールを与えず、解決順も `intake-normalizer` seat → `escalate` → 既定値の
  既存チェーンを使います。
- evidence-search は新しい workflow step ではありません。正規化係が返す候補は既存の
  `evidenceRequests` として通常の evidence issuer / byte-exact 照合を通り、成立したとき
  だけ既存の昇格経路へ入り、anomaly の台帳へ `promotionOrigin: evidence-search` を記録
  します。候補なし、照合不一致、対象不一致は従来どおり
  `restatement_exhausted_claim_bearing` です。
- evidence-search の呼び出しと manager 取り込みは slot と同じく `budget-excluded` で、
  提示予算を増やしません。publication を先に永続化するため、中断・再開でも同じ anomaly
  に2回目を発火しません。

`withdrawn_by_subsequent_review` は「その anomaly を出したレビュアーが後続の完全な
レビューを成立させた」ことによる決着であって、元の観測の当否を判定したものではありません。
同じ検証不能な主張を出し続けるレビュアーでは、毎ラウンド「前の episode を取り下げて
同じ stable key の新しい episode を記録する」循環になります。これは意図した読み方です —
台帳は全 episode を監査記録として残し、未決着はつねに1件で、循環は review-integrity 予算が
有界にします。主張が受理されたという意味ではありません。

### 格上げ再レビュー（`escalate`）

各 intake anomaly の**最後の1回**の言い直し提示（`review_budget.max_review_rounds` から決まる `presentationLimit` と同じ ordinal の提示）を、元のレビュアーへもう一度返す代わりに、より強いモデルへ回せます。workflow 側に設定は必要ありません。レビュアーが `escalate` を宣言した `runtime.yaml` の profile へ解決されたときに有効になり、格上げ先モデルはその `escalate` が指す profile です。

```yaml
# runtime.yaml
provider:
  profiles:
    reviewer-local:
      provider: opencode
      model: ollama-cloud/gemma4:31b
      escalate: strong
    strong:
      provider: opencode
      model: ollama-cloud/glm-5.2
  targets:
    steps:
      peer-review/architecture-review:
        profile: reviewer-local
```

- 格上げレビュアーは owner レビュアーの完全な代打です。persona / policy / knowledge / MCP サーバ / report 形式を、その回に実際に走った step のもの（動的に選択された facet を含む）からそのまま継承し、変わるのはモデル（`escalate` 先）と指示文だけです。指示文は通常のレビュー手順ではなく、エンジンが持つ「言い直しのみ」の契約になります。専用の persona facet も workflow 設定ブロックもありません。
- persona を owner と共有する帰結として、格上げの主張は lifecycle 上 **owner のレビュアー識別**を引き継ぎます（別人の新規観測として着地せず、owner の finding lifecycle を継続します）。異なるのは publication identity だけです（reviewer キー `escalation-reviewer` と owner 別の report 名）。
- workflow の step では**ありません**。言い直し slot の最終枠として、`findings-manager` や terminal adjudication と同じくエンジンが合成して直接 provider call を発行し、その出力を通常の取り込み経路（正規化、canonical publication、byte 一致検証、昇格の対応づけ）へ流します。
- 同じパスで複数のレビュアーが最終提示に到達した場合、エンジンは owner ごとに request をまとめ、owner ごとに1回ずつ呼び出します。1回の格上げ呼び出しが持つ persona と report 形式は常に1レビュアー分だけです。
- reviewer キーはどの格上げ呼び出しでも固定文字列 `escalation-reviewer` です。この値が raw finding の `reviewer` と publication identity になります。owner は anomaly の `presentationOwnerReviewer` と言い直しの対応づけを通じて保持されます。レポートは owner とパスごとに `escalation-reviewer-<owner-step>-<pass>.md` として出力されます（言い直し slot の owner 宛呼び出しは `followup-<owner-step>-<pass>.md`）。
- Phase 1 は読み取り専用で動きます。格上げレビュアーはリポジトリを自分で読んで byte 一致の引用を作れますが、書き込みはできません。
- Finding Contract workflow では `escalation-reviewer` は常に**予約 step 名**です。同名の step（parallel sub-step を含む）を持つ workflow は読み込みに失敗します。
- `presentationLimit == 1` の場合、最初で最後の1回がそのまま格上げ提示になります。profile に `escalate` が無いレビュアーは、最後の1回も従来どおり元のレビュアーへ戻ります。
- 格上げレビューが publication 成立前に失敗した場合は何も計上せず、次の機会に同じ escalation request を再発行します。有限停止は提示予算と workflow の `max_steps` が保証します。

### `interactive_mode`

`takt` を引数なしで起動したときのデフォルト interactive mode。`assistant`（デフォルト） / `grill-me` / `passthrough` / `quiet` / `persona` のいずれか。`grill-me` は推奨案付きの質問を1問ずつ行い、要件が固まると `/go` を案内する。

```yaml
interactive_mode: assistant
```

### `workflow_config.provider` / `workflow_config.model`

workflow 全体のデフォルト provider と model です。解決順では step レベルの `provider` / `model`、routing、CLI・環境変数 override より下位で、project / global config のデフォルトより上位です。

```yaml
workflow_config:
  provider: claude-sdk
  model: opus
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
    extends: readonly

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

### `capabilities`

`capabilities` は、step の能力（ツール許可リスト・network access・sandbox・skills）を与える provider-options プリセットを1つ以上名前で参照します。`provider_options` の参照専用形で、値はプリセット名（または名前のリスト）のみで、inline の options block は書けません。受理されるのは能力 leaf（`allowed_tools` / `network_access` / `sandbox` / `skills`）だけで、品質系・マシン固有系の leaf（`effort`、`base_url`、`guards` など）を含むプリセットはロード時に fail fast します。それらは `runtime.yaml` に置きます。

このキーは workflow トップレベル（全 step の既定）、step、parallel サブステップの3箇所に書けます。step 自身の `capabilities` は workflow 既定とマージせず置換します。リストは左から右へマージされ、同じ leaf を宣言している場合は後の名前が勝ちます。

```yaml
capabilities: readonly

steps:
  - name: implement
    capabilities: [edit, enable-skills]
```

プリセットの解決は `provider_options.extends` と同一です（project → global → builtins、repertoire package スコープ対応）。同梱プリセットは `readonly`（読み取り・検索・シェル・Web 検索 + network access）、`edit`（`readonly` + ファイルの作成・編集）、`enable-skills`（Codex の repo/user skills）です。未解決の名前は fail fast します。`system` / `workflow_call` step は `capabilities` を拒否します。


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
    ignore_steps: [verify]
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

`ignore_steps` はサイクル照合から中間 step を除外します。任意回数の検証・再修正 step を含む論理サイクルを監視するときに使用します。`cycle` に含む step と同じ step は指定できません。

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
      default: []
    supervisor_persona:
      type: facet_ref
      facet_kind: persona
      default: supervisor
    reviewer_suite:
      type: workflow_ref
      default: peer-review-suite-base
```

builtin callable workflow では、call tree 全体の予算を root workflow が所有するため `max_steps` を省略します。同じ実装に直接実行の入口も必要な場合は standalone の root wrapper に `max_steps` を指定し、callable child は `workflow_call` から呼び出す設計にします。

callable workflow の facet parameter は `facet_ref` / `facet_ref[]` と、`policy` / `knowledge` / `instruction` / `persona` / `report_format` の5種の `facet_kind` を使います。呼び出す callable workflow を表す `workflow_ref` parameter には `facet_kind` を指定せず、`call: { $param: reviewer_suite }` の形で利用できます。`facet_pool_ref` parameter も `facet_kind` を指定せず、callable child のトップレベル `facet_pools` map にある pool 名の scalar を表します。`dynamic_facets.pool: { $param: implementation_pool }` の形で使用できます。`companion_ref[]` parameter も `facet_kind` を指定せず、`companion: { $param: implementation_companions }` の形で通常の agent step の固定 companion 配列を表します。空配列は `companion` を省略し、残存する未引用の `companion.*` state 参照を拒否します。literal な空 companion は許可しません。default は省略可能です。`facet_ref[]` の引数と default には空配列を指定でき、任意の追加 facet を表現できます。`policy` / `knowledge` では固定参照と scalar/list parameter を混在でき、list parameter は field の記載順を保ってその位置へ平坦化されます。`facet_pool_ref` の必須引数未設定、配列などの型不一致、child-local でない pool、未展開 `$param` は実行前に fail-fast し、暗黙の pool fallback はありません。`companion_ref[]` の配列以外の引数、未宣言参照、未知の companion 定義も実行前に fail-fast します。parameter は `workflow_call.args` を通じてさらに下位へ渡すこともできます。

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

## Companion レビュアー

通常の agent step に `companion` を指定すると、実装エージェントの編集と並行して、ステートレスかつ read-only のレビュアーが動きます。名前配列は固定レビュアーの短縮形です。object 形式では固定レビュアー、step 開始時に1回だけ選抜する pool、任意の moderator を組み合わせられます。同時実行は最大3名です。

```yaml
- name: implement
  persona: coder
  companion:
    fixed: [security-reviewer]
    pool: [design-reviewer, frontend-reviewer]
    moderator: adjudicator
  rules:
    - condition: implementation complete
      next: final-review
```

定義 YAML は `.takt/companions/`、`~/.takt/companions/`、`builtins/{language}/companions/` の順で解決されます。指定できるのは `name`、`description`、facet 参照（`persona`、`policy`、`knowledge`、`instruction`）、`interval_ms` だけで、provider やツール設定は指定できません。`interval_ms` は `2,147,483,647` 以下の正整数である必要があります。

TAKT は変更系 tool event を観測し、静穏時間または強制発火時間の経過後に累積差分をレビューします。実装エージェントの完了時には未レビュー変更を確認し、残っている場合だけレビューします。新しい完了レビューが不要でも、実行中・待機中のレビューを中断または待機してから完了します。指摘は `.takt/runs/{run}/companion/{step}/{companion}.jsonl` へ追記されます。各 companion の JSONL ファイルは実装エージェント向けの読取専用projectionであり、独立した transaction boundary です。そのファイルへの追記成功後にだけ cache、finding の採番、finding event が確定します。1ラウンドで複数 companion を更新する場合、後続 mailbox の失敗によって、すでに確定した先行 mailbox を rollbackせず、再試行では未完了の mailbox 更新だけを再開します。projection の外部変更は拒否され、engine が所有する finding 状態には反映されません。post-execution condition の評価前に、エンジンは同じ session の fix loop で open の `must_fix` を解消します。loop judge が修正継続不能として escalate した場合は、理由と未解消指摘を証拠として通常の post-execution condition 判定へ進みます。completion review 自体を検証できない場合、または未解消の `must_fix` が escalation なしで残る場合は step を blocked とし、condition へ進みません。その他の companion 障害は本体を fail-soft として扱い、workflow または step の中断時は companion も停止します。

## ベストプラクティス

1. **イテレーション数を妥当に保つ** — 開発系 workflow では 10〜30 程度が一般的
2. **レビュー step では `edit: false`** — レビュアーがコードを変更しないようにする
3. **わかりやすい step 名を使う** — ログが読みやすくなる
4. **workflow は段階的にテストする** — 単純な構成から始めて複雑化する
5. **`/eject` でカスタマイズする** — ゼロから書くよりビルトイン workflow をコピーして編集する方が確実
