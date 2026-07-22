# TAKT 実行エンジン詳細

## チームメイトの起動方法

全ての step は Task tool でチームメイトを起動して実行する。
**あなた（Team Lead）が直接作業することは禁止。**

### Task tool の呼び出し

```
Task tool:
  subagent_type: "general-purpose"
  team_name: "takt"
  name: "{step_name}"
  description: "{step_name} - {workflow_name}"
  prompt: <プロンプト構築で組み立てた内容>
  mode: permission_mode
```

### permission_mode

コマンド引数で解析された `permission_mode` をそのまま Task tool の `mode` に渡す。
- `/takt coding --permit-full タスク` → `permission_mode = "bypassPermissions"`（確認なし）
- `/takt coding --permit-edit タスク` → `permission_mode = "acceptEdits"`（編集は自動許可）
- `/takt coding タスク` → `permission_mode = "default"`（権限確認あり）

## 通常 step の実行

通常の step（`parallel` フィールドを持たない）は、Task tool で1つのチームメイトを起動する。

1. プロンプトを構築する（後述の「プロンプト構築」参照）
2. Task tool でチームメイトを起動する
3. チームメイトの出力を受け取る
4. Rule 評価で次の step を決定する

## Parallel step の実行

`parallel` フィールドを持つ step は、複数のチームメイトを並列起動する。

### 実行手順

1. parallel 配列の各サブステップに対して Task tool を準備する
2. **全ての Task tool を1つのメッセージで並列に呼び出す**（依存関係がないため）
3. 全チームメイトの完了を待つ
4. 各サブステップの出力を収集する
5. 各サブステップの出力に対して、そのサブステップの `rules` で条件マッチを判定
6. 親 step の `rules` で aggregate 評価（all()/any()）を行う

## Team Leader step の実行

1. 親 Team Leader はタスクを独立 part に分解する。`initial_max_parts` 指定時のみ初回 batch の part 数を制限する
2. member は `session: refresh` と part 固有 session key で、最大 `max_concurrency` 個ずつ実行する
3. 現在 batch の全 part が完了するまで次の分解を要求しない
4. 次 batch は完了結果だけを基に計画する。依存する検証はこの段階でのみ追加できる
5. `fail_on_part_error: true` では回復 part の実行後も親 step を error で終了する

`refill_threshold` は互換キーであり、省略または `0` のみ有効である。逐次 refill は存在しない。親の `pass_previous_response: true` は state 上の前回出力を親の分解 prompt に渡す。member には前回出力を渡さない。

### サブステップの条件マッチ判定

各サブステップは semantic 条件と `when(...)` 条件だけを通常 step と同じ YAML 順の first-match で判定する。意味ラベルが必要な場合だけ重複のない候補から一度選択し、その選択を以後の rule 評価に使う。どの rule も成立しなければ `rule_no_match` で ABORT する。

マッチした condition 文字列を記録し、parallel 親 step だけが確定済みのサブステップ結果を `all(...)` / `any(...)` で評価する。

## セクションマップの解決

ワークフロー YAML のトップレベルにある `personas:`, `policies:`, `instructions:`, `output_contracts:`, `knowledge:` はキーとファイルパスの対応表。step 定義内ではキー名で参照する。

### 解決手順

1. ワークフローYAMLを読み込む
2. 各セクションマップのパスを、**ワークフローYAMLファイルのディレクトリ**を基準に絶対パスに変換する
3. step の `persona: coder` → `personas:` セクションの `coder` キー → ファイルパス → Read で内容を取得

例: ワークフロー YAML が `~/.claude/skills/takt/workflows/default.yaml` にある場合
- `personas.coder: ../facets/personas/coder.md` → `~/.claude/skills/takt/facets/personas/coder.md`
- `policies.coding: ../facets/policies/coding.md` → `~/.claude/skills/takt/facets/policies/coding.md`
- `instructions.plan: ../facets/instructions/plan.md` → `~/.claude/skills/takt/facets/instructions/plan.md`

## プロンプト構築

