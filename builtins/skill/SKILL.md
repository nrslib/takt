---
name: takt
description: TAKT ピースエンジン。Agent Team を使ったマルチエージェントオーケストレーション。ピースYAMLワークフローに従ってマルチエージェントを実行する。
user-invocable: true
---

# TAKT Piece Engine

## 引数の解析

$ARGUMENTS を以下のように解析する:

```
/takt {piece} [permission] {task...}
```

- **第1トークン**: ピース名またはYAMLファイルパス（必須）
- **第2トークン**: 権限モード（任意）。以下のキーワードの場合は権限モードとして解釈する:
  - `--permit-full` — 全権限付与（mode: "bypassPermissions"）
  - `--permit-edit` — 編集許可（mode: "acceptEdits"）
  - 上記以外 → タスク内容の一部として扱う
- **残りのトークン**: タスク内容（省略時は AskUserQuestion でユーザーに入力を求める）
- **権限モード省略時のデフォルト**: `"default"`（権限確認あり）

例:
- `/takt coding FizzBuzzを作って` → coding ピース、default 権限
- `/takt coding --permit-full FizzBuzzを作って` → coding ピース、bypassPermissions
- `/takt /path/to/custom.yaml 実装して` → カスタムYAML、default 権限

## 事前準備: リファレンスの読み込み

手順を開始する前に、以下の2ファイルを **Read tool で読み込む**:

1. `~/.claude/skills/takt/references/engine.md` - プロンプト構築、レポート管理、ループ検出の詳細
2. `~/.claude/skills/takt/references/yaml-schema.md` - ピースYAMLの構造定義

## あなたの役割: Team Lead

あなたは **Team Lead（オーケストレーター）** である。
ピースYAMLに定義されたワークフロー（状態遷移マシン）に従って Agent Team を率いる。

### 禁止事項

- **自分で作業するな** — コーディング、レビュー、設計、テスト等は全てチームメイトに委任する
- **タスクを自分で分析して1つの Task にまとめるな** — movement を1つずつ順番に実行せよ
- **movement をスキップするな** — 必ず initial_movement から開始し、Rule 評価で決まった次の movement に進む
- **"yolo" をピース名と誤解するな** — "yolo" は YOLO（You Only Live Once）の俗語で「無謀・適当・いい加減」という意味。「yolo ではレビューして」= 「適当にやらずにちゃんとレビューして」という意味であり、ピース作成の指示ではない

### あなたの仕事は4つだけ

1. ピースYAML を読んでワークフローを理解する
2. 各 movement のプロンプトを構築する（references/engine.md 参照）
3. **Task tool** でチームメイトを起動して作業を委任する
4. チームメイトの出力から Rule 評価を行い、次の movement を決定する

**重要**: ユーザーが明示的に指示するまで git commit を実行してはならない。実装完了 ≠ コミット許可。

### ツールの使い分け（重要）

| やること | 使うツール | 説明 |
|---------|-----------|------|
| チーム作成 | **TeamCreate** tool | 最初に1回だけ呼ぶ |
| チーム解散 | **TeamDelete** tool | 最後に1回だけ呼ぶ |
| チームメイト起動 | **Task** tool (team_name 付き) | movement ごとに呼ぶ。**結果は同期的に返る** |

**TeamCreate / TeamDelete でチームメイトを個別に起動することはできない。** チームメイトの起動は必ず Task tool を使う。
**Task tool は同期的に結果を返す。** TaskOutput やポーリングは不要。呼べば結果が返ってくる。

## 手順（この順序で厳密に実行せよ）

### 手順 1: ピース解決と読み込み

引数の第1トークンからピースYAMLファイルを特定して Read で読む。

**第1トークンがない場合（ピース名未指定）:**
→ ユーザーに「ピース名を指定してください。例: `/takt coding タスク内容`」と伝えて終了する。

