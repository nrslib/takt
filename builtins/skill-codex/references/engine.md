# TAKT 実行エンジン詳細

## サブエージェントの起動方法

全ての step は `codex exec` でサブエージェントを起動して実行する。
**あなた（Team Lead）が直接作業することは禁止。**

### 実行フロー（Write + Bash）

1. プロンプト全文を一時ファイルへ保存する
2. Bash tool で `codex exec` を実行する
3. `stdout` を step の出力として扱う

```bash
# 例
codex exec --full-auto - < "$tmp_prompt_file"
```

### permission_mode のマッピング

コマンド引数で解析された `permission_mode` を以下にマップして `codex exec` に渡す。

- `$takt coding --permit-full タスク`
  - `permission_mode = "danger-full-access"`
  - 実行: `codex exec --sandbox danger-full-access - < /tmp/...`
- `$takt coding --permit-edit タスク`
  - `permission_mode = "full-auto"`
  - 実行: `codex exec --full-auto - < /tmp/...`
- `$takt coding タスク`
  - `permission_mode = "default"`
  - 実行: `codex exec - < /tmp/...`

## 通常 step の実行

通常の step（`parallel` フィールドなし）は、`codex exec` を1回実行する。

1. プロンプトを構築する（後述の「プロンプト構築」参照）
2. step 名を含めない安全なランダム名（例: `/tmp/takt-prompt-{timestamp}-{uuid}.md`）で保存する
3. `codex exec {権限オプション} - < /tmp/...` を実行する
4. `stdout` を受け取り Rule 評価で次の step を決定する

## Parallel step の実行

`parallel` フィールドを持つ step は、複数サブステップを並列実行する。

### 実行手順

1. parallel 配列の各サブステップごとにプロンプトを構築する
2. 各プロンプトをサブステップ名を含めない安全なランダム名で保存する
3. **1つのメッセージで** サブステップ数分の Bash tool（`codex exec`）を並列実行する
4. 各 `stdout` を収集する
5. 各サブステップの `rules` で条件マッチを判定する
6. 親 step の `rules` で aggregate 評価（`all()` / `any()`）を行う

## Team Leader step の実行

1. 親 Team Leader はタスクを独立 part に分解する。`initial_max_parts` 指定時のみ初回 batch の part 数を制限する
2. member は `session: refresh` と part 固有 session key で、最大 `max_concurrency` 個ずつ実行する
3. 現在 batch の全 part が完了するまで次の分解を要求しない
4. 次 batch は完了結果だけを基に計画する。依存する検証はこの段階でのみ追加できる
5. `fail_on_part_error: true` では回復 part の実行後も親 step を error で終了する

`refill_threshold` は互換キーであり、省略または `0` のみ有効である。逐次 refill は存在しない。親の `pass_previous_response: true` は state 上の前回出力を親の分解 prompt に渡す。member には前回出力を渡さない。

### サブステップ条件マッチ判定

各サブステップは semantic 条件と `when(...)` 条件だけを通常 step と同じ YAML 順の first-match で判定する。意味ラベルが必要な場合だけ重複のない候補から一度選択し、その選択を以後の rule 評価に使う。どの rule も成立しなければ `rule_no_match` で ABORT する。

マッチした condition 文字列を記録し、parallel 親 step だけが確定済みのサブステップ結果を `all(...)` / `any(...)` で評価する。

## セクションマップの解決

ワークフロー YAML トップレベルの `personas:`, `policies:`, `instructions:`, `output_contracts:`, `knowledge:` はキーとファイルパスの対応表。step 定義内ではキー名で参照する。

### 解決手順

1. ワークフロー YAML を読み込む
2. 各セクションマップのパスを、**ワークフロー YAML ファイルのディレクトリ基準**で絶対パスへ変換する
3. step のキー参照（例: `persona: coder`）から実ファイルを Read で取得する

例: ワークフロー YAML が `~/.agents/skills/takt/workflows/default.yaml` にある場合
- `personas.coder: ../facets/personas/coder.md` → `~/.agents/skills/takt/facets/personas/coder.md`
- `policies.coding: ../facets/policies/coding.md` → `~/.agents/skills/takt/facets/policies/coding.md`
- `instructions.plan: ../facets/instructions/plan.md` → `~/.agents/skills/takt/facets/instructions/plan.md`

## プロンプト構築

各 step 実行時、以下を上から順に結合してプロンプトを作る。

