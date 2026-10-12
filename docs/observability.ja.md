# 可観測性

[English](./observability.md)

可観測性の機能は既定で無効です。利用する場合は以下の設定で有効にします。

## OTLP でローカル可視化する

まずローカルの可観測性環境を起動します。

```bash
docker compose -f docker-compose.observability.yml up -d
```

`~/.takt/config.yaml` または `.takt/config.yaml` で TAKT の observability を有効化します。

```yaml
observability:
  enabled: true
  monitor: true
  session_log_exporter: true
  usage_events_phase: true
```

`monitor: true` は run ごとのメトリクスを `.takt/runs/<run>/monitor.json` に出力します。`session_log_exporter: true` は OpenTelemetry の情報を session log 形式に変換し、`.takt/runs/<run>/logs/<session>-otel-session-shadow.jsonl` に記録します。ローカルファイルへの記録に OTLP endpoint は必要ありません。

OpenTelemetry HTTP exporter の送信先をローカル collector に向けて TAKT を実行します。

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
takt run
```

`observability.enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` の両方を設定すると、TAKT はローカル出力と併せて span とメトリクスを OTLP で送信します。endpoint を設定しなければローカル出力だけを使います。`observability.enabled: false` の場合は OTLP 環境変数があっても OpenTelemetry SDK を初期化しません。

Grafana は `http://127.0.0.1:3000` で開き、`takt` サービスを確認します。トレースではワークフロー、ステップ、各処理段階の実行状況を追えます。メトリクスはローカルの `monitor.json` と併せて送信されます。

## 送信されるメトリクス

TAKT は `observability.enabled: true` の場合に、次のカウンターを送信します。

| Metric | 主な属性 | 送信条件 |
|--------|----------|----------|
| `takt.token.input_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | プロバイダから入力・出力トークン数を取得できた場合。 |
| `takt.token.output_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | プロバイダから入力・出力トークン数を取得できた場合。 |
| `takt.token.cached_input_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | キャッシュされた入力トークン数を取得できた場合。 |
| `takt.token.estimated_cost_usd` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | 使用量と価格情報から費用を推定できた場合。 |
| `takt.provider.errors` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.provider.error_type` | プロバイダのエラーとリトライを種別ごとに記録します。 |
| `takt.quality_gate.results` | `takt.run.id`, `takt.workflow.name`, `takt.step.name`, `takt.quality_gate.name`, `takt.quality_gate.result` | コマンドによる品質ゲートの成否を記録します。 |
| `takt.workflow.loops_detected` | `takt.run.id`, `takt.workflow.name`, `takt.step.name` | 現在のステップでループを検出した場合。 |
| `takt.workflow.cycles_detected` | `takt.run.id`, `takt.workflow.name`, `takt.step.name` | 設定したループ監視のしきい値に到達した場合。 |

トークンのメトリクスにはプロバイダから取得できた使用量を使います。価格情報やモデル名が足りない場合は費用推定を送信しません。推定値の欠落を費用ゼロと解釈しないでください。

実行中のワークフローも Tempo で探せます。`workflow_start.<workflowName>` を検索するか、次のようにワークフロー名や run ID で絞り込んでください。

実行中のワークフローを探す Tempo TraceQL の例:

```traceql
{ resource.service.name = "takt" && span."takt.workflow.name" = "takt-default" }
{ resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
{ resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-review-flow" }
{ resource.service.name = "takt" && span."takt.task.summary" =~ ".*review flow.*" }
{ resource.service.name = "takt" && name =~ "workflow_start\\..*" }
```

workflow の完了時または中断時、observability が有効なら TAKT は `TraceQL discovery:` ブロックを出力します。同じ discovery 情報は `.takt/runs/<run>/meta.json` の `observability.traceDiscovery` に保存され、後から run を探すために使えます。生成される query は常に `takt.run.id` を含み、利用可能な task / git metadata に応じて `takt.task.pr_number`、`takt.task.issue_number`、`takt.git.branch` の filter を追加します。

CLI 出力例:

```text
TraceQL discovery:
  { resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
  { resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
  { resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-review-flow" }
```

ワークフローが中断・失敗した場合は、トレースの失敗属性で原因と対象ステップを確認できます。

| 属性 | 意味 |
|------|------|
| `takt.failure.kind` | `step_error`、`runtime_error`、`iteration_limit` などの abort 種別 |
| `takt.failure.step` | ネストした workflow をまたいで保持される最深の failing step |
| `takt.failure.reason` | sanitize 済みの abort reason |

OTLP export には base endpoint が必要です。

| 環境変数 | 用途 |
|----------|------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 必須の opt-in endpoint。TAKT はここから `/v1/traces` と `/v1/metrics` を派生させます。 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 任意の trace endpoint 上書き。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 任意の metric endpoint 上書き。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |

