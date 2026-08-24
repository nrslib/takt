# CLI リファレンス

[English](./cli-reference.md) | [日本語](./cli-reference.ja.md) | [简体中文](./cli-reference.zh-CN.md)

このドキュメントは TAKT CLI の全コマンドとオプションの完全なリファレンスです。

## グローバルオプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | pipeline（非インタラクティブ）モードを有効化 -- CI/自動化に必要 |
| `-t, --task <text>` | タスク内容（GitHub Issue の代替） |
| `-i, --issue <N>` | GitHub Issue 番号（インタラクティブモードでの `#N` と同等） |
| `-w, --workflow <name or path>` | workflow 名または workflow YAML ファイルのパス |
| `-b, --branch <name>` | ブランチ名を指定（省略時は自動生成） |
| `--pr <number>` | PR 番号を指定してレビューコメントを取得し修正を実行 |
| `--auto-pr` | PR を作成（pipeline モードのみ） |
| `--draft` | PR をドラフトとして作成（`--auto-pr` または `auto_pr` 設定が必要） |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（pipeline モード、workflow のみ実行） |
| `--repo <owner/repo>` | リポジトリを指定（PR 作成用） |
| `-q, --quiet` | 最小出力モード: AI 出力を抑制（CI 向け） |
| `--provider <name>` | エージェント provider を上書き（claude\|claude-sdk\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|pi\|mock） |
| `--auto-strategy <strategy>` | auto routing の strategy を上書き（`cost`\|`balanced`\|`performance`）。実行時に effective `auto_routing` を持つ現在の workflow または workflow_call child へ到達した場合に適用し、それ以外では warning を出して無視します。 |
| `--model <name>` | エージェントモデルを上書き |
| `-c, --continue` | 現在のプロジェクトディレクトリ・プロバイダの直近アシスタントセッションから継続 |
| `--tui` | 端末ではこれが既定の姿で、stdin と stdout が TTY ならフラグの有無にかかわらずタスク会話は Ink が描画し、パイプ入力では従来のリーダーが使われる。このフラグはその前提を明示するだけで、TTY がない場合はフォールバックせず `--tui requires an interactive terminal` で失敗する。ワークフロー選択・モード選択・要約後のアクション選択は従来のセレクタのままで、会話だけを TUI が描画する。Enter で送信、Shift+Enter / Option+Enter で改行、Ctrl+K で行末まで削除、Esc で応答を中断（キューに残っている行はそのまま次のターンとして送信される）。応答中の Enter はキューに積まれ、完了後に送信される（中断前なら ↑ で取り消して編集）。タスク実行後もセッションは続き、/cancel で終了する |

正式オプションは `--workflow` です。

グローバル設定ディレクトリ（デフォルト: `~/.takt/`）は環境変数 `TAKT_CONFIG_DIR` で変更できます。

## インタラクティブモード

AI との会話を通じてタスク内容を精緻化してから実行するモードです。タスクの要件が曖昧な場合や、AI と相談しながら内容を詰めたい場合に便利です。

```bash
# インタラクティブモードを開始（引数なし）
takt

# 初期メッセージを指定（短い単語のみ）
takt hello
```

**注意:** `--task` オプションを指定するとインタラクティブモードをスキップして直接実行します。Issue 参照（`#6`、`--issue`）はインタラクティブモードの初期入力として使用されます。

TUI の会話履歴では、送信済みのユーザー発言を、表示幅いっぱいの背景帯、本文の上下各1行の余白、`❯ ` マーカーで表示します。端末から背景色を取得できる場合は背景帯と文字色を端末に合わせ、取得できない場合は暗いグレーの背景と白い文字を使用します。入力欄にある送信前の下書きには、この表示を適用しません。

### フロー

1. workflow を選択
2. インタラクティブモードを選択（assistant / grill-me / persona / quiet / passthrough）
3. AI との会話でタスク内容を精緻化
4. `/go` でタスク指示を確定（`/go 追加の指示` のように追記も可能）
5. 実行（workflow 実行、PR 作成）

### インタラクティブモードの種類

