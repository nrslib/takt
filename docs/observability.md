# Observability

[日本語](./observability.ja.md)

TAKT observability is opt-in. When disabled, workflow execution, session logs, provider events, and the existing `logging.usage_events` output keep their current behavior.

## Enable Phase Usage Events

Add this to `~/.takt/config.yaml` or `.takt/config.yaml`:

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

This writes phase-level usage events to:

```text
.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl
```

The phase usage stream is separate from the existing `logging.usage_events` file. It does not replace `logs/<session>-usage-events.jsonl`.

## Event Granularity

Records are grouped by workflow phase:

| Phase | Meaning |
|-------|---------|
| `phase1_execute` | Main step execution |
| `phase2_report` | Output contract/report generation |
| `phase3_structured` | Structured status judgment |
| `phase3_tag` | Tag fallback status judgment |
| `phase3_fallback` | AI judge fallback status judgment |

Missing usage is recorded with `usage_missing: true` and a reason. Missing usage is not treated as zero tokens by the analysis command.

## Analyze Usage

Build the project first:

```bash
npm run build
```

Then aggregate one or more files or run directories:

```bash
npm run analyze:usage -- .takt/runs/<run>/logs/*-usage-events.phase.jsonl
npm run analyze:usage -- .takt/runs/<run>
```

The default output is a Markdown table grouped by `step x phase x provider x model`.

Use CSV output for spreadsheets or downstream scripts:

```bash
npm run analyze:usage -- --format csv .takt/runs/<run> > usage.csv
```

The output columns are:

| Column | Meaning |
|--------|---------|
| `step` / `phase` / `provider` / `model` | Aggregation key |
| `runs` | Unique `run_id` count |
| `calls` | Number of phase usage records |
| `missing` | Records with unavailable usage |
| `input_tokens` / `output_tokens` / `total_tokens` | Token totals for records with usage |
| `cached_input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` | Cache-related token totals |
| `avg_total_tokens` / `median_total_tokens` / `stddev_total_tokens` | Per-call total token statistics, excluding missing usage |

For before/after comparisons, run the command separately for each set of run directories and compare the resulting tables or CSV files.
