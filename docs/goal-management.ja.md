# ローカルゴールの登録と実行

既存の `takt-mcp` は、ゴールを `.takt/goals/<UUID>/goal.json` に保存する。
`takt_create_goal` は `all` と `manager` のツールセットで利用でき、`takt_list_goals` と
`takt_get_goal` は `read-only` でも利用できる。

## manager の TUI から登録する（実験的）

`takt manager` を対話端末で起動すると、manager と会話して目的・範囲外・
受け入れ条件を整理できる。provider と model は既存の assistant と同じ設定で選ぶ。
表示された要約を TUI の承認操作で確認したときだけ、TAKT が確認記録へ署名し、
MCP 経由でローカルゴールを登録する。AI の発言だけでは承認されず、
要約の変更・却下・会話の中断で以前の承認対象は無効になる。

秘密鍵は起動ごとに生成し、TUI プロセスのメモリにだけ保持する。
MCP サーバーへ渡すのは公開鍵だけであり、秘密鍵をファイルに保存しない。
manager の AI による直接の書き込みとネットワーク操作を provider の層で禁止し、
変更は指定の manager MCP ツールだけを通す。読み取り用の道具は利用できる。
Claude・Codex・OpenCode に対応し、必要な能力を満たせない provider や
制限を緩める設定では起動時に失敗する。登録後は manager が着手できる作業を判断し、
ゴール用ブランチを土台にローカルのタスクを投入する。
Codex はセッションで使う CLI・作業ディレクトリ・設定の上書きで
`mcp list --json` を実行し、利用者・プロジェクトなどの設定を解決した
MCP サーバーを列挙する。TAKT の manager 用以外はセッションの設定で
無効にする。manager 用には固有のサーバー名を使い、既存設定に同名の
サーバーがある場合や、一覧の取得・解釈に失敗した場合は開始しない。
読み取り専用サンドボックスを使い、ネットワーク・Web 検索・Apps・
ブラウザー・plugin・hook を無効にする。利用者の設定ファイルは変更しない。

## 人の確認記録を準備する

以下は TUI を使わずに、ホスト側で確認記録を用意して MCP を利用する場合の手順。

人が管理する Ed25519 秘密鍵で、確認した要約のUTF-8バイト列を署名する。
秘密鍵はAIやMCPサーバーからアクセスできない場所で管理する。
公開鍵はホストの起動引数で指定し、ツール引数からは指定できない。
公開鍵が未設定の場合、読み取りは利用できるが作成は拒否する。

以下は人が操作する環境で実行する例。鍵の保存先はその環境に合わせて指定する。
実在する秘密鍵をリポジトリへ保存しない。

```bash
openssl genpkey -algorithm ED25519 -out confirmation.key
chmod 600 confirmation.key
openssl pkey -in confirmation.key -pubout -out confirmation.pub
```

次の内容を `summary.json` に保存し、人が目的・範囲外・受け入れ条件・作成経緯を確認する。
`projectRoot` はMCP呼び出しの `cwd` と同じ絶対パス。
`id` は未使用のUUID、日時と確認者は実際の確認を記録する。
開始元・統合先を明示するときは署名対象とツール引数の両方へ同じ値を追加する。

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

確認を終えてから、同じファイルのバイト列を署名し、ツールの引数を作る。
署名後に内容や改行を変更した場合は、人が再確認して署名し直す。

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

署名記録や署名を発行するMCPツールは提供しない。

## MCP起動と利用

MCPクライアントのstdioサーバー設定で、コマンド `takt-mcp` と次の引数を指定する。

```bash
takt-mcp --tool-set all --goal-confirmation-public-key /absolute/path/to/confirmation.pub
```

サーバーの作業ディレクトリをプロジェクトにする。許可ルートは起動時の作業ディレクトリ。
公開鍵は起動時に読み込み、そのサーバーの寿命中は同じ値を使う。
`takt_create_goal` へ `create-goal.json` の内容を渡すと、応答の `goal` に保存情報が返る。
`creationOrigin` は `human` または `director`。
`confirmation` 内の `payload` はJSON文字列、`signature` はBase64。

- `takt_list_goals`: `{ "cwd": "/absolute/path/to/project" }` → `{ "goals": [...] }`
- `takt_get_goal`: `{ "cwd": "/absolute/path/to/project", "goalId": "<UUID>" }` → `{ "goal": {...} }`

開始元省略時は現在のデフォルトブランチを検出する。統合先省略時は開始元と同じブランチを保存する。
ローカルブランチは既存規則の `takt/<UTC日時>-goal-<UUID先頭8文字>`。
checkoutやindexは変更しない。既存ID・既存ブランチとの衝突は上書きせず拒否する。
保存時に失敗した場合は、今回作成したコミットのままの参照だけを削除する。
補償に失敗した場合も作成をエラーとして返す。

保存状態は `created`、モードは `local`。
確認記録は要約への確認であり、受け入れ条件を達成したという検証結果ではない。
一覧は正常な保存記録を `goals` に掲載し、破損した保存記録があれば
同じ応答の `errors` に `goalId` と `error` を追加し、MCPの `isError: true` を返す。
正常な記録だけの場合は従来の `{ "goals": [...] }` を返す。
パス検証、アクセス、走査対象の同一性検証の失敗は一覧全体のエラーとする。
詳細取得は破損した記録をエラーとして返す。`read-only` では保存ファイルを変更しない。
`manager` と `all` では未処理の終了イベントと停止した起動予約を回収する。
登録処理中または失敗後の、公開済み `goal.json` がないディレクトリは一覧に含めない。