| モード | 説明 |
|--------|------|
| `assistant` | デフォルト。AI がタスク指示を生成する前に明確化のための質問を行う。 |
| `grill-me` | 推奨案付きの質問を1問ずつ行い、重要な判断分岐を解決する。要件が固まると `/go` を案内する。 |
| `persona` | 最初の step の persona と会話（そのシステムプロンプトとツールを使用）。 |
| `quiet` | 質問なしでタスク指示を生成（ベストエフォート）。 |
| `passthrough` | AI 処理なしでユーザー入力をそのままタスクテキストとして使用。 |

Workflow は YAML の `interactive_mode` フィールドでデフォルトモードを設定できます。

### 実行例

```
$ takt

Select workflow:
  > default (current)
    Development/
    Research/
    Cancel

Interactive mode - Enter task content. Commands: /go (execute), /cancel (exit)

> I want to add user authentication feature

[AI が要件を確認・整理]

> /go

Proposed task instructions:
---
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
---

Proceed with these task instructions? (Y/n) y

[Workflow の実行を開始...]
```

## 直接タスク実行

`--task` オプションを使用して、インタラクティブモードをスキップして直接実行できます。

```bash
# --task オプションでタスク内容を指定
takt --task "Fix bug"

# workflow を指定
takt --task "Add authentication" --workflow dual
```

**注意:** 引数として文字列を渡す場合（例: `takt "Add login feature"`）は初期メッセージとしてインタラクティブモードに入ります。

## ACP Agent

`takt-acp` は TAKT を Agent Client Protocol agent として stdio JSON-RPC で起動します。ACP 対応クライアントから agent コマンドとして起動してください。

```bash
takt-acp
```

ACP session の `cwd` は絶対パスである必要があります。TAKT はこのディレクトリを会話の基点かつ workflow project root として扱います。既定の `session/prompt` は enqueue-first の会話入口です。「タスクに積んで」「pending task にして」のような依頼は`worktree: true` の pending タスクとして `.takt/tasks.yaml` に追加され、後で `takt run` で実行できます。direct workflow execution は「そのまま実行して」「今すぐ実行して」のように明示された場合だけ行います。曖昧な依頼は会話として扱われます。ACP の主 UX は `/go` に依存しません。`/go` は session の `defaultAction` に従い、既定では enqueue されます。

ACP prompt がタスクを作成または直接実行する場合、会話結果が workflow を明示しない限り `default` workflow を使います。

`session/new` は `mcpServers` を省略できます。省略または空の `mcpServers: []` は MCP server なしとして扱われます。stdio MCP server は workflow 実行へ渡されますが、step の実効 provider が MCP server に非対応の場合、TAKT は実行前に fail fast します。stdio 以外の MCP transport、重複した MCP server 名、trim 後に重複する MCP env 名は session 作成時に拒否されます。

現在対応しているのは `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` 通知です。`additionalDirectories` capability は宣言しておらず、非空の `additionalDirectories` を含むリクエストは拒否されます。

## MCP Server

`takt-mcp` は TAKT を stdio Model Context Protocol server として起動します。MCP client から shell 経由で `takt add` を直接呼ばずに TAKT タスクを enqueue したい場合に登録します。

```bash
takt-mcp
```

Codex では`~/.codex/config.toml`、または trusted project の project-scoped `.codex/config.toml` に stdio MCP server を追加します。

```toml
[mcp_servers.takt]
command = "takt-mcp"
```

Codex の MCP CLI から追加することもできます。

```bash
codex mcp add takt -- takt-mcp
```

この server は次の tool を公開します。

| Tool | 説明 |
|------|------|
| `takt_enqueue_task` | pending タスクを `.takt/tasks.yaml` に保存し、既存 Issue の紐付けまたは新規 Issue 作成を任意で行う。 |

各 tool の `cwd` は `realpath` で解決され、MCP server の許可 project root 内にある必要があります。既定の許可 root は `takt-mcp` を起動したディレクトリです。

### `takt_enqueue_task`

必須入力:

| フィールド | 型 | 説明 |
|-----------|----|------|
| `cwd` | 絶対パス文字列 | `.takt/tasks.yaml` を書き込む project root。 |
| `task` | string | タスク指示書本文。 |
| `workflow` | string | Workflow 名またはパス。MCP caller はタスク投入前に使用する workflow を確認する必要があります。 |
| `autoPr` | boolean | 自動 PR を有効にしたタスクとして保存するかどうか。MCP caller はタスク投入前に確認する必要があります。 |

任意入力:

| フィールド | 型 | 説明 |
|-----------|----|------|
| `worktree` | boolean | `true` は自動の隔離 worktree を作成する。省略時は `true`。MCP 入力では任意の worktree パスを受け取りません。 |
| `issue.number` | 正の safe integer | issue provider を呼ばずに既存 Issue を紐付ける。 |
| `issue.create` | `true` | enqueue 前に設定済み issue provider で Issue を作成する。 |
| `issue.title` | string | 新規 Issue 用の任意の非空 title。上限は 255 文字。 |
| `issue.labels` | string array | 新規 Issue 用の任意の非空 label。 |
| `taskContext.branch` | string | タスクに保存するローカルブランチ名。 |
| `taskContext.baseBranch` | string | タスクに保存するベースブランチ名。 |
| `taskContext.prNumber` | 正の safe integer | タスクに保存する Pull Request 番号。`Number.MAX_SAFE_INTEGER` を超える値は拒否されます。 |

入力上限: `task` は 128 KiB、`workflow` は 128 文字、Issue title は 255 文字、Issue label は 1 件 100 文字、最大 20 件までです。

`issue` object は `{ "number": 123 }` または `{ "create": true, "title"?: "...", "labels"?: ["..."] }` のいずれかだけを指定します。混在 key、空の title・label、unknown key は拒否されます。Issue 付き enqueue の成功結果には `issueNumber` を含みます。Issue 番号の解決後にタスク保存が失敗またはキャンセルされた場合も Issue は open のまま残り、MCP error result は `issueCreated`、`issueNumber`、任意の `issueUrl`、`taskEnqueued`、`stage`、sanitize 済みの `error` を返します。`{ "issue": { "number": issueNumber } }` で再試行すれば、新しい Issue は作成されません。`stage` が `issue_number_parsing` の場合は `issueNumber` を返せないため、任意の `issueUrl` で作成済み Issue を特定し、番号を確認してから再試行してください。

MCP はタスクの enqueue だけを担当します。pending タスクの実行には `takt run`、継続監視と実行には `takt watch` を使用してください。

## Instant Exec モード

`takt exec` はworkflow YAML を手で書かずに TAKT の対話型タスク入力モードを開始します。アシスタントエージェントが依頼を明確化し、`/go` で会話を生成 workflow に変換し、ワーカーエージェントが実装し、レビューエージェントが結果をレビューし、必要な場合だけ再計画エージェントがユーザーに方向性を確認し、ループ検知が不毛な反復を防ぎます。

```bash
takt exec          # 前回設定を使用（初回はデフォルト）
takt exec backend  # 名前付きプリセットで開始
takt exec --list   # 利用可能な exec プリセットを表示
```

プリセットの探索順は project `.takt/exec/presets/`、global `$TAKT_CONFIG_DIR/exec/presets/`（未設定時は `~/.takt/exec/presets/`）、builtin `builtins/exec/presets/` です。builtin/default プリセットはエージェントの役割、facet、ループ検知しきい値だけを定義します。provider と model は exec モード開始時に通常の TAKT 設定から解決され、assistant 対話と `/setup` 表示で使われます。生成 workflow は tool / skill の要求に capabilities を使い、provider/model/options は `runtime.yaml`（または既存の legacy config）に残します。`effort` は明示設定された場合だけ出力されます。Codex の repository Skill と user Skill は scope ごとに設定省略時に継承され、解決した capability が生成 workflow に出力されます。`/setup` で変更した設定は次回起動用の設定として `$TAKT_CONFIG_DIR/exec.yaml`（未設定時は `~/.takt/exec.yaml`）に保存されます。