各チームメイト起動時、以下を結合してプロンプトを組み立てる。

### 構成要素（上から順に結合）

```
1. ペルソナプロンプト（persona: で参照される .md の全内容）
2. ---（区切り線）
3. ポリシー（policy: で参照される .md の内容。複数ある場合は結合）
4. ---（区切り線）
5. 実行コンテキスト情報
6. ナレッジ（knowledge: で参照される .md の内容）
7. インストラクション内容（instruction: で参照される .md またはインライン文字列）
8. ユーザーのタスク（{task} が template に含まれない場合、末尾に自動追加）
9. 前の step の出力（pass_previous_response: true の場合、自動追加）
10. レポート出力指示（report フィールドがある場合、自動追加）
11. ステータスタグ出力指示（rules がある場合、自動追加）
```

### ペルソナプロンプト

step の `persona:` キーからセクションマップを経由して .md ファイルを解決し、その全内容をプロンプトの冒頭に配置する。ペルソナはドメイン知識と行動原則のみを含む（ワークフロー固有の手順は含まない）。

### ポリシー注入

step の `policy:` キー（単一または配列）からポリシーファイルを解決し、内容を結合する。ポリシーは行動ルール（コーディング規約、レビュー基準等）を定義する。

### ナレッジ注入

step の `knowledge:` キーからナレッジファイルを解決し、ドメイン固有の参考情報としてプロンプトに含める。

```
## ナレッジ
{ナレッジの内容}
```

### インストラクション

step の `instruction:` キーから指示内容を解決する。テンプレート変数（{task}, {previous_response} 等）を展開した上でプロンプトに含める。

### 実行コンテキスト情報

```
## 実行コンテキスト
- ワーキングディレクトリ: {cwd}
- ワークフロー (YAML の name): {workflow_name}
- Step: {step_name}
- イテレーション: {iteration} / {max_steps}
- Step 実行回数: {step_iteration} 回目
```

### テンプレート変数の展開

インストラクション内の以下のプレースホルダーを置換する:

| 変数 | 値 |
|-----|-----|
| `{task}` | ユーザーが入力したタスク内容 |
| `{previous_response}` | 前の step のチームメイト出力 |
| `{iteration}` | ワークフロー全体のイテレーション数（1始まり） |
| `{max_steps}` | ワークフローの max_steps 値 |
| `{step_iteration}` | この step が実行された回数（1始まり） |
| `{report_dir}` | レポートディレクトリパス（`.takt/runs/{slug}/reports`） |
| `{report:ファイル名}` | 指定レポートファイルの内容（Read で取得） |

### {report:ファイル名} の処理

インストラクション内に `{report:ai-antipattern-review.md}` のような記法がある場合:
1. レポートディレクトリ内に対応するレポートファイルがあれば Read で読む
2. 読み込んだ内容をプレースホルダーに展開する
3. ファイルが存在しない場合は「（レポート未作成）」に置換する

### persona フィールドがない場合

`persona:` が指定されていない step の場合、ペルソナプロンプト部分を省略し、インストラクションの内容のみでプロンプトを構成する。

## レポート出力指示の自動注入

step に `report` フィールドがある場合、プロンプト末尾にレポート出力指示を自動追加する。

### 形式1: name + format（キー参照）

```yaml
report:
  name: 01-plan.md
  format: plan                 # output_contracts セクションのキー
```

→ `output_contracts:` セクションの `plan` キーから .md ファイルを解決し、Read で読んだ内容を出力契約指示に使う:

```
---
## レポート出力（必須）
作業完了後、以下の出力契約に従ってレポートを出力してください。
レポートは ```markdown ブロックで囲んで出力してください。

ファイル名: 01-plan.md
出力契約:
{output_contracts の plan キーの .md ファイル内容}
```

### 形式2: 配列（複数レポート）

```yaml
report:
  - Summary: summary.md
  - Scope: 01-scope.md
```

→ プロンプトに追加する指示:

```
---
## レポート出力（必須）
作業完了後、以下の各レポートを出力してください。
各レポートは見出し付きの ```markdown ブロックで囲んで出力してください。

1. Summary → ファイル名: summary.md
2. Scope → ファイル名: 01-scope.md
```