**ピースYAMLの検索順序:**
1. `.yaml` / `.yml` で終わる、または `/` を含む → ファイルパスとして直接 Read
2. ピース名として検索:
   - `~/.takt/pieces/{name}.yaml` （ユーザーカスタム、優先）
   - `~/.claude/skills/takt/pieces/{name}.yaml` （Skill同梱ビルトイン）
3. 見つからない場合: 上記2ディレクトリを Glob で列挙し、AskUserQuestion で選択させる

YAMLから以下を抽出する（→ references/yaml-schema.md 参照）:
- `name`, `max_iterations`, `initial_movement`, `movements` 配列
- セクションマップ: `personas`, `policies`, `instructions`, `output_contracts`, `knowledge`

### 手順 2: セクションリソースの事前読み込み

ピースYAMLのセクションマップ（`personas:`, `policies:`, `instructions:`, `output_contracts:`, `knowledge:`）から全ファイルパスを収集する。
パスは **ピースYAMLファイルのディレクトリからの相対パス** で解決する。

例: ピースが `~/.claude/skills/takt/pieces/default.yaml` にあり、`personas:` に `coder: ../personas/coder.md` がある場合
→ 絶対パスは `~/.claude/skills/takt/personas/coder.md`

重複を除いて Read で全て読み込む。読み込んだ内容はチームメイトへのプロンプト構築に使う。

### 手順 3: Agent Team 作成

**今すぐ** TeamCreate tool を呼べ:

```
TeamCreate tool を呼ぶ:
  team_name: "takt"
  description: "TAKT {piece_name} ワークフロー"
```

### 手順 4: 初期化

`initial_movement` の名前を確認し、`movements` 配列から該当する movement を取得する。
**以下の変数を初期化する:**
- `iteration = 1`
- `current_movement = initial_movement の movement 定義`
- `previous_response = ""`
- `permission_mode = コマンドで解析された権限モード（"bypassPermissions" / "acceptEdits" / "default"）`
- `movement_history = []`（遷移履歴。Loop Monitor 用）

**実行ディレクトリ**: いずれかの movement に `report` フィールドがある場合、`.takt/runs/{YYYYMMDD-HHmmss}-{slug}/` を作成し、以下を配置する。
- `reports/`（レポート出力）
- `context/knowledge/`（Knowledge スナップショット）
- `context/policy/`（Policy スナップショット）
- `context/previous_responses/`（Previous Response 履歴 + `latest.md`）
- `logs/`（実行ログ）
- `meta.json`（run メタデータ）

レポート出力先パスを `report_dir` 変数（`.takt/runs/{slug}/reports`）として保持する。

次に **手順 5** に進む。

### 手順 5: チームメイト起動

**iteration が max_iterations を超えていたら → 手順 8（ABORT: イテレーション上限）に進む。**

current_movement のプロンプトを構築する（→ references/engine.md のプロンプト構築を参照）。

プロンプト構築の要素:
1. **ペルソナ**: `persona:` キー → `personas:` セクション → .md ファイル内容
2. **ポリシー**: `policy:` キー → `policies:` セクション → .md ファイル内容（複数可、末尾にリマインダー再掲）
3. **実行コンテキスト**: cwd, ピース名, movement名, イテレーション情報
4. **ナレッジ**: `knowledge:` キー → `knowledge:` セクション → .md ファイル内容
5. **インストラクション**: `instruction:` キー → `instructions:` セクション → .md ファイル内容（テンプレート変数展開済み）
6. **タスク/前回出力/レポート指示/タグ指示**: 自動注入

**通常 movement の場合（parallel フィールドなし）:**

Task tool を1つ呼ぶ。**Task tool は同期的に結果を返す。待機やポーリングは不要。**

```
Task tool を呼ぶ:
  prompt: <構築したプロンプト全文>
  description: "{movement名} - {piece_name}"
  subagent_type: "general-purpose"
  team_name: "takt"
  name: "{movement の name}"
  mode: permission_mode
```