exec モード内の主なコマンド:

| コマンド | 説明 |
|----------|------|
| `/setup` | エージェント、replan facet、ループ検知しきい値、project/global preset を編集 |
| `/go` | 会話内容を実行用タスク指示に要約し、生成 workflow を実行 |
| `/go <note>` | 会話要約に追加メモを付けて実行 |
| `/paste-image` | 現在の入力行を編集中に、クリップボード画像のプレースホルダーへ置換 |
| `/cancel` | 実行せず終了 |

`/setup` では project/global プリセットの保存・削除ができます。Instruction、Knowledge、Policy は通常の facet 参照で、作成した facet は `.takt/facets/{instructions,knowledge,policies}/` または `$TAKT_CONFIG_DIR/facets/{instructions,knowledge,policies}/`（未設定時は `~/.takt/facets/{instructions,knowledge,policies}/`）に保存されます。

`/go` 実行時、TAKT は `.takt/exec/workflow.yaml` を生成し、既存の workflow engine で実行します。事前の会話もインラインのタスク本文もない `/go` はworkflow を作成する前に拒否されます。完了後は review result report を読み戻し、exec assistant セッションへ注入して最終サマリを返します。

exec 入力の編集中に画像を添付できます。macOS では `/paste-image` または `Ctrl+V` でクリップボード画像を添付でき、対応ターミナルでは OSC 1337 のインライン画像ペーストも使えます。TAKT は `[Image #N]` プレースホルダーを挿入します。画像は現在の Assistant メッセージまたは `/go <note>` がそのプレースホルダーを参照した場合だけ Assistant 依頼に送信されます。同じセッションで添付されていないプレースホルダーは通常テキストとして扱われます。`/go` 実行時は参照された保存済み画像だけが生成タスク仕様へコピーされ、添付セクションに列挙されます。対応形式は PNG、JPEG、GIF、WebP です。インライン画像とクリップボード画像は 10 MiB までです。未対応形式、インライン画像のファイル名拡張子と実データの不一致、上限超過、保存済み添付の一時パス消失、symlink、通常ファイルではない添付元はエラーになります。ネイティブ画像入力に対応しない provider にはプロンプト内のローカルパス参照として渡されます。

生成される exec workflow は `session_key` でワーカーエージェント、レビューエージェント、再計画エージェントのセッションを分離します。ループ検知 judge は常に新しいセッションを使います。ユーザー定義 workflow では通常の agent step と parallel sub-step にだけ `session_key` を指定できます。system step、workflow_call step、loop-monitor judge、parallel parent step では指定できません。実際のセッションキーは解決済み provider を付けた形になります。

## GitHub Issue タスク

GitHub Issue を直接タスクとして実行できます。Issue のタイトル、本文、ラベル、コメントがタスク内容として自動的に取り込まれます。

```bash
# Issue 番号を指定して実行
takt #6
takt --issue 6

# Issue + workflow 指定
takt #6 --workflow dual
```

