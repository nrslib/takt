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

開始元省略時は現在のデフォルトブランチを検出する。統合先省略時は作成時の `base_branch` 設定、未設定なら開始元と同じブランチを保存する。
登録後に `base_branch` 設定を変更しても、保存された `integrationBranch` は変わらない。
ローカルブランチは既存規則の `takt/<UTC日時>-goal-<UUID先頭8文字>`。
checkoutやindexは変更しない。既存ID・既存ブランチとの衝突は上書きせず拒否する。
保存時に失敗した場合は、今回作成したコミットのままの参照だけを削除する。
補償に失敗した場合も作成をエラーとして返す。

保存状態は `created`、`awaiting_merge`（人の取り込み待ち）、`completed`、モードは `local`。
確認記録は要約への確認であり、受け入れ条件を達成したという検証結果ではない。
一覧は正常な保存記録を `goals` に掲載し、破損した保存記録があれば
同じ応答の `errors` に `goalId` と `error` を追加し、MCPの `isError: true` を返す。
正常な記録だけの場合は従来の `{ "goals": [...] }` を返す。
パス検証、アクセス、走査対象の同一性検証の失敗は一覧全体のエラーとする。
詳細取得は破損した記録をエラーとして返す。`read-only` では保存ファイルを変更しない。
`manager` と `all` では未処理の終了イベントを回収し、操作後にキューの自動起動を判定する。
登録処理中または失敗後の、公開済み `goal.json` がないディレクトリは一覧に含めない。

## 保証範囲と未解決点

署名検証は、ホストが信頼した鍵の署名を持たないAIの自己申告を拒否する。
プロジェクト、目的、範囲外、受け入れ条件、作成経緯、明示した開始元・統合先を照合する。
確認記録IDをゴールIDとして使い、保存済みIDの再登録は拒否する。

ゴールの状態の正はプロジェクト内の `.takt/goals/`。作成時に署名を検証し、
以後の読込・イベント回収・タスク投入・取り込み・完成では、保存されたゴールの状態を使う。

署名だけでは、実際に人が操作したことや秘密鍵をAIが読めないことは証明できない。
`takt manager` は、メモリ内の鍵管理・TUI の明示的な承認・provider の能力制限で
これらの境界を実装する。手動で MCP を利用する場合は、ホスト側で鍵と確認操作を管理する。

Git参照とファイル公開は単一トランザクションではない。
強制終了では未登録ブランチが残る場合があり、一般的なクラッシュ復旧は提供しない。
一時停止・中止・見回り、GitHub 連携・director・CLI の一回分の指示は対象外。

## manager の質問と回答、通知

manager は `takt_ask_goal_question` で、ゴールに属する質問を回答待ちとして保存する。
本文に加え、選択肢・推奨・依存する作業単位のキー（`dependentWorkKeys`）を指定でき、
保存した質問IDが返る。`takt_list_goal_questions` と `takt_get_goal_question` で
回答状態と回答内容を読み、manager が自分で解決した質問は
`takt_withdraw_goal_question` で取り下げられる。

`takt_enqueue_goal_task` の `workKey` が回答待ちの質問の `dependentWorkKeys` に
含まれる場合、投入をツール側で拒否し、理由に質問IDを含める。
依存のない作業は進められ、回答済みまたは取り下げ済みの質問は投入を妨げない。

TUI には回答待ちの質問のゴール、本文、選択肢、推奨を表示する。
`/answer <質問ID>` を入力すると回答操作に入り、選択肢がある場合は
上下キーで選んで Enter で決定する。「自由記述」を選ぶか、選択肢がない場合は
回答を入力して Enter で保存する。Esc で回答操作から戻れる。
回答は TUI の操作として保存し、通常の会話やAIの「回答済み」という発言だけでは
回答の記録にならない。

回答と回答イベントはゴールの状態に保存する。そのゴール専用のセッションで
manager のターンを呼び出し、manager が回答を読んで依存の解けた作業を投入する。
処理に失敗した回答イベントは未処理のまま残り、次の起動または MCP 操作で再処理する。

