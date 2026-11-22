# 可観測性

[English](./observability.md)

可観測性の機能は既定で無効です。利用する場合は以下の設定で有効にします。

## OTLP でローカル可視化する

まずローカルの可観測性環境を起動します。

```bash
docker compose -f docker-compose.observability.yml up -d
```

`~/.takt/config.yaml` または `.takt/config.yaml` で TAKT の可観測性機能を有効にします。

```yaml
observability:
  enabled: true
  monitor: true
  session_log_exporter: true
  usage_events_phase: true
```

`monitor: true` を指定すると、実行ごとのメトリクスを `.takt/runs/<run>/monitor.json` に出力します。`session_log_exporter: true` を指定すると、OpenTelemetry の情報をセッションログ形式に変換し、`.takt/runs/<run>/logs/<session>-otel-session-shadow.jsonl` に記録します。ローカルファイルへの記録に OTLP エンドポイントは必要ありません。

OpenTelemetry HTTP エクスポーターの送信先をローカルのコレクターに設定し、TAKT を実行します。

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
takt run
```

`observability.enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` の両方を設定すると、TAKT はローカル出力と併せてスパンとメトリクスを OTLP で送信します。エンドポイントを設定しなければローカル出力だけを使います。`observability.enabled: false` の場合は OTLP 環境変数があっても OpenTelemetry SDK を初期化しません。

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

実行中のワークフローも Tempo で探せます。`workflow_start.<workflowName>` を検索するか、次の TraceQL の例を使ってワークフロー名や run ID で絞り込んでください。

```traceql
{ resource.service.name = "takt" && span."takt.workflow.name" = "takt-default" }
{ resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
{ resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-review-flow" }
{ resource.service.name = "takt" && span."takt.task.summary" =~ ".*review flow.*" }
{ resource.service.name = "takt" && name =~ "workflow_start\\..*" }
```

可観測性機能が有効なら、TAKT はワークフローの完了時または中断時に `TraceQL discovery:` ブロックを出力します。この検索情報は `.takt/runs/<run>/meta.json` の `observability.traceDiscovery` にも保存され、後から実行記録を探すために使えます。生成するクエリには常に `takt.run.id` を含め、タスクや Git のメタデータに応じて `takt.task.pr_number`、`takt.task.issue_number`、`takt.git.branch` のフィルターを追加します。

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
| `takt.failure.kind` | `step_error`、`runtime_error`、`iteration_limit` などの中断種別 |
| `takt.failure.step` | ネストしたワークフローを含め、失敗した最も深いステップ |
| `takt.failure.reason` | サニタイズ済みの中断理由 |

OTLP で送信するには、共通のエンドポイントの指定が必要です。

| 環境変数 | 用途 |
|----------|------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 設定すると OTLP 送信が有効になります。TAKT はこの URL から `/v1/traces` と `/v1/metrics` の送信先を作ります。 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | トレースの送信先を個別に指定します。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | メトリクスの送信先を個別に指定します。`OTEL_EXPORTER_OTLP_ENDPOINT` も設定されている場合だけ使用します。 |

TAKT が値を解決・検証するのは、この3種類のエンドポイントだけです。その他の標準 `OTEL_EXPORTER_OTLP_*` 環境変数（`_HEADERS`、`_TIMEOUT`、`_COMPRESSION` など）は TAKT では解釈せず、そのまま OpenTelemetry SDK に渡します。子プロセスには機密情報を含まない変数だけを渡し、認証情報を含む変数（`_HEADERS`、クライアント証明書、クライアント鍵）は除外します。

OTLP の送信先は `http` または `https` の絶対 URL で指定してください。トレースやメトリクスの送信先だけを個別に設定し、共通のエンドポイントを設定していない場合は、ローカルのエクスポーターだけを使います。共通のエンドポイントを設定すると、個別の送信先も実行開始前に検証します。起動後にコレクターが停止するなどして送信に失敗しても、ワークフローの実行は妨げません。

## 環境変数で可観測性設定を上書きする

`observability` の各フラグは設定ファイルを編集せずに環境変数でプロセスごとに上書きできます。

| 環境変数 | 上書き対象 |
|----------|-----------|
| `TAKT_OBSERVABILITY_ENABLED` | `observability.enabled` |
| `TAKT_OBSERVABILITY_MONITOR` | `observability.monitor` |
| `TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER` | `observability.session_log_exporter` |
| `TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE` | `observability.usage_events_phase` |

各変数は `true` または `false` を受け付け、`~/.takt/config.yaml` と `.takt/config.yaml` の値より優先されます。

command gate から `takt` を入れ子で起動した場合も、これらの環境変数を通じて可観測性設定と OTLP エンドポイントが自動的に引き継がれます。認証情報を含むエクスポーターの変数（`_HEADERS`、クライアント証明書、クライアント鍵）は引き継ぎません。

## Phase Usage Events を有効化する

`~/.takt/config.yaml` または `.takt/config.yaml` に次を追加します。

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

処理段階ごとの使用量イベントは次のファイルに出力されます。

```text
.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl
```

この出力は既存の `logging.usage_events` とは別ファイルです。`logs/<session>-usage-events.jsonl` は置き換えません。

## イベント粒度

レコードはワークフローの処理段階ごとに分かれます。

| Phase | 意味 |
|-------|------|
| `phase1_execute` | ステップ本体の実行 |
| `phase2_report` | 出力契約に従った出力・レポートの生成 |
| `phase3_structured` | 構造化出力によるステータス判定 |
| `phase3_tag` | タグを使うフォールバックによるステータス判定 |
| `phase3_fallback` | AI を使うフォールバックによるステータス判定 |

使用量を取得できない場合は `usage_missing: true` と理由を記録します。分析コマンドでは使用量が欠けたレコードをトークンの統計から除外し、0 トークンとしては扱いません。

ステップに `persona` と `tags` が定義されていれば、各レコードにも含まれます。`persona` は文字列、`tags` は文字列配列で、値がない場合はフィールド自体を省略します。

## 使用量を集計する

先にビルドします。

```bash
npm run build
```

その後、ファイルまたは実行ディレクトリを指定して集計します。

```bash
npm run analyze:usage -- .takt/runs/<run>/logs/*-usage-events.phase.jsonl
npm run analyze:usage -- .takt/runs/<run>
```

デフォルトでは `step x phase x provider x model` の組み合わせごとに集計し、Markdown の表で出力します。

CSV が必要な場合は `--format csv` を使います。

```bash
npm run analyze:usage -- --format csv .takt/runs/<run> > usage.csv
```

出力列は次の通りです。

| Column | 意味 |
|--------|------|
| `step` / `phase` / `provider` / `model` | 集計キー |
| `runs` | 重複を除いた `run_id` 数 |
| `calls` | 処理段階ごとの使用量レコード数 |
| `missing` | 使用量を取得できなかったレコード数 |
| `input_tokens` / `output_tokens` / `total_tokens` | 使用量を取得できたレコードのトークン合計 |
| `cached_input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` | キャッシュ関連のトークン合計 |
| `avg_total_tokens` / `median_total_tokens` / `stddev_total_tokens` | 使用量の欠落を除外した、呼び出し単位の総トークン数の統計 |

変更前後を比較するには、それぞれの実行ディレクトリ群に対して別々にコマンドを実行し、出力された表または CSV を比較します。

## トークン使用量をまとめて確認する

`tools/token-usage.sh` を使うと、worktree とローカルの全ランのトークン使用量をタスク×ステップ単位で一覧できます。

```bash
./tools/token-usage.sh              # 直近10件（mock除外）
./tools/token-usage.sh --top 20     # 直近20件
./tools/token-usage.sh --csv        # CSV出力
./tools/token-usage.sh --all        # mock/0トークンのランも含む
./tools/token-usage.sh /path/to/dir # 指定ディレクトリをスキャン
```

デフォルトでは `../takt-worktrees/` と `.takt/runs/` の両方をスキャンします。使用量イベントを記録するには `observability.enabled: true` と `observability.usage_events_phase: true` の両方が必要です。

CSV 出力では `step` の後に `persona` と `tags` の列を追加します。`tags` は `|` で連結し、`persona` または `tags` が異なるレコードは別の行に集計します。

依存: `node`, `jq`