## 保証範囲と未解決点

署名検証は、ホストが信頼した鍵の署名を持たないAIの自己申告を拒否する。
プロジェクト、目的、範囲外、受け入れ条件、作成経緯、明示した開始元・統合先を照合する。
確認記録IDをゴールIDとして使い、保存済みIDの再登録は拒否する。

登録時の署名入力・公開鍵・確定したブランチ情報は、ホストのグローバル設定領域の
`goal-registrations/<正規化したプロジェクトルートのSHA-256>/<UUID>.json` に保存する。
秘密鍵は保存しない。`TAKT_CONFIG_DIR` がプロジェクト内を指す場合は登録証拠の保存先として拒否する。
manager の読込・イベント回収・タスク投入・判断記録では、この証拠の署名と保存ゴールを再照合する。
証拠がない既存ゴールや登録内容が改変されたゴールは診断を表示し、自動処理しない。
古い保存データから登録証拠を自動生成しない。`read-only` の一覧・詳細は構造読込による診断を維持する。

署名だけでは、実際に人が操作したことや秘密鍵をAIが読めないことは証明できない。
`takt manager` は、メモリ内の鍵管理・TUI の明示的な承認・provider の能力制限で
これらの境界を実装する。手動で MCP を利用する場合は、ホスト側で鍵と確認操作を管理する。

Git参照とファイル公開は単一トランザクションではない。
強制終了では未登録ブランチが残る場合があり、一般的なクラッシュ復旧は提供しない。
ゴール用ブランチへの取り込み・完成・main への反映、質問の保存・通知・
一時停止・中止・見回り、GitHub 連携・director・CLI の一回分の指示は対象外。

## manager の作業投入と実行

`takt_list_workflows` は workflow 名と説明を返す。
`takt_enqueue_goal_task` は `cwd`、`goalId`、`purpose`、自己完結した指示書の `task`、
`workflow` を受け取る。ゴール用ブランチを土台に worktree を作り、PR 自動作成と
origin への公開を無効にする。実際に保存したタスク名と目的をゴールに記録する。
system step の `merge_pr` と `close_pr` は呼び先を含め投入時に拒否する。
`takt_record_goal_decision` の `integrate` と `complete` は理由を記録するだけで、Git やゴール状態を変更しない。

ゴールのタスクでは自動再投入と Caccia を実行しない。終了結果を保存すると manager が
ゴール専用のセッションで次の作業を判断する。呼び出しに失敗したイベントは未処理のまま残り、
次の manager 起動または MCP 操作で再処理する。保存した要約と起動失敗は TUI 起動時と次の発言時に表示する。

結果を保存する処理は、ホスト設定領域の `goal-completions/<プロジェクトルートのSHA-256>/`
へ、ゴールID・タスク名・run ID・結果全体を結び付けた証拠を保存する。
直接通知と回収は登録証拠、対応タスク、完了証拠を照合し、検証したイベントだけを
managerへ渡す。イベントだけの旧保存データや、証拠のないタスク結果を自動承認しない。
同じタスク名・run ID のイベントが改変されていても、対応タスクとホスト証拠を確認できれば
結果・要約・処理済み状態をホスト側から復元し、重複せず回収する。
manager用MCPの一覧・詳細・判断記録の応答も照合済みのイベントを返し、
一般MCPと `read-only` の保存状態の診断読込は維持する。
要約と処理済み状態もホスト側へ保存し、ゴール側の保存途中で失敗した場合は次の回収で復元する。
完了ターンの再開IDは、同じプロジェクト・ゴール・providerのホスト証拠からだけ復元する。
`goal.json` の `sessions` だけにあるIDは再開に使わない。
応答にIDがない場合も、以前に証明された同じゴール・providerのIDを維持する。
証拠の保存に失敗しても実タスク結果を保持し、自動処理を止めて診断を記録する。

プロジェクトまたはグローバル設定で次を指定できる。各項目はプロジェクト設定を優先する。

```yaml
manager:
  auto_run: true
  default_workflow: default
```

`auto_run` の既定値は `true`。会話・終了ターンの終了時に実行可能な pending があり、
実行所有者も起動予約もなければ、親から独立した `takt run` を起動する。
既存 run/watch が動いている間は追加起動しない。ログは `.takt/manager-logs/` に保存する。
起動要求は所有権の採用まで保存する。manager 起動や MCP 操作の回収では、保存要求や
停止した未採用予約を回収し、未要求の pending だけから実行を開始しない。
要求と予約の正本はホスト設定領域の
`manager-runs/<プロジェクトルートのSHA-256>/manager-run.json` に保存する。
プロジェクト内の `.takt/manager-run.json` は起動失敗の診断用であり、そこに保存された
旧要求・旧予約から起動権限を復元しない。ホスト保存先がプロジェクト内に解決される場合も拒否する。
`false` にすると投入済みタスクは手動の `takt run` または `takt watch` で実行する。
`default_workflow` は判断に迷った場合の候補であり、manager が別の workflow を選ぶこともできる。
