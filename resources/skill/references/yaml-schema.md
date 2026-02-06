# ピースYAML スキーマリファレンス

このドキュメントはピースYAMLの構造を定義する。具体的なピース定義は含まない。

## トップレベルフィールド

```yaml
name: piece-name              # ピース名（必須）
description: 説明テキスト      # ピースの説明（任意）
max_iterations: 10            # 最大イテレーション数（必須）
initial_movement: plan        # 最初に実行する movement 名（必須）
movements: [...]              # movement 定義の配列（必須）
loop_monitors: [...]          # ループ監視設定（任意）
```

## Movement 定義

### 通常 Movement

```yaml
- name: movement-name          # movement 名（必須、一意）
  agent: ../agents/path.md     # エージェントプロンプトへの相対パス（任意）
  agent_name: coder            # 表示名（任意）
  edit: true                   # ファイル編集可否（必須）
  permission_mode: edit        # 権限モード: edit / readonly / full（任意）
  session: refresh             # セッション管理（任意）
  pass_previous_response: true # 前の出力を渡すか（デフォルト: true）
  allowed_tools: [...]         # 許可ツール一覧（任意、参考情報）
  instruction_template: |      # ステップ固有の指示テンプレート（任意）
    指示内容...
  report: ...                  # レポート設定（任意）
  rules: [...]                 # 遷移ルール（必須）
```

### Parallel Movement

```yaml
- name: reviewers              # 親 movement 名（必須）
  parallel:                    # 並列サブステップ配列（これがあると parallel movement）
    - name: sub-step-1         # サブステップ名
      agent: ../agents/a.md
      edit: false
      instruction_template: |
        ...
      rules:                   # サブステップの rules（condition のみ、next は無視される）
        - condition: "approved"
        - condition: "needs_fix"
      # report, allowed_tools 等も指定可能

    - name: sub-step-2
      agent: ../agents/b.md
      edit: false
      instruction_template: |
        ...
      rules:
        - condition: "passed"
        - condition: "failed"

  rules:                       # 親の rules（aggregate 条件で遷移先を決定）
    - condition: all("approved", "passed")
      next: complete-step
    - condition: any("needs_fix", "failed")
      next: fix-step
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

## Report 定義

### 形式1: 単一レポート（name + format）

```yaml
report:
  name: 01-plan.md
  format: |
    ```markdown
    # レポートタイトル
    ## セクション
    {内容}
    ```
```

`format` はエージェントへの出力フォーマット指示。レポート抽出時の参考情報。

### 形式2: 複数レポート（配列）

```yaml
report:
  - Summary: summary.md
  - Scope: 01-scope.md
  - Decisions: 02-decisions.md
```

各要素のキーがレポート種別名、値がファイル名。

## テンプレート変数

`instruction_template` 内で使用可能な変数:

| 変数 | 説明 |
|-----|------|
| `{task}` | ユーザーのタスク入力（template に含まれない場合は自動追加） |
| `{previous_response}` | 前の movement の出力（pass_previous_response: true 時、自動追加） |
| `{iteration}` | ピース全体のイテレーション数 |
| `{max_iterations}` | 最大イテレーション数 |
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
      agent: ../agents/supervisor.md   # 判定エージェント
      instruction_template: |          # 判定用指示
        サイクルが {cycle_count} 回繰り返されました。
        健全性を判断してください。
      rules:
        - condition: 健全（進捗あり）
          next: movement_a
        - condition: 非生産的（改善なし）
          next: alternative_movement
```

特定の movement 間のサイクルが閾値に達した場合、judge エージェントが介入して遷移先を判断する。

## allowed_tools について

`allowed_tools` は TAKT 本体のエージェントプロバイダーで使用されるフィールド。Claude Code の Skill として実行する場合、Task tool のエージェントが使用可能なツールは Claude Code の設定に従う。このフィールドは参考情報として扱い、`edit` フィールドの方を権限制御に使用する。