質問の保存、人の取り込み待ち、完成、作業単位の取り込みはゴールの通知として保存する。
manager は `takt_notify_goal` で行き詰まり（`blocked`）や任意の出来事（`custom`）を、
本文と任意の重要度を添えて通知できる。有効な保存通知は次の TUI 起動時・発言時に表示する。
`TAKT_NOTIFY_WEBHOOK` が設定されていれば TAKT 本体から Slack にも送信する。
送信に失敗しても manager の処理は継続し、診断を保存して TUI に表示する。
Slack での返信は受信しない。種類別の有効・無効、既定値、設定の優先順位は
[設定ガイド](./configuration.ja.md#manager-の通知設定)を参照。

## manager の作業投入と実行

`takt_list_workflows` は repertoire を含む名前で解決できる workflow の名前と説明を返す。
呼び先を含め `merge_pr` と `close_pr` を持つ workflow は一覧から除外する。
`takt_enqueue_goal_task` は `cwd`、`goalId`、`purpose`、自己完結した指示書の `task`、
`workflow` を受け取る。ゴール用ブランチを土台に worktree を作り、PR 自動作成と
origin への公開を無効にする。実際に保存したタスク名と目的をゴールに記録する。
system step の `merge_pr` と `close_pr` は呼び先を含め投入時に拒否する。
取り込み・完成は次の MCP 操作で行う。manager が業務上の受け入れを判断し、ツールは所属・確認済み SHA と Git 操作の安全条件を検査する。

- `takt_merge_goal_task`: `cwd`、`goalId`、`taskName`、`expectedSha`。保存された成果ブランチをゴール用ブランチへマージし、作業単位の `integration` に取り込み元・確認 SHA・結果・成功後のゴール SHA を保存する。
- `takt_complete_goal`: `cwd`、`goalId`、`expectedSha`、`summary`（満たした受け入れ条件と根拠）。リポジトリの `manager.main_merge` に従い、保存された `integrationBranch` へ反映する。
- `takt_check_goal_completion`: `cwd`、`goalId`。人の取り込み待ちで保存された対象 SHA が保存された `integrationBranch` に含まれる場合だけ完成にする。
- `takt_get_goal_diff`: `cwd`、`goalId`、任意の `taskName`、`file`、`limit`。タスクとゴール、タスク省略時はゴールと保存された `integrationBranch` の差分一覧・増減行数・指定ファイル差分を返す。バイナリの行数は `null`。
- `takt_get_goal_history`: `cwd`、`goalId`、任意の `taskName`、`limit`。ゴールまたは成果のコミット履歴を返す。
- `takt_get_goal_relation`: `cwd`、`goalId`。保存された `integrationBranch` と比較した SHA、統合先への包含、ゴール側の先行コミット数を返す。

これらは `manager` と `all` のツールセットで利用できる。読み取りの `limit` は1〜50、既定50件。本文・取得中の保持量も制限し、省略は `truncated` で示す。rename は削除・追加として表示する。ファイル指定は literal path として扱い、外部 diff は実行しない。

取り込み先がルートを含むいずれかの worktree でチェックアウト中なら参照を変更せず、場所を返す。一時 clone は `clone --shared` で元リポジトリのオブジェクトを参照し、全オブジェクトの複製を避ける。コンフリクトでは一時 clone のマージを中断し、`conflicts` を返す。人のファイル・index・HEAD は変更しない。Git 成功後に記録が失敗した場合は実際の SHA と `recorded: false`、`recordError` を返す。再試行は包含を確認して二重取り込みを避ける。完成済みゴールには新規投入できない。

`manager.main_merge` はリポジトリ設定だけで指定でき、既定は `approve`。`auto` は manager の完成判断で取り込み先へ反映する。`approve`、または取り込み先がチェックアウト中の `auto` は、`completion` に対象ブランチ・SHA・概要・手順・理由を保存し、人の取り込み待ちにする。`summary` は manager が入力した受け入れ条件と根拠、`changeSummary` は取り込み前の統合先 SHA と承認対象 SHA の差分から生成した変更概要として別々に記録・返却する。変更概要には変更ファイル数、テキストの追加・削除行数、最大50件・Git 出力4096バイト以内のファイル一覧を含む。バイナリの行数は一覧で `null`。省略は `truncated`、取得上限によって集計も不完全な場合は `totalsTruncated` を付け、その集計値は取得できた完全なレコードのみの値となる。

取り込み先がチェックアウト中なら `approve` / `auto` ともに `worktrees` のパスと、その作業ツリーで実行する `git -C <path> merge ...` の手順を記録・返却する。未チェックアウトなら、同じリポジトリ内のブランチ切り替えが可能なクリーンな作業ツリーで `git switch` とマージを行う手順を示す。人が手元で取り込んだ後、次のターンの確認操作で完成する。

```yaml
manager:
  main_merge: approve
```

ゴールのタスクでは自動再投入と Caccia を実行しない。終了結果を保存すると manager が
ゴール専用のセッションで次の作業を判断する。呼び出しに失敗したイベントは未処理のまま残り、
次の manager 起動または MCP 操作で再処理する。保存した要約と起動失敗は TUI 起動時と次の発言時に表示する。

終了イベントが未保存の場合は、タスクに保存されたゴールID・run ID・結果から回復する。
イベントの要約・処理済み状態とゴール専用のセッションIDはゴールの状態に保存する。
同じタスク名・run ID を重複して記録しない。会話ターンでは全ゴールをロックせず、
MCP の書き込みごとに対象ゴールだけをロックする。終了ターンは対象ゴールのロック内で
イベントの記録・回復・manager の呼び出し・処理済み状態の保存を行う。

プロジェクトまたはグローバル設定で次を指定できる。各項目はプロジェクト設定を優先する。

```yaml
manager:
  auto_run: true
  default_workflow: default
```

`auto_run` の既定値は `true`。会話・終了ターンの終了時、MCP の投入後、および manager 起動時に
実行可能な pending があり、生きている実行所有者がいなければ、親から独立した `takt run` を起動する。
既存 run/watch が動いている間は追加起動しない。ログは `.takt/manager-logs/` に保存する。
起動した run は最初にプロジェクト単位の実行ロック（PID と開始時刻）を取得する。
同時に複数の入口が起動しても、ロックを取れた1つだけが実行し、他の run はすぐ終了する。
起動予約や採用待ちは保存しない。実行側はロック解放後にキューを読み直し、残った pending を起動する。
投入側はキュー保存後に所有者を確認するため、終了直前の投入もいずれかの側が起動を判定する。
起動失敗は専用の診断ロック内で `.takt/manager-run.json` に追記し、TUI に表示する。
`false` にすると投入済みタスクは手動の `takt run` または `takt watch` で実行する。
`default_workflow` は判断に迷った場合の候補であり、manager が別の workflow を選ぶこともできる。
