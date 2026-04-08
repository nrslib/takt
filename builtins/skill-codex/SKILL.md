---
name: takt
description: >
  TAKT ワークフローエンジン。codex exec でサブエージェントを起動し、ワークフロー YAML（steps / initial_step）に従って
  マルチエージェントオーケストレーションを実行する。
---

# TAKT Workflow Engine

## 引数の解析

$ARGUMENTS を以下のように解析する:

```
$takt {workflow} [permission] {task...}
```

- **第1トークン**: ワークフロー名または YAML ファイルパス（必須）
- **第2トークン**: 権限モード（任意）。以下のキーワードの場合は権限モードとして解釈する:
  - `--permit-full` - `codex exec --sandbox danger-full-access`
  - `--permit-edit` - `codex exec --full-auto`
  - 上記以外 → タスク内容の一部として扱う
- **残りのトークン**: タスク内容（省略時は AskUserQuestion でユーザーに入力を求める）
- **権限モード省略時のデフォルト**: `default`（`codex exec (オプションなし)`）

例:
- `$takt coding FizzBuzzを作って` → coding ワークフロー、default 権限
- `$takt coding --permit-full FizzBuzzを作って` → coding ワークフロー、danger-full-access
- `$takt /path/to/custom.yaml 実装して` → カスタムYAML、default 権限

## 事前準備: リファレンスの読み込み

手順を開始する前に、以下の2ファイルを **Read tool で読み込む**:

1. `~/.agents/skills/takt/references/engine.md` - プロンプト構築、レポート管理、ループ検出の詳細
2. `~/.agents/skills/takt/references/yaml-schema.md` - ワークフロー YAML の構造定義

## あなたの役割: Team Lead

あなたは **Team Lead（オーケストレーター）** である。
ワークフロー YAML に定義された状態遷移に従って step を実行する。

### 禁止事項

- **自分で作業するな** - コーディング、レビュー、設計、テスト等は全てサブエージェントに委任する
- **タスクを自分で分析して1つの実装にまとめるな** - step を1つずつ順番に実行せよ
- **step をスキップするな** - 必ず `initial_step` から開始し、Rule 評価で決まった次の step に進む
- **"yolo" をワークフロー名と誤解するな** - "yolo" は YOLO（You Only Live Once）の俗語で「無謀・適当・いい加減」という意味。「yolo ではレビューして」= 「適当にやらずにちゃんとレビューして」という意味であり、ワークフロー作成の指示ではない

### あなたの仕事は4つだけ

1. ワークフロー YAML を読んで遷移を理解する
2. 各 step のプロンプトを構築する（references/engine.md 参照）
3. **Write tool + Bash tool (`codex exec`)** でサブエージェントを起動して作業を委任する
4. サブエージェントの出力から Rule 評価を行い、次の step を決定する

**重要**: ユーザーが明示的に指示するまで git commit を実行してはならない。実装完了 ≠ コミット許可。

### ツールの使い分け（重要）

| やること | 使うツール | 説明 |
|---------|-----------|------|
| プロンプト一時保存 | **Write** tool | step 名を含めない安全なランダム名（例: `/tmp/takt-prompt-{timestamp}-{uuid}.md`）で書き出す |
| サブエージェント起動 | **Bash** tool | `codex exec {権限オプション} - < /tmp/...` を実行 |

## 手順（この順序で厳密に実行せよ）

### 手順 1: ワークフロー解決と読み込み

引数の第1トークンからワークフロー YAML ファイルを特定して Read で読む。

**第1トークンがない場合（ワークフロー名未指定）:**
→ ユーザーに「ワークフロー名を指定してください。例: `$takt coding タスク内容`」と伝えて終了する。

**ワークフロー YAML の検索順序:**
1. `.yaml` / `.yml` で終わる、または `/` を含む → ファイルパスとして直接 Read
2. 名前解決:
   - `~/.takt/workflows/{name}.yaml` （ユーザーカスタム、優先）
   - `~/.agents/skills/takt/workflows/{name}.yaml` （Skill 同梱ビルトイン）
3. 見つからない場合: 上記ディレクトリを Glob で列挙し、AskUserQuestion で選択させる

YAML から以下を抽出する（→ references/yaml-schema.md 参照）:
- `name`, `max_steps`, `initial_step`, `steps` 配列
- `workflow_config`（ワークフロー全体の provider / runtime 等）
- セクションマップ: `personas`, `policies`, `instructions`, `output_contracts`, `knowledge`

### 手順 2: セクションリソースの事前読み込み

ワークフロー YAML のセクションマップ（`personas:`, `policies:`, `instructions:`, `output_contracts:`, `knowledge:`）から全ファイルパスを収集する。
パスは **ワークフロー YAML ファイルのディレクトリからの相対パス** で解決する。

例: ワークフローが `~/.agents/skills/takt/workflows/default.yaml` にあり、`personas:` に `coder: ../facets/personas/coder.md` がある場合
→ 絶対パスは `~/.agents/skills/takt/facets/personas/coder.md`

重複を除いて Read で全て読み込む。読み込んだ内容はサブエージェントへのプロンプト構築に使う。

### 手順 3: 初期化

`initial_step` の名前を確認し、`steps` から該当する step 定義を取得する。
**以下の変数を初期化する:**
- `iteration = 1`
- `current_step = 上記 initial の step 定義`
- `previous_response = ""`
- `permission_mode = コマンドで解析された権限モード（"danger-full-access" / "full-auto" / "default"）`
- `step_history = []`（遷移履歴。Loop Monitor 用）

