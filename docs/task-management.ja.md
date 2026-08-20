# タスク管理

[English](./task-management.md) | [日本語](./task-management.ja.md) | [简体中文](./task-management.zh-CN.md)

## 概要

TAKT は複数のタスクを蓄積してバッチ実行するためのタスク管理ワークフローを提供します。基本的な流れは次の通りです。

1. **`takt add`** -- AI との会話でタスク要件を精緻化し、`.takt/tasks.yaml` に保存
2. **タスクの蓄積** -- `order.md` ファイルを編集し、参考資料を添付
3. **`takt run`** -- すべての pending タスクを一括実行（逐次または並列）
4. **`takt list`** -- 結果を確認し、ブランチのマージ、失敗のリトライ、指示の追加

各タスクは隔離クローン（オプション）で実行され、レポートを生成し、`takt list` でマージまたは破棄できるブランチを作成します。

## タスクの追加（`takt add`）

`takt add` を使用して `.takt/tasks.yaml` に新しいタスクエントリを作成します。

```bash
# インラインテキストでタスクを追加
takt add "Implement user authentication"

# GitHub Issue からタスクを追加
takt add #28
```

タスク追加時に次の項目を確認されます。

- **Workflow** -- 実行に使用する workflow
- **Base branch** -- 現在のブランチが `main`/`master` 以外の場合、それを base branch として使うかどうか
- **Worktree パス** -- 隔離クローンの作成場所（Enter で自動、またはパスを指定）
- **ブランチ名** -- カスタムブランチ名（Enter で `takt/{timestamp}-{slug}` が自動生成）
- **Auto-PR** -- 実行成功後に PR を自動作成するかどうか（デフォルト: Yes）
- **Draft PR** -- Auto-PR 有効時、PR を draft として作成するかどうか（`Create as draft?`）

### GitHub Issue 連携

Issue 参照（例: `#28`）を渡すと、TAKT は GitHub CLI（`gh`）を介して Issue のタイトル、本文、ラベル、コメントを取得し、タスク内容として使用します。Issue 番号は `tasks.yaml` に記録され、ブランチ名にも反映されます。

