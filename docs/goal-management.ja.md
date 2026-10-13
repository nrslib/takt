# ローカルゴールの登録と実行

`takt manager` では、目的、範囲外、受け入れ条件を対話で整理し、確認した内容をローカルゴールとして登録できます。ゴールはプロジェクトの `.takt/goals/<UUID>/goal.json` に保存されます。manager は実験的機能であり、タスクの自動実行には provider の利用料金がかかります。

## TUI でゴールを登録する

対話端末で `takt manager` を起動し、目的、範囲外、受け入れ条件を伝えます。表示された要約を確認し、TUI の承認操作で登録します。要約を変更した場合は、変更後の内容をあらためて確認してください。

登録後、manager はゴール用ブランチを土台にタスクを作成します。既定では投入済みタスクを自動実行します。自分で `takt run` または `takt watch` を起動したい場合は、プロジェクトまたはグローバルの設定で自動実行を無効にします。

```yaml
manager:
  auto_run: false
  default_workflow: default
```

`default_workflow` は manager が workflow を選ぶ際の候補です。設定と通知については[設定ガイド](./configuration.ja.md#manager-の通知設定)も参照してください。

manager は Claude、Codex、OpenCode に対応します。登録には TUI での承認が必要です。

## ゴールの操作

TUI に次のコマンドを単独の行で入力します。

| コマンド | 動作 |
|----------|------|
| `/pause <goalId>` | 新しいタスクの投入や取り込みを止めます。実行中のタスクは続行し、結果は再開後に処理します。 |
| `/resume <goalId>` | 一時停止を解除し、保留していた結果とタスクを処理します。 |
| `/abort <goalId>` | 確認後にゴールを中止します。実行中の所属タスクは中断され、中止したゴールは再開できません。 |
| `/answer <質問ID>` | manager からの質問に選択肢または自由記述で回答します。 |

`/abort` では対象と取り消せないことを確認してから確定します。中止後もゴールの記録とブランチは残ります。質問への回答は TUI の操作として保存され、回答待ちの質問に依存する作業は回答後に進められるようになります。通知の設定は[設定ガイド](./configuration.ja.md#manager-の通知設定)を参照してください。

## 作業の取り込みと完了

manager はゴール用ブランチを土台にタスクを実行します。タスクの成果をゴール用ブランチへ取り込み、受け入れ条件の達成を判断した後に統合先への反映に進みます。リポジトリの `.takt/config.yaml` で指定する `manager.main_merge` の既定値は `approve` で、人が取り込みを確認します。`auto` は manager の完成判断に従って統合先へ反映します。統合先が作業ツリーでチェックアウトされている場合は、`auto` でも人の取り込み待ちになります。

```yaml
manager:
  main_merge: approve
```

## 作業の分け方と確認

manager は、単独で確かめられる成果ごとに作業を分けます。ほかの作業が使う定義などは先に取り込んでから、それを使う作業を投入します。人が指定した順序を守ったうえで、互いの成果を必要とせず、変更対象を共有せず、どちらを先に取り込んでも指示書の前提が変わらない作業は、このプロジェクトの run / watch の同時実行数の上限まで同時に投入します。別のファイルでも同じ外部の資源を変える作業は順に進め、同じファイルの関係しない箇所だけを変える作業は同時に進めます。

互いの成果を含まない状態で実行した作業を複数取り込み、それらの成果が共通の仕様や状態、受け入れ条件でつながる場合、manager は完成の前に現在のゴール用ブランチの先端で確認します。つながらない成果には追加の確認を求めません。ある作業が必要な確認をすでに済ませている場合は、`takt_get_goal_history` に `taskName` を渡してその作業の履歴にほかの作業すべての取り込みが含まれることを確かめ、run の報告で確認の範囲を確かめたときだけ確認を省きます。

人が指定したテストの流し方や実行してはいけない操作などは、要約の `acceptanceCriteria` の先頭に「作業の制約:」として残り、当てはまる作業の指示書へ引き継がれます。これらは成果の合否の条件とは区別され、ゴール全体で最後に1回だけ行う確認は担当する作業が決められます。

## 止まったタスクのやり直しと片付け

ゴールのタスクが失敗（`failed`）や上限超過（`exceeded`）で止まった場合、manager は理由を確認し、次の MCP ツールでやり直すか片付けるかを選びます。どれも `manager` または `all` のツールセットで利用でき、対象はそのゴールに属するタスクだけです。

| ツール | 動作 |
|--------|------|
| `takt_requeue_goal_task` | 指示書はそのままで、止まったタスクを待機中に戻し、止まった位置から再開します。`retryNote` で追加の指示を渡せます。 |
| `takt_retry_goal_task` | 失敗したタスクの指示書を、修正した指示全文で置き換えてから待機中に戻します。上限超過のタスクには使えません。 |
| `takt_remove_goal_task` | 不要になった待機中のタスクを取り消すか、止まったタスクや取り込み済みのタスクを片付けます。理由（`reason`）の指定が必要です。片付けではタスクの作業用 clone やブランチを削除しますが、ゴールの記録は残ります。 |

失敗したタスクは、`startStep` で再開する位置を指定できます。入れ子になった workflow の位置は、ステップ名を `/` でつないで指定します（例: `development-core/implement`）。省略すると、保存された再開位置から始めます。保存された再開位置が使えない場合は、先頭からやり直さずにエラーになり、理由と指定できる `startStep` の一覧が返ります。一覧から位置を選んで呼び直してください。

やり直しても同じ原因で進まない場合や、manager の手段では解消できない場合、人の判断が必要な場合、manager はやり直しを重ねずに `blocked` の通知か質問で、理由、試したこと、人に必要な操作を伝えます。止めるのは影響する作業とその後続だけで、関係しない作業は続けます。manager 自身のイベント処理が失敗した場合も、理由を添えた `blocked` の通知が出ます（通知設定の `blocked` が有効な場合）。

## MCP から登録する

`takt-mcp` の `takt_create_goal` を使う場合は、人が確認した要約への Ed25519 署名とサーバー起動時に指定する公開鍵が必要です。鍵の生成と署名は AI や MCP サーバーからアクセスできないホスト側で行ってください。秘密鍵をリポジトリに保存しないでください。

まずリポジトリ外で鍵を用意します。

```bash
openssl genpkey -algorithm ED25519 -out confirmation.key
chmod 600 confirmation.key
openssl pkey -in confirmation.key -pubout -out confirmation.pub
```

次の要約を `summary.json` に保存し、実際の目的、範囲外、受け入れ条件、作成経緯、確認日時と確認者を確認します。`projectRoot` は MCP 呼び出しの `cwd` と同じ絶対パスを指定し、`id` には未使用の UUID を使います。

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "projectRoot": "/absolute/path/to/project",
  "objective": "ローカルのゴールを管理する",
  "outOfScope": ["GitHub連携"],
  "acceptanceCriteria": ["MCPから登録したゴールを読み取れる"],
  "creationOrigin": "human",
  "confirmedAt": "2026-10-04T14:43:00.000Z",
  "confirmedBy": "reviewer"
}
```

確認したファイルのバイト列を署名し、MCP ツールへ渡す引数を作ります。署名後に要約を変更した場合は確認と署名をやり直します。

```bash
node --input-type=module - confirmation.key summary.json > create-goal.json <<'JS'
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
const [keyPath, summaryPath] = process.argv.slice(2);
const bytes = readFileSync(summaryPath);
const payload = bytes.toString('utf8');
const { projectRoot, id, confirmedAt, confirmedBy, ...summary } = JSON.parse(payload);
const signature = sign(null, bytes, readFileSync(keyPath)).toString('base64');
process.stdout.write(JSON.stringify({
  cwd: projectRoot, ...summary, confirmation: { payload, signature }
}, null, 2));
JS
```

MCP クライアントの stdio サーバー設定では、コマンド `takt-mcp` と次の引数を指定します。サーバーの作業ディレクトリは対象プロジェクトにします。

```bash
takt-mcp --tool-set all --goal-confirmation-public-key /absolute/path/to/confirmation.pub
```

`takt_create_goal` に `create-goal.json` の内容を渡します。`takt_list_goals` と `takt_get_goal` は `read-only` ツールセットでも利用できます。

- `takt_list_goals`: `{ "cwd": "/absolute/path/to/project" }`
- `takt_get_goal`: `{ "cwd": "/absolute/path/to/project", "goalId": "<UUID>" }`

`manager` または `all` のツールセットでは、`takt_enqueue_goal_task` で作業を投入し、`takt_merge_goal_task` で成果をゴール用ブランチに取り込めます。完了時は `takt_complete_goal` を呼び、人の取り込み待ちになった場合は `takt_check_goal_completion` で統合先への反映を確認します。差分、履歴、ブランチの関係は `takt_get_goal_diff`、`takt_get_goal_history`、`takt_get_goal_relation` で確認できます。

MCP 登録時の署名は、表示した要約への確認を表します。秘密鍵と確認操作はホスト側で管理してください。
