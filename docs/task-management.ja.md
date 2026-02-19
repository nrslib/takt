[English](./task-management.md)

# タスク管理

## 概要

TAKT は複数のタスクを蓄積してバッチ実行するためのタスク管理ワークフローを提供します。基本的な流れは次の通りです。

1. **`takt add`** -- AI との会話でタスク要件を精緻化し、`.takt/tasks.yaml` に保存
2. **タスクの蓄積** -- `order.md` ファイルを編集し、参考資料を添付
3. **`takt run`** -- すべての pending タスクを一括実行（逐次または並列）
4. **`takt list`** -- 結果を確認し、ブランチのマージ、失敗のリトライ、指示の追加

各タスクは隔離された共有クローン（オプション）で実行され、レポートを生成し、`takt list` でマージまたは破棄できるブランチを作成します。

## タスクの追加（`takt add`）

`takt add` を使用して `.takt/tasks.yaml` に新しいタスクエントリを作成します。

```bash
# インラインテキストでタスクを追加
takt add "Implement user authentication"

# GitHub Issue からタスクを追加
takt add #28
```

タスク追加時に次の項目を確認されます。

- **Piece** -- 実行に使用する piece（ワークフロー）
- **Worktree パス** -- 隔離クローンの作成場所（Enter で自動、またはパスを指定）
- **ブランチ名** -- カスタムブランチ名（Enter で `takt/{timestamp}-{slug}` が自動生成）
- **Auto-PR** -- 実行成功後に PR を自動作成するかどうか

### GitHub Issue 連携

Issue 参照（例: `#28`）を渡すと、TAKT は GitHub CLI（`gh`）を介して Issue のタイトル、本文、ラベル、コメントを取得し、タスク内容として使用します。Issue 番号は `tasks.yaml` に記録され、ブランチ名にも反映されます。