### レポートの抽出と保存

チームメイトの出力からレポート内容を抽出し、Write tool でレポートディレクトリに保存する。
**この作業は Team Lead（あなた）が行う。** チームメイトの出力を受け取った後に実施する。

**実行ディレクトリ**: `.takt/runs/{timestamp}-{slug}/` に作成する。
- レポートは `.takt/runs/{timestamp}-{slug}/reports/` に保存する。
- `Knowledge` / `Policy` / `Previous Response` は `.takt/runs/{timestamp}-{slug}/context/` 配下に保存する。
- 最新の previous response は `.takt/runs/{timestamp}-{slug}/context/previous_responses/latest.md` とする。
- `{timestamp}`: `YYYYMMDD-HHmmss` 形式
- `{slug}`: タスク内容の先頭30文字をスラグ化

抽出方法:
- 出力内の ```markdown ブロックからレポート内容を取得する
- ファイル名の手がかり（見出しやコメント）から対応するレポートを特定する
- 特定できない場合は出力全体をレポートとして保存する

## ステータスタグ出力指示の自動注入

step に `rules` がある場合、プロンプト末尾にステータスタグ出力指示を自動追加する。

### 注入する指示

```
---
## ステータス出力（必須）
全ての作業とレポート出力が完了した後、意味ラベルを1つだけ選んでください。

[STEP:1] = {semanticCandidates[0].label}
[STEP:2] = {semanticCandidates[1].label}
[STEP:3] = {semanticCandidates[2].label}
...
```

機械条件の `when(...)` と `all(...)` / `any(...)` は候補に含めない。同じ意味ラベルが複数 rule にある場合も候補には一度だけ表示する。

### サブステップの場合

parallel のサブステップにも同様にタグ出力指示を注入する。サブステップの rules からタグリストを生成する。

## Rule 評価

チームメイトの出力からどの rule にマッチするかを判定する。

### 通常 step の Rule 評価

RuleEvaluator はまず rules を YAML 順に評価し、先行する machine rule が成立した場合は status judge を実行せずその rule を採用する。最初の semantic condition に到達した時点でのみ、status judge は structured output、タグ検出、AI judge の順で意味ラベルを一度だけ選択する。その選択と各 rule の guard を使って後続 rules の評価を続け、semantic label の guard が偽でも再選択しない。どの rule も成立しない場合は `rule_no_match` で ABORT する。

### Parallel step の Rule 評価（Aggregate）

親 step の rules に `all()` / `any()` の aggregate 条件を使用する。

#### all() の評価

```yaml
- condition: all("approved")
  next: COMPLETE
```

**引数が1つ**: 全サブステップのマッチ条件が "approved" であれば true。

```yaml
- condition: all("AI特有の問題なし", "すべて問題なし")
  next: COMPLETE
```

**引数が複数（位置対応）**: サブステップ1が "AI特有の問題なし" にマッチ AND サブステップ2が "すべて問題なし" にマッチ であれば true。

#### any() の評価

```yaml
- condition: any("needs_fix")
  next: fix
```

いずれかのサブステップのマッチ条件が "needs_fix" であれば true。

#### Aggregate 評価の順序

親 rules を上から順に評価し、最初にマッチした rule を採用する。

### Rule にマッチしない場合

全ての rule を評価してもマッチしない場合は ABORT する。エラーメッセージとともに、マッチしなかった出力の要約をユーザーに報告する。

## ループ検出

### 基本ルール

- 同じ step が連続3回以上実行されたら警告を表示する
- `max_steps` に到達したら強制終了（ABORT）する

### カウンター管理

以下のカウンターを管理する:

| カウンター | 説明 | リセットタイミング |
|-----------|------|-------------------|
| `iteration` | ワークフロー全体の step 実行回数 | リセットしない |
| `step_iteration[name]` | 各 step の実行回数 | リセットしない |
| `consecutive_count[name]` | 同じ step の連続実行回数 | 別の step に遷移したとき |

## Loop Monitors

ワークフローに `loop_monitors` が定義されている場合、特定の step 間サイクルを監視する。

### 動作

```yaml
loop_monitors:
  - cycle: [ai-antipattern-review-1st, ai-antipattern-fix]
    threshold: 3
    judge:
      persona: supervisor
      instruction: |
        サイクルが {cycle_count} 回繰り返されました...
      rules:
        - condition: 健全
          next: ai-antipattern-review-1st
        - condition: 非生産的
          next: reviewers
