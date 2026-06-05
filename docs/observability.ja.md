# Observability

[English](./observability.md)

TAKT の observability は opt-in です。無効時は workflow 実行、session log、provider events、既存の `logging.usage_events` 出力の挙動を変えません。

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
