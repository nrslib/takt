# CLI リファレンス

[English](./cli-reference.md)

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
| `--provider <name>` | エージェント provider を上書き（claude\|claude-sdk\|claude-terminal\|codex\|opencode\|cursor\|copilot\|kiro\|mock） |
| `--model <name>` | エージェントモデルを上書き |
| `--config <path>` | グローバル設定ファイルのパス（デフォルト: `~/.takt/config.yaml`） |

正式オプションは `--workflow` です。

## インタラクティブモード

AI との会話を通じてタスク内容を精緻化してから実行するモードです。タスクの要件が曖昧な場合や、AI と相談しながら内容を詰めたい場合に便利です。

```bash
# インタラクティブモードを開始（引数なし）
takt

# 初期メッセージを指定（短い単語のみ）
takt hello
```

**注意:** `--task` オプションを指定するとインタラクティブモードをスキップして直接実行します。Issue 参照（`#6`、`--issue`）はインタラクティブモードの初期入力として使用されます。

### フロー

1. workflow を選択
2. インタラクティブモードを選択（assistant / persona / quiet / passthrough）
3. AI との会話でタスク内容を精緻化
4. `/go` でタスク指示を確定（`/go 追加の指示` のように追記も可能）、または `/play <task>` でタスクを即座に実行
5. 実行（workflow 実行、PR 作成）

### インタラクティブモードの種類

| モード | 説明 |
|--------|------|
| `assistant` | デフォルト。AI がタスク指示を生成する前に明確化のための質問を行う。 |
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

**注意:** 引数として文字列を渡す場合（例: `takt "Add login feature"`）は、初期メッセージとしてインタラクティブモードに入ります。

## Instant Exec モード

`takt exec` は、workflow YAML を手で書かずに TAKT の対話型タスク入力モードを開始します。アシスタントエージェントが依頼を明確化し、`/go` で会話を生成 workflow に変換し、ワーカーエージェントが実装し、レビューエージェントが結果をレビューし、必要な場合だけ再計画エージェントがユーザーに方向性を確認し、ループ検知が不毛な反復を防ぎます。

```bash
takt exec          # 前回設定を使用（初回はデフォルト）
takt exec backend  # 名前付きプリセットで開始
takt exec --list   # 利用可能な exec プリセットを表示
```

プリセットの探索順は project `.takt/exec/presets/`、global `$TAKT_CONFIG_DIR/exec/presets/`（未設定時は `~/.takt/exec/presets/`）、builtin `builtins/exec/presets/` です。builtin/default プリセットは、エージェントの役割、facet、ループ検知しきい値だけを定義します。provider と model は exec モード開始時に通常の TAKT 設定から解決され、assistant 対話、`/setup` 表示、workflow 生成で同じ解決結果が使われます。exec config で明示した場合だけ provider/model を上書きします。`effort` は明示設定された場合だけ出力されます。`/setup` で変更した設定は、次回起動用の設定として `$TAKT_CONFIG_DIR/exec.yaml`（未設定時は `~/.takt/exec.yaml`）に保存されます。

exec モード内の主なコマンド:

| コマンド | 説明 |
|----------|------|
| `/setup` | エージェント、replan facet、ループ検知しきい値、project/global preset を編集 |
| `/go` | 会話内容を実行用タスク指示に要約し、生成 workflow を実行 |
| `/go <note>` | 会話要約に追加メモを付けて実行 |
| `/cancel` | 実行せず終了 |

`/setup` では project/global プリセットの保存・削除ができます。Instruction、Knowledge、Policy は通常の facet 参照で、作成した facet は `.takt/facets/{instructions,knowledge,policies}/` または `$TAKT_CONFIG_DIR/facets/{instructions,knowledge,policies}/`（未設定時は `~/.takt/facets/{instructions,knowledge,policies}/`）に保存されます。

`/go` 実行時、TAKT は `.takt/exec/workflow.yaml` を生成し、既存の workflow engine で実行します。事前の会話もインラインのタスク本文もない `/go` は、workflow を作成する前に拒否されます。完了後は review result report を読み戻し、exec assistant セッションへ注入して最終サマリを返します。

生成される exec workflow は `session_key` でワーカーエージェント、レビューエージェント、再計画エージェント、ループ検知のセッションを分離します。ユーザー定義 workflow では通常の agent step、parallel sub-step、`loop_monitors.judge` にだけ `session_key` を指定できます。system step、workflow_call step、parallel parent step では指定できません。実際のセッションキーは解決済み provider を付けた形になります。

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
```

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

Pipeline モードでは、`--auto-pr` を指定しない限り PR は作成されません。

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
```

### takt resume

直近の失敗・中断したダイレクト（ワンショット）run を再開します。完了しなかった最新のダイレクト run を探し、最初からやり直すのではなく既存の run ディレクトリを再利用して止まったところから続行します。

```bash
takt resume
```

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

### takt prompt

各 step とフェーズの組み立て済みプロンプトをプレビューします。

```bash
takt prompt [workflow]
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

同名 workflow が複数箇所にある場合の探索順は `.takt/workflows/` → `~/.takt/workflows/` → builtin です。

### takt purge

古いアナリティクスイベントファイルを削除します。

```bash
# 30日以上前のファイルを削除（デフォルト）
takt purge

# 保持期間を指定
takt purge --retention-days 14
```
