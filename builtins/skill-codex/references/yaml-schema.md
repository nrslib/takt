# ピースYAML スキーマリファレンス

このドキュメントはピースYAMLの構造を定義する。具体的なピース定義は含まない。

## トップレベルフィールド

```yaml
name: piece-name              # ピース名（必須）
description: 説明テキスト      # ピースの説明（任意）
max_movements: 10            # 最大イテレーション数（必須）
initial_movement: plan        # 最初に実行する movement 名（必須）

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

movements: [...]              # movement 定義の配列（必須）
loop_monitors: [...]          # ループ監視設定（任意）
```

### セクションマップの解決

各セクションマップのパスは **ピースYAMLファイルのディレクトリからの相対パス** で解決する。
movement 内では**キー名**で参照する（パスを直接書かない）。

例: ピースが `~/.claude/skills/takt/pieces/coding.yaml` にあり、`personas:` セクションに `coder: ../personas/coder.md` がある場合
→ 絶対パスは `~/.claude/skills/takt/personas/coder.md`
→ movement では `persona: coder` で参照

## Movement 定義

### 通常 Movement

```yaml
- name: movement-name          # movement 名（必須、一意）
  persona: coder               # ペルソナキー（personas マップを参照、任意）
  policy: coding               # ポリシーキー（policies マップを参照、任意）
  policy: [coding, testing]    # 複数指定も可（配列）
  instruction: implement       # 指示テンプレートキー（instructions マップを参照、任意）
  knowledge: architecture      # ナレッジキー（knowledge マップを参照、任意）
  edit: true                   # ファイル編集可否（必須）
  required_permission_mode: edit # 必要最小権限: edit / readonly / full（任意）
  session: refresh             # セッション管理（任意）
  pass_previous_response: true # 前の出力を渡すか（デフォルト: true）
  allowed_tools: [...]         # 許可ツール一覧（任意、参考情報）
  instruction_template: |      # 指示テンプレート（参照解決またはインライン、任意）
    指示内容...
  output_contracts: [...]      # 出力契約設定（任意）
  quality_gates: [...]         # 品質ゲート（AIへの指示、任意）
  rules: [...]                 # 遷移ルール（必須）
```

**`instruction` vs `instruction_template`**: どちらも同じ参照解決ルート（セクションマップ → パス → 3-layer facet → インライン）を使う。`instruction_template` はインライン文字列もそのまま使える。通常はどちらか一方を使用する。

### Parallel Movement

```yaml
- name: reviewers              # 親 movement 名（必須）
  parallel:                    # 並列サブステップ配列（これがあると parallel movement）
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
    next: next-movement         # 遷移先 movement 名（必須、サブステップでは任意）
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
| `COMPLETE` | ピース成功終了 |
| `ABORT` | ピース失敗終了 |
| movement 名 | 指定された movement に遷移 |

## Output Contracts 定義

Movement の出力契約（レポート定義）。`output_contracts.report` 配列形式で指定する。

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

Movement 完了時の品質要件を AI への指示として定義する。自動検証は行わない。

```yaml
quality_gates:
  - 全てのテストがパスすること
  - TypeScript の型エラーがないこと
  - ESLint 違反がないこと
```

配列で複数の品質基準を指定できる。エージェントはこれらの基準を満たしてから Movement を完了する必要がある。

## テンプレート変数

`instruction_template`（またはインストラクションファイル）内で使用可能な変数:

| 変数 | 説明 |
|-----|------|
| `{task}` | ユーザーのタスク入力（template に含まれない場合は自動追加） |
| `{previous_response}` | 前の movement の出力（pass_previous_response: true 時、自動追加） |
| `{iteration}` | ピース全体のイテレーション数 |
| `{max_movements}` | 最大イテレーション数 |
| `{movement_iteration}` | この movement の実行回数 |
| `{report_dir}` | レポートディレクトリ名 |
| `{report:ファイル名}` | 指定レポートファイルの内容を展開 |
| `{user_inputs}` | 蓄積されたユーザー入力 |
| `{cycle_count}` | loop_monitors 内で使用するサイクル回数 |

## Loop Monitors（任意）

```yaml
loop_monitors:
  - cycle: [movement_a, movement_b]   # 監視対象の movement サイクル
    threshold: 3                       # 発動閾値（サイクル回数）
    judge:
      persona: supervisor              # ペルソナキー参照
      instruction_template: |          # 判定用指示
        サイクルが {cycle_count} 回繰り返されました。
        健全性を判断してください。
      rules:
        - condition: 健全（進捗あり）
          next: movement_a
        - condition: 非生産的（改善なし）
          next: alternative_movement
```

特定の movement 間のサイクルが閾値に達した場合、judge が介入して遷移先を判断する。

## allowed_tools について

`allowed_tools` は TAKT 本体のエージェントプロバイダーで使用されるフィールド。Claude Code の Skill として実行する場合、Task tool のエージェントが使用可能なツールは Claude Code の設定に従う。このフィールドは参考情報として扱い、`edit` フィールドの方を権限制御に使用する。