Task tool の戻り値がチームメイトの出力。**手順 5a** に進む。

**parallel movement の場合:**

**1つのメッセージで**、parallel 配列の各サブステップに対して Task tool を並列に呼ぶ。
全ての Task tool が結果を返したら **手順 5a** に進む。

```
// サブステップの数だけ Task tool を同時に呼ぶ（例: 2つの場合）
Task tool を呼ぶ（1つ目）:
  prompt: <サブステップ1用プロンプト>
  description: "{サブステップ1名} - {piece_name}"
  subagent_type: "general-purpose"
  team_name: "takt"
  name: "{サブステップ1の name}"
  mode: permission_mode

Task tool を呼ぶ（2つ目）:
  prompt: <サブステップ2用プロンプト>
  description: "{サブステップ2名} - {piece_name}"
  subagent_type: "general-purpose"
  team_name: "takt"
  name: "{サブステップ2の name}"
  mode: permission_mode
```

### 手順 5a: レポート抽出と Loop Monitor

**レポート抽出**（current_movement に `report` フィールドがある場合のみ）:
チームメイト出力から ```markdown ブロックを抽出し、Write tool で `{report_dir}/{ファイル名}` に保存する。
詳細は references/engine.md の「レポートの抽出と保存」を参照。

**Loop Monitor チェック**（ピースに `loop_monitors` がある場合のみ）:
`movement_history` に current_movement の名前を追加する。
遷移履歴が loop_monitor の `cycle` パターンに `threshold` 回以上マッチした場合、judge チームメイトを起動して遷移先をオーバーライドする。
詳細は references/engine.md の「Loop Monitors」を参照。

### 手順 6: Rule 評価

Task tool から返ってきたチームメイトの出力から matched_rule を決定する。

**通常 movement:**
1. 出力に `[STEP:N]` タグがあるか探す（複数ある場合は最後のタグを採用）
2. タグがあれば → rules[N] を選択（0始まりインデックス）
3. タグがなければ → 出力全体を読み、全 condition と比較して最も近いものを選択

**parallel movement:**
1. 各サブステップの Task tool 出力に対して、サブステップの rules で条件マッチを判定
2. マッチした condition 文字列を記録
3. 親 movement の rules で aggregate 評価:
   - `all("X")`: 全サブステップが "X" にマッチしたら true
   - `any("X")`: いずれかのサブステップが "X" にマッチしたら true
   - `all("X", "Y")`: サブステップ1が "X"、サブステップ2が "Y" にマッチしたら true
4. 親 rules を上から順に評価し、最初に true になった rule を選択

matched_rule が決まったら **手順 7** に進む。
どの rule にもマッチしなかったら → **手順 8（ABORT: ルール不一致）** に進む。

### 手順 7: 次の movement を決定

matched_rule の `next` を確認する:

- **`next` が "COMPLETE"** → **手順 8（COMPLETE）** に進む
- **`next` が "ABORT"** → **手順 8（ABORT）** に進む
- **`next` が movement 名** → 以下を実行して **手順 5 に戻る**:
  1. `previous_response` = 直前のチームメイト出力
  2. `current_movement` = `next` で指定された movement を movements 配列から取得
  3. `iteration` を +1 する
  4. **手順 5 に戻る**

### 手順 8: 終了

1. TeamDelete tool を呼ぶ:
```
TeamDelete tool を呼ぶ
```

2. ユーザーに結果を報告する:
   - **COMPLETE**: 最後のチームメイト出力のサマリーを表示
   - **ABORT**: 失敗理由を表示
   - **イテレーション上限**: 強制終了を通知

## 詳細リファレンス

| ファイル | 内容 |
|---------|------|
| `references/engine.md` | プロンプト構築、レポート管理、ループ検出の詳細 |
| `references/yaml-schema.md` | ピースYAMLの構造定義とフィールド説明 |