1. ペルソナ（`persona:` 参照先 .md 全文）
2. 区切り線 `---`
3. ポリシー（`policy:` 参照先 .md。複数可）
4. 区切り線 `---`
5. 実行コンテキスト（cwd / workflow name / step / iteration）
6. ナレッジ（`knowledge:` 参照先 .md）
7. インストラクション（`instruction:`）
8. タスク（`{task}` 未使用時は末尾に自動追加）
9. 前回出力（`pass_previous_response: true` のとき）
10. レポート出力指示（`report` または `output_contracts.report` があるとき）
11. ステータスタグ出力指示（`rules` があるとき）
### テンプレート変数展開

インストラクション内のプレースホルダーを置換する。

- `{task}`: ユーザー入力タスク
- `{previous_response}`: 前 step 出力
- `{iteration}`: ワークフロー全体イテレーション
- `{max_steps}`: 最大イテレーション数
- `{step_iteration}`: 当該 step 実行回数
- `{report_dir}`: `.takt/runs/{slug}/reports`
- `{report:ファイル名}`: 指定レポート内容（存在しない場合は `（レポート未作成）`）

## レポート出力指示と保存

step がレポートを要求する場合、プロンプト末尾に必須指示を注入する。

### 形式1: name + format

```yaml
report:
  name: 01-plan.md
  format: plan
```

`output_contracts`（または `report_formats`）のキー参照先内容を読み込み、出力契約として渡す。

### 形式2: 複数レポート配列

```yaml
report:
  - Summary: summary.md
  - Scope: 01-scope.md
```

各レポートを見出し付き ` ```markdown ` ブロックで出力するよう指示する。

### 抽出と保存（Team Lead が実施）

`codex exec` 出力から ` ```markdown ` ブロックを抽出し、`{report_dir}/{ファイル名}` に Write で保存する。

- 実行ディレクトリ: `.takt/runs/{YYYYMMDD-HHmmss}-{slug}/`
- 保存先:
  - `reports/`
  - `context/knowledge/`
  - `context/policy/`
  - `context/previous_responses/`（`latest.md` を含む）
  - `logs/`
  - `meta.json`

## ステータスタグ出力指示

step に semantic rule がある場合、最後に意味ラベルを1つだけ出力するよう指示する。

```text
[STEP:1] = {semanticCandidates[0].label}
[STEP:2] = {semanticCandidates[1].label}
...
```

- `when(...)` と `all(...)` / `any(...)` は候補に含めない
- 同じ意味ラベルは最初の YAML 出現だけを候補にする
- parallel サブステップでも同様に適用する

## Rule 評価

### 通常 step

1. rules を YAML 順に評価する。意味ラベルを必要としない先行 machine rule が成立した場合は、意味ラベルを選択せずその rule を採用する
2. 最初の semantic condition に到達した時点でのみ、structured output、タグ検出、AI judge の順で意味ラベルを一度だけ選択する
3. 選択した意味ラベルと各 rule の guard を使って、現在の rule から後続 rules を YAML 順に評価する。guard が偽でも意味ラベルは再選択しない
4. どの rule も成立しない場合は `rule_no_match` で ABORT する

### Parallel step（Aggregate）

- `all("X")`: 全サブステップが `X` に一致
- `any("X")`: いずれかが `X` に一致
- `all("X", "Y")`: サブステップ位置対応で一致

親 rules を上から順に評価し、最初の一致を採用する。

### 不一致時

どの rule にも一致しない場合は ABORT し、不一致理由をユーザーへ報告する。

## ループ検出

### 基本

- 同じ step が連続3回以上なら警告
- `max_steps` 到達で ABORT

### カウンター

- `iteration`: 全体実行回数
- `step_iteration[name]`: step 別実行回数
- `consecutive_count[name]`: 連続実行回数

## Loop Monitors

`loop_monitors` がある場合、指定サイクルを監視する。

1. step 遷移履歴を記録する
2. `cycle` が `threshold` 回以上連続出現したら judge を実行する
3. judge は `persona` + `instruction` + `rules` でプロンプト構築する
4. judge も同じく `codex exec` で起動する
5. judge の評価結果 `next` で遷移先を上書きする

## 状態遷移の全体像

```text
[開始]
  ↓
ワークフロー YAML 読み込み + セクションマップ解決
  ↓
実行ディレクトリ作成
  ↓
initial_step 取得
  ↓
┌─→ codex exec で step 実行（通常/parallel）
│   ↓
│   出力受信
│   ↓
│   レポート抽出・保存
│   ↓
│   Loop Monitor チェック（必要時 judge を codex exec で実行）
│   ↓
│   Rule 評価（YAML 順 first-match）
│   ↓
│   next 決定
│     ├── COMPLETE → 終了報告
│     ├── ABORT → エラー報告
│     └── step名 → 次の step
│                      ↓
└──────────────────────┘
```
