# ワークフローYAML スキーマリファレンス

このドキュメントは workflow YAML（旧称ピースYAML）の構造を定義する。具体的な workflow 定義は含まない。

## トップレベルフィールド

```yaml
name: workflow-name           # workflow 名（必須）。カテゴリの workflow_categories 下の workflows でもこの名前を使う（互換: piece_categories / pieces）
description: 説明テキスト      # 任意
max_movements: 10            # 最大イテレーション数（省略時デフォルトあり）
initial_step: plan            # 最初に実行する step 名（省略時は steps の先頭）

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

**互換 alias:** `movements` は `steps` と同義（両方書く場合は内容が一致している必要がある）。`initial_movement` は `initial_step` と同義（両方書く場合は同じ名前である必要がある）。

### セクションマップの解決

各セクションマップのパスは **workflow YAML ファイルのディレクトリからの相対パス** で解決する。
step 定義内では**キー名**で参照する（パスを直接書かない）。

例: workflow が `{スキルルート}/workflows/coding.yaml` にあり、`personas:` セクションに `coder: ../personas/coder.md` がある場合
→ 絶対パスは `{スキルルート}/personas/coder.md`（`スキルルート` は Claude Code では `~/.claude/skills/takt`、Codex では `~/.agents/skills/takt` など、インストール先に応じて置き換える）
→ step では `persona: coder` で参照

## Step 定義（`steps` の各要素）

### 通常の step

```yaml
- name: step-name              # step 名（必須、workflow 内で一意）
  persona: coder               # ペルソナキー（personas マップを参照、任意）
  policy: coding               # ポリシーキー（policies マップを参照、任意）
  instruction: implement       # 指示（instructions マップのキー参照、またはインライン、任意）
  knowledge: architecture      # ナレッジキー（knowledge マップを参照、任意）
  edit: true                   # ファイル編集可否（必須）
  required_permission_mode: edit # 必要最小権限: edit / readonly / full（任意）
  session: refresh             # セッション管理（任意）
  pass_previous_response: true # 前の出力を渡すか（デフォルト: true）
  allowed_tools: [...]         # 許可ツール一覧（任意、参考情報）
  output_contracts: [...]      # 出力契約設定（任意）
  quality_gates: [...]         # 品質ゲート（AIへの指示、任意）
  rules: [...]                 # 遷移ルール（必須）
```

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

**`instruction`（正式） / `instruction_template`（deprecated）**: どちらも同じ参照解決ルート（セクションマップ → パス → 3-layer facet → インライン）を使う。`instruction_template` も互換のため受理されるが、新規定義では `instruction` を使う。

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

    - name: qa-review
      persona: qa-reviewer
      policy: review
      edit: false
      instruction: review-qa
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
| 文字列 | AI判定またはタグで照合 | `"タスク完了"` |
| `ai("...")` | AI が出力に対して条件を評価 | `ai("コードに問題がある")` |
| `all("...")` | 全サブステップがマッチ（parallel 親のみ） | `all("approved")` |
| `any("...")` | いずれかがマッチ（parallel 親のみ） | `any("needs_fix")` |
| `all("X", "Y")` | 位置対応で全マッチ（parallel 親のみ） | `all("問題なし", "テスト成功")` |

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

Step 完了時の品質要件を AI への指示として定義する。自動検証は行わない。

```yaml
quality_gates:
  - 全てのテストがパスすること
  - TypeScript の型エラーがないこと
  - ESLint 違反がないこと
```

配列で複数の品質基準を指定できる。エージェントはこれらの基準を満たしてから step を完了する必要がある。

## テンプレート変数

`instruction`（またはインストラクションファイル）内で使用可能な変数:

| 変数 | 説明 |
|-----|------|
| `{task}` | ユーザーのタスク入力（template に含まれない場合は自動追加） |
| `{previous_response}` | 前の step の出力（pass_previous_response: true 時、自動追加） |
| `{iteration}` | workflow 全体のイテレーション数 |
| `{max_movements}` | 最大イテレーション数（テンプレート変数名は従来どおり） |
| `{movement_iteration}` | この step の実行回数（テンプレート変数名は従来どおり） |
| `{report_dir}` | レポートディレクトリ名 |
| `{report:ファイル名}` | 指定レポートファイルの内容を展開 |
| `{user_inputs}` | 蓄積されたユーザー入力 |
| `{cycle_count}` | loop_monitors 内で使用するサイクル回数 |

## Loop Monitors（任意）

```yaml
loop_monitors:
  - cycle: [step_a, step_b]           # 監視対象の step 名のサイクル
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

特定の step 間のサイクルが閾値に達した場合、judge が介入して遷移先を判断する。

## allowed_tools について

`allowed_tools` は TAKT 本体のエージェントプロバイダーで使用されるフィールド。Skill 経由で実行する場合、実際に利用可能なツールはホスト側の設定（Claude Code の Task tool 設定や Codex のサンドボックス設定など）に従う。このフィールドは参考情報として扱い、`edit` フィールドの方を権限制御に使用する。