**要件:** [GitHub CLI](https://cli.github.com/)（`gh`）がインストールされ、認証済みである必要があります。

### インタラクティブモードからのタスク保存

インタラクティブモードからもタスクを保存できます。会話で要件を精緻化した後、`/save`（またはプロンプト時の save アクション）を使用して、即座に実行する代わりに `tasks.yaml` にタスクを永続化できます。

### MCP Client からのタスク保存

MCP client は `takt-mcp` stdio server を使って、shell command を直接呼ばずに pending タスクを保存できます。`takt_enqueue_task` は `.takt/tasks.yaml` に pending レコードを書き込み、任意の `issue` object で既存 Issue を紐付けるか、設定済み TAKT issue provider で新規 Issue を作成します。Issue 作成後に保存が失敗し、Issue 番号まで解決済みなら、Issue は open のまま残り、MCP error result は再試行用の番号を返します。番号抽出に失敗した場合は、代わりに Issue URL を返すことがあります。この tool は絶対パスの `cwd` と空でないタスク本文を必須入力とします。pending タスクの実行には `takt run`、継続監視と実行には `takt watch` を使用してください。設定方法と tool 入力の詳細は [CLI リファレンス](./cli-reference.ja.md#mcp-server) を参照してください。

## タスクディレクトリ形式

TAKT はタスクのメタデータを `.takt/tasks.yaml` に、各タスクの詳細仕様を `.takt/tasks/{slug}/` に保存します。

### `tasks.yaml` スキーマ

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-implement-user-authentication
    workflow: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

フィールドの説明は次の通りです。

| フィールド | 説明 |
|-----------|------|
| `name` | AI が生成したタスクスラグ |
| `status` | `pending`、`running`、`completed`、`failed`、`exceeded`、または `pr_failed`（workflow は成功したが PR 作成/push に失敗） |
| `task_dir` | `order.md` を含むタスクディレクトリのパス |
| `workflow` | 実行に使用する workflow 名 |
| `worktree` | `true`（自動）、パス文字列、または省略（カレントディレクトリで実行） |
| `branch` | ブランチ名（省略時は自動生成） |
| `base_branch` | クローンと PR の base branch（`takt add` で選択した場合に設定） |
| `auto_pr` | 実行後に PR を自動作成するかどうか |
| `draft_pr` | 自動作成する PR を draft にするかどうか |
| `issue` | 設定済み issue provider の Issue 番号（該当する場合） |
| `run_slug` | `.takt/runs/` 配下の最新実行ディレクトリのスラグ |
| `failure` | 失敗タスクに記録される失敗詳細（`step`、`error`、`last_message`） |
| `created_at` | ISO 8601 タイムスタンプ |
| `started_at` | ISO 8601 タイムスタンプ（実行開始時に設定） |
| `completed_at` | ISO 8601 タイムスタンプ（実行完了時に設定） |

`tasks.yaml` には上記のほかに、TAKT が内部管理用に使用するフィールド（`slug`、`source_run_slug`、`resume_mode`、`owner_pid`、`auto_requeue_count`、`exceeded_*` など）が記録されることがあります。

### タスクディレクトリのレイアウト

```text
.takt/
  tasks/
    20260201-015714-implement-user-authentication/
      order.md          # タスク仕様（自動生成、編集可能）
      schema.sql        # 添付の参考資料（任意）
      wireframe.png     # 添付の参考資料（任意）
  tasks.yaml            # タスクメタデータレコード
  runs/
    20260201-020152-implement-user-authentication-x7k2pq/
      reports/           # 実行レポート（自動生成）
      logs/              # NDJSON セッションログ
      context/           # スナップショット（previous_responses など）
      operations/        # オペレーションジャーナル（journal.json）
      meta.json          # 実行メタデータ
```

run ディレクトリのスラグは実行ごとにランダムな6文字のサフィックスを付けて別採番されるため、タスクディレクトリのスラグとは一致しません。タスクの run ディレクトリを探すには、`tasks.yaml` の `run_slug` フィールドか `.takt/runs/` 配下の最新ディレクトリを確認してください。

`takt add` は `.takt/tasks/{slug}/order.md` を自動作成し、`task_dir` への参照を `tasks.yaml` に保存します。実行前に `order.md` を自由に編集したり、タスクディレクトリに補足ファイル（SQL スキーマ、ワイヤーフレーム、API 仕様など）を追加したりできます。

## タスクの実行（`takt run`）

`.takt/tasks.yaml` のすべての pending タスクを実行します。

```bash
takt run

# workflow の max_steps を無視して別の停止条件まで継続
takt run --ignore-exceed
```

`run` コマンドは pending タスクを取得して、設定された workflow を通じて実行します。各タスクは次の処理を経ます。

1. クローン作成（`worktree` が設定されている場合）
2. クローン/プロジェクトディレクトリでの workflow 実行
3. 自動コミットとプッシュ（worktree 実行の場合）
4. 実行後フロー（`auto_pr` 設定時は PR 作成）
5. `tasks.yaml` のステータス更新（`completed`、`failed`、または `exceeded`）

workflow が `max_steps` に到達した場合、通常の `takt run` はタスクを `exceeded` として停止し、`exceeded_max_steps`、`exceeded_current_iteration`、`resume_point` などの再実行メタデータを保存します。`--ignore-exceed` を付けると、この iteration limit だけを無視して workflow を継続し、exceeded 用の再実行メタデータは保存しません。

MCP client はタスクの enqueue だけを担当します。pending タスクの実行には `takt run`、継続監視と実行には `takt watch` を使用してください。

### 並列実行（Concurrency）

デフォルトではタスクは逐次実行されます（`concurrency: 1`）。`~/.takt/config.yaml` で並列実行を設定できます。

```yaml
concurrency: 3              # 最大3タスクを並列実行（1-10）
task_poll_interval_ms: 500   # 新規タスクのポーリング間隔（100-5000ms）
```

concurrency が 1 より大きい場合、TAKT はワーカープールを使用して次のように動作します。

- 最大 N タスクを同時実行
- 設定された間隔で新規タスクをポーリング
- ワーカーが空き次第、新しいタスクを取得
- タスクごとに色分けされたプレフィックス付き出力で読みやすさを確保
- Ctrl+C でのグレースフルシャットダウン（実行中タスクの完了を待機）

### 中断されたタスクのクリーンアップ

`takt run` が中断された場合（プロセスクラッシュ、Ctrl+C など）、`running` ステータスのまま残ったタスクは次回の `takt run` または `takt watch` 起動時に自動的に `failed` にマークされます。再実行する場合は明示的に requeue してください。

### 自動 Requeue

設定で `auto_requeue_max_attempts` を指定すると、失敗した workflow タスクは `takt run` 起動時に設定した回数を上限として自動的に requeue されます。デフォルトは `0`（手動 requeue のみ）です。詳細は[設定ガイド](./configuration.ja.md)を参照してください。

## タスクの監視（`takt watch`）

`.takt/tasks.yaml` を監視し、タスクが追加されると自動実行する常駐プロセスを起動します。

```bash
takt watch

# workflow の max_steps を無視して別の停止条件まで継続
takt watch --ignore-exceed
```

watch コマンドの動作は次の通りです。

- Ctrl+C（SIGINT）まで実行を継続
- `tasks.yaml` の新しい `pending` タスクを監視
- タスクが現れるたびに実行
- 起動時に中断された `running` タスクを `failed` にマーク
- 終了時に合計/成功/失敗タスク数のサマリを表示

これは「プロデューサー-コンシューマー」ワークフローに便利です。一方のターミナルで `takt add` でタスクを追加し、もう一方で `takt watch` がそれらを自動実行します。

## タスクブランチの管理（`takt list`）

タスクブランチの一覧表示とインタラクティブな管理を行います。

```bash
takt list
```

リストビューでは、すべてのタスクがステータス別（pending、running、completed、failed、exceeded、pr_failed）に作成日とサマリ付きで表示されます。タスクを選択すると、そのステータスに応じた操作が表示されます。一覧の最下部には、すべてのタスクを一括削除する **All Delete** も表示されます。

### 完了タスクの操作

| 操作 | 説明 |
|------|------|
| **View diff** | デフォルトブランチとの差分をページャで表示 |
| **Instruct** | AI との会話で追加指示を作成し、再実行 |
| **Create PR** | コミットして push し、タスクブランチからプルリクエストを作成 |
| **Merge from root** | ルートブランチの HEAD をタスクブランチにマージ。コンフリクトは AI が自動解決 |
| **Pull from remote** | リモート origin から最新の変更を取り込み（fast-forward のみ） |
| **Try merge** | スカッシュマージ（コミットせずにステージング、手動レビュー用） |
| **Merge & cleanup** | スカッシュマージしてブランチを削除 |
| **Delete** | すべての変更を破棄してブランチを削除 |

### 失敗タスクの操作

| 操作 | 説明 |
|------|------|
| **Requeue** | Resume または Restart の位置を選択し、会話を開かずタスクを `pending` に戻す |
| **Retry** | 失敗コンテキスト付きのリトライ会話を開き、再実行 |
| **Instruct** | run の作業ツリーに対して AI との会話で追加指示を作成し、requeue |
| **Create PR** | 失敗した run の変更をコミットして push し、プルリクエストを作成 |
| **Delete** | 失敗したタスクレコードを削除 |

### Pending タスクの操作

| 操作 | 説明 |
|------|------|
| **Delete** | `tasks.yaml` から pending タスクを削除 |

### Running タスクの操作

| 操作 | 説明 |
|------|------|
| **Mark as failed** | `running` のまま残ったタスクを `failed` にマーク |

### Exceeded タスクの操作

| 操作 | 説明 |
|------|------|
| **Requeue** | 停止した位置から再開する形でタスクを `pending` に戻す |
| **Delete** | タスクを完全に削除 |

### PR 失敗タスクの操作

`pr_failed` ステータスのタスク（workflow は成功したが PR 作成/push に失敗）は、PR のエラーメッセージを表示したうえで、**Create PR** を除く完了タスクと同じ操作を提供します。

### Instruct モード

完了タスクで **Instruct** を選択すると、TAKT は AI とのインタラクティブな会話ループを開きます。会話には次の情報がプリロードされます。

- ブランチコンテキスト（デフォルトブランチとの差分統計、コミット履歴）
- 前回の実行セッションデータ（step ログ、レポート）
- Workflow 構造と step プレビュー
- 前回の order 内容

どのような追加変更が必要かを議論し、AI が指示の精緻化を支援します。準備ができたら `/go` を実行し、指示書が生成された後に次の操作を選択できます。

- **Save as Task**（タスクにつむ）-- 新しい指示でタスクを `pending` として再キューイングし、後で実行
- **Continue editing**（会話を続ける）-- 会話を続けて指示をさらに精緻化

即座に再実行するには `/accept`（最新のアシスタント応答を使用）または `/replay`（前回の指示書を再投入）を使用します。中断してリストに戻るには `/cancel` を使用します。

失敗タスクの **Instruct** も同じ会話を使いますが、コミット済みブランチではなく run の未コミット作業ツリーを対象とします。会話には最終裁定レポートの要約（充足した要件、未解決の finding、未実証のゲート）と作業ツリー差分の概要が追加でプリロードされます。

### Retry モード

失敗タスクで **Retry** を選択すると、TAKT は次の処理を行います。

1. 失敗の詳細を表示（失敗した step、エラーメッセージ、最後のエージェントメッセージ）
2. Workflow の選択を促す
3. 単一のツリーから開始位置の選択を促す
4. 失敗コンテキスト、実行セッションデータ、workflow 構造がプリロードされたリトライ会話を開く
5. AI の支援で指示を精緻化

**Requeue** も同じ workflow と開始位置の選択を使用しますが、会話を開かずタスクを `pending` として保存します。開始位置の選択はワークフローをツリーとして表示します。先頭の行が **Resume failed position**（失敗地点から実行状態を引き継いで再開）で、その下に選択可能な葉として各 step が並びます。`workflow_call` 配下のサブワークフローは選択できない見出しとして子 step をインデント表示するため、確定できるのは常に葉の step であり、サブワークフロー自体は選べません。有効な Resume 位置がある場合は Resume 行を初期選択し、ない場合は失敗した root step に対応する選択可能な葉を初期選択します。いずれかの葉を選ぶと、その step から新しい実行を開始します。

Requeue 後は新しい namespace で実行されるため、台帳を引き継がず白紙で開始します。

`/go` の後、リトライ会話は Instruct モードと同じ選択肢（**Save as Task** / **Continue editing**）を提供し、即時再実行には `/accept` と `/replay`、中断には `/cancel` を使用します。保存と即時再実行のどちらも、選択した Resume または Restart の開始位置を使用します。リトライのメモは複数のリトライ試行にわたってタスクレコードに蓄積されます。

### 非インタラクティブモード（`--non-interactive`）

CI/CD スクリプト向けの非インタラクティブモードを使用できます。

```bash
# すべてのタスクをテキストで一覧表示
takt list --non-interactive

# すべてのタスクを JSON で一覧表示
takt list --non-interactive --format json

# 特定ブランチの差分統計を表示
takt list --non-interactive --action diff --branch takt/my-branch

# 特定ブランチをマージ
takt list --non-interactive --action merge --branch takt/my-branch

# ブランチを削除（--yes が必要）
takt list --non-interactive --action delete --branch takt/my-branch --yes

# Try merge（コミットせずにステージング）
takt list --non-interactive --action try --branch takt/my-branch
```

利用可能なアクションは `diff`、`sync`、`try`、`merge`、`delete` です。

## タスクディレクトリワークフロー

推奨されるエンドツーエンドのワークフローは次の通りです。

1. **`takt add`** -- タスクを作成。`.takt/tasks.yaml` に pending レコードが追加され、`.takt/tasks/{slug}/` に `order.md` が生成される。
2. **`order.md` を編集** -- 生成されたファイルを開き、必要に応じて詳細な仕様、参考資料、補足ファイルを追加。
3. **`takt run`**（または `takt watch`）-- `tasks.yaml` の pending タスクを実行。各タスクは設定された workflow を通じて実行される。
4. **出力を確認** -- `.takt/runs/{run_slug}/reports/` の実行レポートを確認。run slug は実行ごとに採番されるため、`tasks.yaml` の `run_slug` フィールドか `.takt/runs/` 配下の最新ディレクトリで確認する。
5. **`takt list`** -- 結果を確認し、成功したブランチのマージ、失敗のリトライ、追加指示を行う。

## 隔離実行（隔離クローン）

タスク設定で `worktree` を指定すると、各タスクは `git clone` で作成された隔離クローン内で実行され、メインの作業ディレクトリをクリーンに保ちます。

### 設定オプション

| 設定 | 説明 |
|------|------|
| `worktree: true` | `{project}/../takt-worktrees`（または `worktree_dir` 設定で指定した場所。親ディレクトリに書き込めない場合はプロジェクト内の `.takt/worktrees` にフォールバック）にクローンを自動作成 |
| `worktree: "/path/to/dir"` | 指定パスにクローンを作成 |
| `branch: "feat/xxx"` | 指定ブランチを使用（省略時は `takt/{timestamp}-{slug}` が自動生成） |
| *(worktree を省略)* | カレントディレクトリで実行（デフォルト） |

### 仕組み

TAKT は `git worktree` の代わりに `git clone --reference <メインリポジトリ> --dissociate` を使用して、独立した `.git` ディレクトリを持つクローンを作成します（reference 元のリポジトリが shallow の場合は素の `git clone` にフォールバックします）。これが重要な理由は次の通りです。

- **独立した `.git`**: クローンは独自の `.git` ディレクトリを持ち、エージェントツールが `gitdir:` 参照をたどってメインリポジトリに戻ることを防ぎます。
- **完全な隔離**: エージェントはクローンディレクトリ内でのみ作業し、メインリポジトリを認識しません。

> **注意**: YAML フィールド名は後方互換性のため `worktree` のままです。内部的には `git worktree` ではなく `git clone` を使用しています。

### エフェメラルなライフサイクル

クローンはエフェメラルなライフサイクルに従います。

1. **作成** -- タスク実行前にクローンを作成
2. **実行** -- クローンディレクトリ内でタスクを実行
3. **コミット & プッシュ** -- 成功時に変更を自動コミットしてメインリポジトリにプッシュ（`origin` へのプッシュは `auto_pr` などを指定した場合のみ）
4. **保持** -- 実行後もクローンを保持（instruct/retry 操作用）
5. **クリーンアップ** -- ブランチが永続的な成果物。`takt list` でマージまたは削除

### デュアルワーキングディレクトリ

worktree 実行中、TAKT は2つのディレクトリ参照を管理します。

| ディレクトリ | 用途 |
|------------|------|
| `cwd`（クローンパス） | エージェントの実行場所、レポートの書き込み先 |
| `projectCwd`（プロジェクトルート） | ログとセッションデータの保存先 |

レポートは `cwd/.takt/runs/{slug}/reports/`（クローン内）に書き込まれ、エージェントがメインリポジトリのパスを発見することを防ぎます。`cwd !== projectCwd` の場合、クロスディレクトリ汚染を避けるためセッション再開はスキップされます。

## セッションログ

TAKT は NDJSON（改行区切り JSON、`.jsonl`）形式でセッションログを書き込みます。各レコードはアトミックに追加されるため、プロセスがクラッシュしても部分的なログは保存されます。

### ログの場所

```text
.takt/runs/{slug}/
  logs/{sessionId}.jsonl   # workflow 実行ごとの NDJSON セッションログ
  meta.json                # 実行メタデータ（タスク、workflow、開始/終了、ステータスなど）
  operations/
    journal.json           # オペレーションジャーナル（内部実行レコード）
  context/
    previous_responses/
      latest.md            # 最新の previous response（自動継承）
```

observability が有効な場合、`meta.json` には完了時または中断時に TAKT が出力した Tempo TraceQL query を含む `observability.traceDiscovery` も保存されます。

### レコードタイプ

| レコードタイプ | 説明 |
|--------------|------|
| `workflow_start` | タスクと workflow 名による workflow の初期化 |
| `step_start` | Step の実行開始 |
| `step_complete` | ステータス、内容、マッチしたルール情報を含む step 結果 |
| `workflow_complete` | Workflow の正常完了 |
| `workflow_abort` | Workflow の中断（理由付き） |

### リアルタイム監視

実行中にログをリアルタイムで監視できます。

```bash
tail -f .takt/runs/{slug}/logs/{sessionId}.jsonl
```