TAKT が明示的に解決・検証するのはこの endpoint 3種だけです。その他の標準 `OTEL_EXPORTER_OTLP_*` 環境変数（`_HEADERS`、`_TIMEOUT`、`_COMPRESSION` など）は TAKT では解釈せず、OpenTelemetry SDK にはそのまま届きます。子プロセスへの伝播はより厳格で、資格情報を含む変数（`_HEADERS`、クライアント証明書、クライアント鍵）は TAKT が渡す環境から除外され、非機微な変数のみ通過します。

OTLP export に使用する endpoint は絶対 `http` または `https` URL である必要があります。trace / metric 個別 endpoint だけを設定して base endpoint を設定していない場合、OTLP export には opt-in せず、TAKT はローカル exporter のみを使います。base endpoint が設定されている場合は個別 endpoint 上書きも run 開始前に検証されます。起動後に collector が停止しているなどの export 送信失敗が起きても、workflow run は阻害しません。

## 環境変数で observability を上書きする

`observability` の各フラグは config ファイルを編集せずにプロセス単位で上書きできます。

| 環境変数 | 上書き対象 |
|----------|-----------|
| `TAKT_OBSERVABILITY_ENABLED` | `observability.enabled` |
| `TAKT_OBSERVABILITY_MONITOR` | `observability.monitor` |
| `TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER` | `observability.session_log_exporter` |
| `TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE` | `observability.usage_events_phase` |

各変数は `true` または `false` を受け付け、`~/.takt/config.yaml` と `.takt/config.yaml` の値より優先されます。

command gate から起動される nested `takt` run にはobservability 設定と OTLP endpoint がこれらの環境変数経由で自動的に伝播します。credential を含む exporter 変数（`_HEADERS`、client certificate、client key）は伝播から除外されます。

## Phase Usage Events を有効化する

`~/.takt/config.yaml` または `.takt/config.yaml` に次を追加します。

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

phase 粒度の usage events は次に出力されます。

```text
.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl
```

この出力は既存の `logging.usage_events` とは別ファイルです。`logs/<session>-usage-events.jsonl` は置き換えません。

## イベント粒度

record は workflow phase ごとに分かれます。

| Phase | 意味 |
|-------|------|
| `phase1_execute` | step 本体の実行 |
| `phase2_report` | output contract / report 生成 |
| `phase3_structured` | structured output による status judgment |
| `phase3_tag` | tag fallback による status judgment |
| `phase3_fallback` | AI judge fallback による status judgment |

usage を取得できない場合は `usage_missing: true` と reason を記録します。分析コマンドでは missing usage を 0 token として扱わず、token 統計から除外します。

各 record にはstep で定義されている場合に `persona` と `tags` も含まれます。`persona` は文字列、`tags` は文字列配列で、値がない場合はフィールド自体を省略します。

## Usage を集計する

先に build します。

```bash
npm run build
```

その後、ファイルまたは run directory を渡して集計します。

```bash
npm run analyze:usage -- .takt/runs/<run>/logs/*-usage-events.phase.jsonl
npm run analyze:usage -- .takt/runs/<run>
```

デフォルト出力は `step x phase x provider x model` で集計した Markdown table です。

CSV が必要な場合は `--format csv` を使います。

```bash
npm run analyze:usage -- --format csv .takt/runs/<run> > usage.csv
```

出力列は次の通りです。

| Column | 意味 |
|--------|------|
| `step` / `phase` / `provider` / `model` | 集計キー |
| `runs` | unique な `run_id` 数 |
| `calls` | phase usage record 数 |
| `missing` | usage を取得できなかった record 数 |
| `input_tokens` / `output_tokens` / `total_tokens` | usage を取得できた record の token 合計 |
| `cached_input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` | cache 関連 token 合計 |
| `avg_total_tokens` / `median_total_tokens` / `stddev_total_tokens` | missing usage を除外した call 単位の total token 統計 |

before/after 比較ではそれぞれの run directory 群に対して別々にコマンドを実行し、出力された table または CSV を比較します。

## トークン使用量をまとめて確認する

`tools/token-usage.sh` を使うと、worktree とローカルの全ランのトークン使用量をタスク×ステップ単位で一覧できます。

```bash
./tools/token-usage.sh              # 直近10件（mock除外）
./tools/token-usage.sh --top 20     # 直近20件
./tools/token-usage.sh --csv        # CSV出力
./tools/token-usage.sh --all        # mock/0トークンのランも含む
./tools/token-usage.sh /path/to/dir # 指定ディレクトリをスキャン
```

デフォルトでは `../takt-worktrees/` と `.takt/runs/` の両方をスキャンします。`observability.usage_events_phase: true` が設定されている必要があります。

CSV 出力では `step` の後に `persona` と `tags` の列を追加します。tags は `|` で連結し、persona または tags が異なる record は別の行として集計します。

依存: `node`, `jq`
