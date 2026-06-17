# Observability

[English](./observability.md)

TAKT の observability は opt-in です。無効時は workflow 実行、session log、provider events、既存の `logging.usage_events` 出力の挙動を変えません。

## OTLP でローカル可視化する

ローカルの observability stack を起動します。

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

OpenTelemetry HTTP exporter の送信先をローカル collector に向けて TAKT を実行します。

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
takt run
```

`observability.enabled: true` かつ `OTEL_EXPORTER_OTLP_ENDPOINT` が設定されている場合、TAKT は config で有効化したローカル exporter を維持したまま、span と metric を OTLP で送信します。`OTEL_EXPORTER_OTLP_ENDPOINT` が未設定の場合はローカル exporter のみを使い、ネットワーク送信は行いません。`observability.enabled: false` の場合は、OTLP 環境変数が設定されていても OpenTelemetry SDK を初期化しません。

Grafana は `http://127.0.0.1:3000` で開き、`takt` service を確認します。trace は既存の workflow span tree（`workflow.<name>` の下に `step.<name>`、さらに phase / judge span）として表示され、metric はローカルの `monitor.json` 出力と並走して送信されます。

workflow がまだ実行中の場合、OpenTelemetry exporter は長時間生存する root `workflow.<name>` span が終了する前に、完了済みの child span を送信することがあります。Tempo でその active trace を見つけやすくするため、TAKT は root workflow span の下に短命の `workflow_start.<workflowName>` span も送信します。この補助 span は `takt.workflow.status = running` を含む workflow / run 属性を持ちますが、root、step、phase、judge span を置き換えたり改名したりしません。trace discovery 専用であり、shadow session log の canonical record には変換されません。

active workflow を探す Tempo TraceQL filter 例:

```traceql
{ resource.service.name = "takt" && span."takt.workflow.name" = "takt-default" }
{ resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
{ resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-finding-contract" }
{ resource.service.name = "takt" && span."takt.task.summary" =~ ".*finding contract.*" }
{ resource.service.name = "takt" && name =~ "workflow_start\\..*" }
```

workflow の完了時または中断時、observability が有効なら TAKT は `TraceQL discovery:` ブロックを出力します。同じ discovery 情報は `.takt/runs/<run>/meta.json` の `observability.traceDiscovery` に保存され、後から run を探すために使えます。生成される query は常に `takt.run.id` を含み、利用可能な task / git metadata に応じて `takt.task.pr_number`、`takt.task.issue_number`、`takt.git.branch` の filter を追加します。

CLI 出力例:

```text
TraceQL discovery:
  { resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
  { resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
  { resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-finding-contract" }
```

workflow が abort/error で終わった場合、root `workflow.<name>` span には step-level の failure 属性も記録されます。

| 属性 | 意味 |
|------|------|
| `takt.failure.kind` | `step_error`、`runtime_error`、`iteration_limit` などの abort 種別 |
| `takt.failure.step` | abort 記録時点の current workflow step |
| `takt.failure.reason` | sanitize 済みの abort reason |

OTLP export には base endpoint が必要です。

| 環境変数 | 用途 |
|----------|------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 必須の opt-in endpoint。TAKT はここから `/v1/traces` と `/v1/metrics` を派生させます。 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 任意の trace endpoint 上書き。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 任意の metric endpoint 上書き。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |

OTLP export に使用する endpoint は絶対 `http` または `https` URL である必要があります。trace / metric 個別 endpoint だけを設定して base endpoint を設定していない場合、OTLP export には opt-in せず、TAKT はローカル exporter のみを使います。base endpoint が設定されている場合は、個別 endpoint 上書きも run 開始前に検証されます。起動後に collector が停止しているなどの export 送信失敗が起きても、workflow run は阻害しません。

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

before/after 比較では、それぞれの run directory 群に対して別々にコマンドを実行し、出力された table または CSV を比較します。