```

### 検出ロジック

1. step 遷移履歴を記録する（例: `[plan, implement, ai-antipattern-review-1st, ai-antipattern-fix, ai-antipattern-review-1st, ai-antipattern-fix, ...]`）
2. 各 loop_monitor の `cycle` パターンが履歴の末尾に `threshold` 回以上連続で出現するかチェックする
3. 閾値に達した場合:
   a. judge の `persona` キーからペルソナファイルを Read で読み込む
   b. `instruction` の `{cycle_count}` を実際のサイクル回数に置換する
   c. Task tool でチームメイト（judge）を起動する
   d. judge の出力を judge の `rules` で評価する
   e. マッチした rule の `next` に遷移する（通常のルール評価をオーバーライドする）

## 実行アーティファクト管理

### 実行ディレクトリの作成

ワークフロー実行開始時に実行ディレクトリを作成する:

```
.takt/runs/{YYYYMMDD-HHmmss}-{slug}/
  reports/
  context/
    knowledge/
    policy/
    previous_responses/
  logs/
  meta.json
```

このうち `reports/` のパスを `{report_dir}` 変数として全 step から参照可能にする。

### レポートの保存

チームメイト出力からレポート内容を抽出し、Write tool でレポートディレクトリに保存する。

抽出手順:
1. 出力内の ```markdown ブロックを検索する
2. レポートのファイル名やセクション見出しから対応するレポートを特定する
3. Write tool で `{report_dir}/{ファイル名}` に保存する

### レポートの参照

後続の step のインストラクション内で `{report:ファイル名}` として参照すると、そのレポートファイルを Read して内容をプレースホルダーに展開する。

## 状態遷移の全体像

```
[開始]
  ↓
ワークフローYAML読み込み + セクションマップ解決（personas, policies, instructions, output_contracts, knowledge）
  ↓
TeamCreate でチーム作成
  ↓
実行ディレクトリ作成
  ↓
initial_step を取得
  ↓
┌─→ Task tool でチームメイト起動
│     ├── 通常: 1つの Task tool 呼び出し
│     │     prompt = persona + policy + context + knowledge
│     │           + instruction + task + previous_response
│     │           + レポート指示 + タグ指示
│     └── parallel: 複数の Task tool を1メッセージで並列呼び出し
│           各サブステップを別々のチームメイトとして起動
│   ↓
│   チームメイトの出力を受け取る
│   ↓
│   出力からレポート抽出 → Write で保存（Team Lead が実施）
│   ↓
│   Loop Monitor チェック（該当サイクルがあれば judge チームメイト介入）
│   ↓
│   Rule 評価（Team Lead が実施、YAML 順の first-match）
│     ├── 各 rule を順に評価。先行する machine rule が成立すれば直ちに採用
│     ├── 最初の semantic condition 到達時だけ、structured output → タグ検出 → AI judge で意味ラベルを一度選択
│     ├── 選択済みラベルと guard で残りの rule を順に評価し、最初の成立 rule を採用
│     ├── parallel: 確定済みサブステップ結果で aggregate(all/any) を決定的に評価
│     └── 意味ラベルが不正・未選択、または rule が未成立なら rule_no_match で ABORT
│   ↓
│   next を決定
│     ├── COMPLETE → TeamDelete → ユーザーに結果報告
│     ├── ABORT → TeamDelete → ユーザーにエラー報告
│     └── step名 → ループ検出チェック → 次の step
│                                              ↓
└──────────────────────────────────────────────┘
```