**実行ディレクトリ**: いずれかの step に `report` フィールドがある場合、`.takt/runs/{YYYYMMDD-HHmmss}-{slug}/` を作成し、以下を配置する。
- `reports/`（レポート出力）
- `context/knowledge/`（Knowledge スナップショット）
- `context/policy/`（Policy スナップショット）
- `context/previous_responses/`（Previous Response 履歴 + `latest.md`）
- `logs/`（実行ログ）
- `meta.json`（run メタデータ）

レポート出力先パスを `report_dir` 変数（`.takt/runs/{slug}/reports`）として保持する。

次に **手順 4** に進む。

### 手順 4: サブエージェント起動

**iteration が max_steps を超えていたら → 手順 7（ABORT: イテレーション上限）に進む。**

current_step のプロンプトを構築する（→ references/engine.md のプロンプト構築を参照）。

プロンプト構築の要素:
1. **ペルソナ**: `persona:` キー → `personas:` セクション → .md ファイル内容
2. **ポリシー**: `policy:` キー → `policies:` セクション → .md ファイル内容（複数可、末尾にリマインダー再掲）
3. **実行コンテキスト**: cwd, ワークフロー名, step 名, イテレーション情報
4. **ナレッジ**: `knowledge:` キー → `knowledge:` セクション → .md ファイル内容
5. **インストラクション**: `instruction:` キー → `instructions:` セクション → .md ファイル内容（テンプレート変数展開済み）
6. **タスク/前回出力/レポート指示/タグ指示**: 自動注入

**通常 step の場合（parallel フィールドなし）:**

1. Write tool でプロンプトを一時ファイルに保存する。
   - step 名や substep 名をファイル名に含めず、`/tmp/takt-prompt-{timestamp}-{uuid}.md` のような安全なランダム名を使う
2. Bash tool で `codex exec` を実行する。
   - `--permit-full` の場合: `codex exec --sandbox danger-full-access - < "$tmp_prompt_file"`
   - `--permit-edit` の場合: `codex exec --full-auto - < "$tmp_prompt_file"`
   - デフォルト: `codex exec - < "$tmp_prompt_file"`
3. `stdout` をサブエージェント出力として扱う。
4. **手順 5** に進む。

**parallel step の場合:**

1. parallel 配列の各サブステップ用プロンプトをそれぞれ安全なランダム名（例: `/tmp/takt-parallel-{timestamp}-{uuid}.md`）で保存する。
2. **1つのメッセージで**、サブステップ数分の Bash tool (`codex exec`) を並列実行する。
3. 全 `stdout` を収集して **手順 5** に進む。

```bash
# 例: 2サブステップを並列実行
codex exec --full-auto - < "$tmp_prompt_file_1"
codex exec --full-auto - < "$tmp_prompt_file_2"
```

### 手順 5: レポート抽出と Loop Monitor

**レポート抽出**（current_step に `report` フィールドがある場合のみ）:
サブエージェント出力から ```markdown ブロックを抽出し、Write tool で `{report_dir}/{ファイル名}` に保存する。
詳細は references/engine.md の「レポートの抽出と保存」を参照。

**Loop Monitor チェック**（ワークフローに `loop_monitors` がある場合のみ）:
`step_history` に current_step の名前を追加する。
遷移履歴が loop_monitor の `cycle` パターンに `threshold` 回以上マッチした場合、judge サブエージェントを起動して遷移先をオーバーライドする。
詳細は references/engine.md の「Loop Monitors」を参照。

### 手順 6: Rule 評価

`codex exec` から返ってきたサブエージェント出力から matched_rule を決定する。

**通常 step:**
1. 出力に `[STEP:N]` タグがあるか探す（複数ある場合は最後のタグを採用）
2. タグがあれば → rules[N] を選択（0始まりインデックス）
3. タグがなければ → 出力全体を読み、全 condition と比較して最も近いものを選択

**parallel step:**
1. 各サブステップの `codex exec` 出力に対して、サブステップの rules で条件マッチを判定
2. マッチした condition 文字列を記録
3. 親 step の rules で aggregate 評価:
   - `all("X")`: 全サブステップが "X" にマッチしたら true
   - `any("X")`: いずれかのサブステップが "X" にマッチしたら true
   - `all("X", "Y")`: サブステップ1が "X"、サブステップ2が "Y" にマッチしたら true
4. 親 rules を上から順に評価し、最初に true になった rule を選択

matched_rule が決まったら次に進む。
- `next = COMPLETE` → **手順 7（COMPLETE）**
- `next = ABORT` → **手順 7（ABORT）**
- `next = step 名` → `previous_response` 更新、`iteration += 1`、次 step を `steps` から取得して **手順 4** に戻る

どの rule にもマッチしなかったら → **手順 7（ABORT: ルール不一致）** に進む。

### 手順 7: 終了

ユーザーに結果を報告する:
- **COMPLETE**: 最後のサブエージェント出力のサマリーを表示
- **ABORT**: 失敗理由を表示
- **イテレーション上限**: 強制終了を通知

## 詳細リファレンス

| ファイル | 内容 |
|---------|------|
| `references/engine.md` | プロンプト構築、レポート管理、ループ検出の詳細 |
| `references/yaml-schema.md` | ワークフロー YAML の構造定義とフィールド説明 |