**要件:** [GitHub CLI](https://cli.github.com/)（`gh`）がインストールされ、認証済みである必要があります。

### インタラクティブモードからのタスク保存

インタラクティブモードからもタスクを保存できます。会話で要件を精緻化した後、`/save`（またはプロンプト時の save アクション）を使用して、即座に実行する代わりに `tasks.yaml` にタスクを永続化できます。

## タスクディレクトリ形式

TAKT はタスクのメタデータを `.takt/tasks.yaml` に、各タスクの詳細仕様を `.takt/tasks/{slug}/` に保存します。

### `tasks.yaml` スキーマ

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-foptng
    piece: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

フィールドの説明は次の通りです。

| フィールド | 説明 |
|-----------|------|
| `name` | AI が生成したタスクスラグ |
| `status` | `pending`、`running`、`completed`、または `failed` |
| `task_dir` | `order.md` を含むタスクディレクトリのパス |
| `piece` | 実行に使用する piece 名 |
| `worktree` | `true`（自動）、パス文字列、または省略（カレントディレクトリで実行） |
| `branch` | ブランチ名（省略時は自動生成） |
| `auto_pr` | 実行後に PR を自動作成するかどうか |
| `issue` | GitHub Issue 番号（該当する場合） |
| `created_at` | ISO 8601 タイムスタンプ |
| `started_at` | ISO 8601 タイムスタンプ（実行開始時に設定） |
| `completed_at` | ISO 8601 タイムスタンプ（実行完了時に設定） |

### タスクディレクトリのレイアウト

```text
.takt/
  tasks/
    20260201-015714-foptng/
      order.md          # タスク仕様（自動生成、編集可能）
      schema.sql        # 添付の参考資料（任意）
      wireframe.png     # 添付の参考資料（任意）
  tasks.yaml            # タスクメタデータレコード
  runs/
    20260201-015714-foptng/
      reports/           # 実行レポート（自動生成）
      logs/              # NDJSON セッションログ
      context/           # スナップショット（previous_responses など）
      meta.json          # 実行メタデータ
```

`takt add` は `.takt/tasks/{slug}/order.md` を自動作成し、`task_dir` への参照を `tasks.yaml` に保存します。実行前に `order.md` を自由に編集したり、タスクディレクトリに補足ファイル（SQL スキーマ、ワイヤーフレーム、API 仕様など）を追加したりできます。

## タスクの実行（`takt run`）

`.takt/tasks.yaml` のすべての pending タスクを実行します。

```bash
takt run
```

`run` コマンドは pending タスクを取得して、設定された piece を通じて実行します。各タスクは次の処理を経ます。

1. クローン作成（`worktree` が設定されている場合）
2. クローン/プロジェクトディレクトリでの piece 実行
3. 自動コミットとプッシュ（worktree 実行の場合）
4. 実行後フロー（`auto_pr` 設定時は PR 作成）
5. `tasks.yaml` のステータス更新（`completed` または `failed`）

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

### 中断されたタスクの復旧

`takt run` が中断された場合（プロセスクラッシュ、Ctrl+C など）、`running` ステータスのまま残ったタスクは次回の `takt run` または `takt watch` 起動時に自動的に `pending` に復旧されます。

## タスクの監視（`takt watch`）

`.takt/tasks.yaml` を監視し、タスクが追加されると自動実行する常駐プロセスを起動します。

```bash
takt watch
```

watch コマンドの動作は次の通りです。

- Ctrl+C（SIGINT）まで実行を継続
- `tasks.yaml` の新しい `pending` タスクを監視
- タスクが現れるたびに実行
- 起動時に中断された `running` タスクを復旧
- 終了時に合計/成功/失敗タスク数のサマリを表示

これは「プロデューサー-コンシューマー」ワークフローに便利です。一方のターミナルで `takt add` でタスクを追加し、もう一方で `takt watch` がそれらを自動実行します。

## タスクブランチの管理（`takt list`）

タスクブランチの一覧表示とインタラクティブな管理を行います。

```bash
takt list
```

リストビューでは、すべてのタスクがステータス別（pending、running、completed、failed）に作成日とサマリ付きで表示されます。タスクを選択すると、そのステータスに応じた操作が表示されます。

### 完了タスクの操作

| 操作 | 説明 |
|------|------|
| **View diff** | デフォルトブランチとの差分をページャで表示 |
| **Instruct** | AI との会話で追加指示を作成し、再実行 |
| **Try merge** | スカッシュマージ（コミットせずにステージング、手動レビュー用） |
| **Merge & cleanup** | スカッシュマージしてブランチを削除 |
| **Delete** | すべての変更を破棄してブランチを削除 |

### 失敗タスクの操作

| 操作 | 説明 |
|------|------|
| **Retry** | 失敗コンテキスト付きのリトライ会話を開き、再実行 |
| **Delete** | 失敗したタスクレコードを削除 |

### Pending タスクの操作

| 操作 | 説明 |
|------|------|
| **Delete** | `tasks.yaml` から pending タスクを削除 |

### Instruct モード

完了タスクで **Instruct** を選択すると、TAKT は AI とのインタラクティブな会話ループを開きます。会話には次の情報がプリロードされます。

- ブランチコンテキスト（デフォルトブランチとの差分統計、コミット履歴）
- 前回の実行セッションデータ（movement ログ、レポート）
- Piece 構造と movement プレビュー
- 前回の order 内容

どのような追加変更が必要かを議論し、AI が指示の精緻化を支援します。準備ができたら次の操作を選択できます。

- **Execute** -- 新しい指示でタスクを即座に再実行
- **Save task** -- 新しい指示でタスクを `pending` として再キューイングし、後で実行
- **Cancel** -- 破棄してリストに戻る

### Retry モード

失敗タスクで **Retry** を選択すると、TAKT は次の処理を行います。

1. 失敗の詳細を表示（失敗した movement、エラーメッセージ、最後のエージェントメッセージ）
2. Piece の選択を促す
3. どの movement から開始するかの選択を促す（デフォルトは失敗した movement）
4. 失敗コンテキスト、実行セッションデータ、piece 構造がプリロードされたリトライ会話を開く
5. AI の支援で指示を精緻化

リトライ会話は Instruct モードと同じ操作（実行、タスク保存、キャンセル）をサポートします。リトライのメモは複数のリトライ試行にわたってタスクレコードに蓄積されます。

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

利用可能なアクションは `diff`、`try`、`merge`、`delete` です。

## タスクディレクトリワークフロー

推奨されるエンドツーエンドのワークフローは次の通りです。

1. **`takt add`** -- タスクを作成。`.takt/tasks.yaml` に pending レコードが追加され、`.takt/tasks/{slug}/` に `order.md` が生成される。
2. **`order.md` を編集** -- 生成されたファイルを開き、必要に応じて詳細な仕様、参考資料、補足ファイルを追加。
3. **`takt run`**（または `takt watch`）-- `tasks.yaml` の pending タスクを実行。各タスクは設定された piece ワークフローを通じて実行される。
4. **出力を確認** -- `.takt/runs/{slug}/reports/` の実行レポートを確認（slug はタスクディレクトリと一致）。
5. **`takt list`** -- 結果を確認し、成功したブランチのマージ、失敗のリトライ、追加指示を行う。

## 隔離実行（共有クローン）

タスク設定で `worktree` を指定すると、各タスクは `git clone --shared` で作成された隔離クローン内で実行され、メインの作業ディレクトリをクリーンに保ちます。

### 設定オプション

| 設定 | 説明 |
|------|------|
| `worktree: true` | 隣接ディレクトリ（または `worktree_dir` 設定で指定した場所）に共有クローンを自動作成 |
| `worktree: "/path/to/dir"` | 指定パスにクローンを作成 |
| `branch: "feat/xxx"` | 指定ブランチを使用（省略時は `takt/{timestamp}-{slug}` が自動生成） |
| *(worktree を省略)* | カレントディレクトリで実行（デフォルト） |

### 仕組み

TAKT は `git worktree` の代わりに `git clone --shared` を使用して、独立した `.git` ディレクトリを持つ軽量クローンを作成します。これが重要な理由は次の通りです。

- **独立した `.git`**: 共有クローンは独自の `.git` ディレクトリを持ち、エージェントツール（Claude Code など）が `gitdir:` 参照をたどってメインリポジトリに戻ることを防ぎます。
- **完全な隔離**: エージェントはクローンディレクトリ内でのみ作業し、メインリポジトリを認識しません。

> **注意**: YAML フィールド名は後方互換性のため `worktree` のままです。内部的には `git worktree` ではなく `git clone --shared` を使用しています。

### エフェメラルなライフサイクル

クローンはエフェメラルなライフサイクルに従います。

1. **作成** -- タスク実行前にクローンを作成
2. **実行** -- クローンディレクトリ内でタスクを実行
3. **コミット & プッシュ** -- 成功時に変更を自動コミットしてブランチにプッシュ
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
  logs/{sessionId}.jsonl   # piece 実行ごとの NDJSON セッションログ
  meta.json                # 実行メタデータ（タスク、piece、開始/終了、ステータスなど）
  context/
    previous_responses/
      latest.md            # 最新の previous response（自動継承）
```

### レコードタイプ

| レコードタイプ | 説明 |
|--------------|------|
| `piece_start` | タスクと piece 名による piece の初期化 |
| `step_start` | Movement の実行開始 |
| `step_complete` | ステータス、内容、マッチしたルール情報を含む movement 結果 |
| `piece_complete` | Piece の正常完了 |
| `piece_abort` | 理由を伴う中断 |

### リアルタイム監視

実行中にログをリアルタイムで監視できます。

```bash
tail -f .takt/runs/{slug}/logs/{sessionId}.jsonl
```