**要件:** [GitHub CLI](https://cli.github.com/)（`gh`）がインストールされ、認証済みである必要があります。

## タスク管理コマンド

`.takt/tasks.yaml` と `.takt/tasks/{slug}/` 配下のタスクディレクトリを使ったバッチ処理です。複数のタスクを蓄積し、後でまとめて実行するのに便利です。

### takt add

AI との会話でタスク要件を精緻化し、`.takt/tasks.yaml` にタスクを追加します。

```bash
# AI との会話でタスク要件を精緻化し、タスクを追加
takt add

# GitHub Issue からタスクを追加（Issue 番号がブランチ名に反映される）
takt add #28

# 積むタスクの workflow を指定
takt add -w default

# PR レビューコメントからタスクを作成
takt add --pr 123
```

`-w, --workflow <name or path>` はタスクに保存する workflow を指定し、`--pr <number>` は PR のレビューコメントからタスクを作成します。

### takt run

`.takt/tasks.yaml` のすべての pending タスクを実行します。

```bash
# .takt/tasks.yaml の pending タスクをすべて実行
takt run

# workflow の max_steps を無視して別の停止条件まで継続
takt run --ignore-exceed
```

`--ignore-exceed` を付けない場合、workflow の `max_steps` に到達したタスクは `exceeded` として停止し、再実行用メタデータが `.takt/tasks.yaml` に保存されます。`--ignore-exceed` を付けた `takt run` は iteration limit だけを無視して継続し、exceeded 用の再実行メタデータを保存しません。

### takt watch

`.takt/tasks.yaml` を監視し、タスクが追加されると自動実行する常駐プロセスです。

```bash
# .takt/tasks.yaml を監視してタスクを自動実行（常駐プロセス）
takt watch

# workflow の max_steps を無視して、exceeded 扱いにせず継続実行する
takt watch --ignore-exceed
```

`takt watch --ignore-exceed` の意味は `takt run --ignore-exceed` と同じです。workflow の `max_steps` を無視し、`.takt/tasks.yaml` に exceeded 用の再実行メタデータを書きません。

### takt list

タスクブランチの一覧表示と操作（マージ、削除、ルートとの同期など）を行います。

```bash
# タスクブランチの一覧表示（マージ/削除）
takt list

# 非インタラクティブモード（CI/スクリプト向け）
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

`--action` に指定できるのは `diff`、`sync`、`try`、`merge`、`delete` の5種です。非インタラクティブのアクションには `--branch` が必須で、`delete` にはさらに `--yes` が必須です。`sync` が失敗した場合は終了コード `1` で終了します。

インタラクティブモードでは **Merge from root** を選択でき、ルートリポジトリの HEAD をワークツリーブランチにマージします。コンフリクト発生時は AI が自動解決を試みます。

### タスクディレクトリワークフロー（作成 / 実行 / 確認）

1. `takt add` を実行し、`.takt/tasks.yaml` に pending レコードが作成されたことを確認。
2. 生成された `.takt/tasks/{slug}/order.md` を開き、必要に応じて詳細な仕様や参考資料を追記。
3. `takt run`（または `takt watch`）を実行して `tasks.yaml` の pending タスクを実行。
4. `task_dir` と同じ slug の `.takt/runs/{slug}/reports/` で出力を確認。

## Pipeline モード

`--pipeline` を指定すると、非インタラクティブな pipeline モードが有効になります。ブランチの作成、workflow の実行、コミットとプッシュを自動的に行います。CI/CD 自動化に適しています。

```bash
# pipeline モードでタスクを実行
takt --pipeline --task "Fix bug"

# pipeline 実行 + PR 自動作成
takt --pipeline --task "Fix bug" --auto-pr

# Issue 情報をリンク
takt --pipeline --issue 99 --auto-pr

# workflow とブランチを指定
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# リポジトリを指定（PR 作成用）
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# workflow のみ実行（ブランチ作成、コミット、プッシュをスキップ）
takt --pipeline --task "Fix bug" --skip-git

# 最小出力モード（CI 向け）
takt --pipeline --task "Fix bug" --quiet
```

Pipeline モードでは`--auto-pr` を指定しない限り PR は作成されません。

**GitHub 連携:** GitHub Actions で TAKT を使用する場合は [takt-action](https://github.com/nrslib/takt-action) を参照してください。PR レビューやタスク実行を自動化できます。

## ユーティリティコマンド

### インタラクティブな workflow 選択

タスク引数なしで `takt` を実行すると、workflow をインタラクティブに選択できます。

```bash
takt
```

### takt eject

ビルトインの workflow/persona をローカルディレクトリにコピーしてカスタマイズします。

```bash
# ビルトインの workflow/persona をプロジェクト .takt/ にコピー
takt eject

# ~/.takt/（グローバル）にコピー
takt eject --global

# 特定のファセットをカスタマイズ用にエジェクト
takt eject persona coder
takt eject instruction plan --global
```

`eject` のファセット型は単数形（`persona`、`policy`、`knowledge`、`instruction`、`output-contract`）です（`takt catalog` は複数形を使います）。

workflow の正式ディレクトリ名は `workflows/` です。

### takt workflow

カスタム workflow の scaffold 作成と静的検証を行います。

```bash
# project .takt/workflows/ に minimal scaffold を作成
takt workflow init sample-flow

# ~/.takt/workflows/ に faceted scaffold を作成
takt workflow init review-flow --template faceted --global

# workflow 名または YAML パスを検証
takt workflow doctor sample-flow
takt workflow doctor .takt/workflows/sample-flow.yaml

# workflow の設定と解決ソースを検査
takt workflow inspect sample-flow
takt workflow inspect .takt/workflows/sample-flow.yaml
```

`takt workflow inspect` は workflow の設定と各解決値の由来を、実行時と同じ解決（`--auto-strategy` を含む）で報告します。

### takt clear

エージェントの会話セッションをクリア（状態のリセット）します。

```bash
takt clear
```

### takt export-cc

ビルトインの workflow/persona を Claude Code Skill としてデプロイします。

```bash
takt export-cc
```

### takt export-codex

TAKT のスキルファイルを Codex Skill（`~/.agents/skills/takt/`）としてデプロイします。
このコマンドは `SKILL.md`、`references/`、`agents/`、`workflows/`、`facets/` をデプロイします。

```bash
takt export-codex
```

### takt catalog

レイヤー間で利用可能なファセットの一覧を表示します。

```bash
takt catalog
takt catalog personas
```

`catalog` のファセット型引数は複数形（`personas`、`policies`、`knowledge`、`instructions`、`output-contracts`）です（`takt eject` は単数形を使います）。

### takt prompt

各 step とフェーズの組み立て済みプロンプトをプレビューします。

```bash
takt prompt
takt prompt default
```

### takt reset

設定をデフォルトにリセットします。

```bash
# グローバル設定をビルトインテンプレートにリセット（バックアップ付き）
takt reset config

# workflow カテゴリをビルトインのデフォルトにリセット
takt reset categories
```

### takt metrics

アナリティクスメトリクスを表示します。

```bash
# レビュー品質メトリクスを表示（デフォルト: 直近30日）
takt metrics review

# 時間枠を指定
takt metrics review --since 7d
```

### takt repertoire

Repertoire パッケージ（GitHub 上の外部 TAKT パッケージ）を管理します。

```bash
# GitHub からパッケージをインストール
takt repertoire add github:{owner}/{repo}@{ref}

# デフォルトブランチからインストール
takt repertoire add github:{owner}/{repo}

# インストール済みパッケージを一覧表示
takt repertoire list

# パッケージを削除
takt repertoire remove @{owner}/{repo}
```

インストールされたパッケージは `~/.takt/repertoire/` に保存され、workflow 選択やファセット解決で利用可能になります。

同名 workflow が複数箇所にある場合の探索順は `.takt/workflows/` → `~/.takt/workflows/` → builtin です。この名前解決の対象は project・user・builtin の 3 層だけで、repertoire の workflow は `@{owner}/{repo}/{workflow-name}` で明示的に参照します。

### takt telemetry

effective `auto_routing` が設定されているときに使うローカルのルーティングイベント記録を管理します。決定は `.takt/events/` に NDJSON としてローカル書き込みされ、TAKT がアップロードすることはありません。

```bash
# ローカルのルーティングイベント記録の状態を表示
takt telemetry status

# ローカルのルーティングイベント記録を有効化
takt telemetry enable

# ローカルのルーティングイベント記録を無効化
takt telemetry disable
```

### takt resume

現在のプロジェクトディレクトリで直近に中断（aborted）・失敗（failed）したダイレクト（ワンショット）run を対象に対話メニュー（Requeue / Retry / Instruct / View reports / Cancel）を表示します。worktree/クローン実行は対象外で、再実行のレポートは新しい run ディレクトリに出力します。

```bash
takt resume
```

### takt purge

古いアナリティクスイベントファイルを削除します。

```bash
# 30日以上前のファイルを削除（デフォルト）
takt purge

# 保持期間を指定
takt purge --retention-days 14
```
