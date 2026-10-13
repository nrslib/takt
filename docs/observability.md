# Observability

[日本語](./observability.ja.md)

Observability is disabled by default. Enable it with the settings below when needed.

## Visualize Locally with OTLP

First, start the local observability stack:

```bash
docker compose -f docker-compose.observability.yml up -d
```

Enable TAKT observability in `~/.takt/config.yaml` or `.takt/config.yaml`:

```yaml
observability:
  enabled: true
  monitor: true
  session_log_exporter: true
  usage_events_phase: true
```

`monitor: true` writes per-run metrics to `.takt/runs/<run>/monitor.json`. `session_log_exporter: true` converts OpenTelemetry information into session-log format at `.takt/runs/<run>/logs/<session>-otel-session-shadow.jsonl`. These local files do not need an OTLP endpoint.

Point the OpenTelemetry HTTP exporters at the local collector and run TAKT:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
takt run
```

With both `observability.enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT` set, TAKT sends spans and metrics through OTLP alongside local output. Without an endpoint, it uses local output only. With `observability.enabled: false`, OTLP environment variables do not initialize the OpenTelemetry SDK.

Open Grafana at `http://127.0.0.1:3000` and inspect the `takt` service. Traces show the workflow, steps, and execution phases. Metrics are sent alongside the local `monitor.json` output.

## Exported Metrics

TAKT emits these counters only when `observability.enabled: true`.

| Metric | Main attributes | Emitted when |
|--------|-----------------|--------------|
| `takt.token.input_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | Provider input and output token counts are available. |
| `takt.token.output_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | Provider input and output token counts are available. |
| `takt.token.cached_input_tokens` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | Cached input token counts are available. |
| `takt.token.estimated_cost_usd` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.step.name` | Usage and pricing information allow an estimate. |
| `takt.provider.errors` | `takt.run.id`, `takt.provider.name`, `takt.model.name`, `takt.provider.error_type` | Provider errors and retries are counted by type. |
| `takt.quality_gate.results` | `takt.run.id`, `takt.workflow.name`, `takt.step.name`, `takt.quality_gate.name`, `takt.quality_gate.result` | A command quality gate passes or fails. |
| `takt.workflow.loops_detected` | `takt.run.id`, `takt.workflow.name`, `takt.step.name` | A loop is detected in the current step. |
| `takt.workflow.cycles_detected` | `takt.run.id`, `takt.workflow.name`, `takt.step.name` | A configured loop threshold is reached. |

Token metrics use usage reported by the provider. If pricing information or the model name is missing, TAKT does not send a cost estimate. Do not treat a missing estimate as zero cost.

You can find a running workflow in Tempo. Search for `workflow_start.<workflowName>` or filter by workflow name or run ID as shown below.

Useful Tempo TraceQL filters for active workflows include:

```traceql
{ resource.service.name = "takt" && span."takt.workflow.name" = "takt-default" }
{ resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
{ resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-review-flow" }
{ resource.service.name = "takt" && span."takt.task.summary" =~ ".*review flow.*" }
{ resource.service.name = "takt" && name =~ "workflow_start\\..*" }
```

After a workflow completes or aborts, TAKT prints a `TraceQL discovery:` block when observability is enabled. The same discovery data is saved in `.takt/runs/<run>/meta.json` under `observability.traceDiscovery` so the run can be found later. The generated queries always include `takt.run.id` and add filters for available task or git metadata, such as `takt.task.pr_number`, `takt.task.issue_number`, and `takt.git.branch`.

Example CLI output:

```text
TraceQL discovery:
  { resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
  { resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
  { resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-review-flow" }
```

When a workflow is interrupted or fails, check its failure attributes for the cause and affected step:

| Attribute | Meaning |
|-----------|---------|
| `takt.failure.kind` | Abort category, such as `step_error`, `runtime_error`, or `iteration_limit`. |
| `takt.failure.step` | Deepest failing step preserved across nested workflows. |
| `takt.failure.reason` | Sanitized abort reason. |

The base endpoint is required for OTLP export:

| Environment variable | Purpose |
|----------------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required opt-in endpoint. TAKT derives `/v1/traces` and `/v1/metrics` from it. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional absolute HTTP(S) trace endpoint override. Used only when `OTEL_EXPORTER_OTLP_ENDPOINT` is also set. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional absolute HTTP(S) metric endpoint override. Used only when `OTEL_EXPORTER_OTLP_ENDPOINT` is also set. |

TAKT explicitly resolves and validates only these three endpoint variables. The other standard `OTEL_EXPORTER_OTLP_*` variables — such as `_HEADERS`, `_TIMEOUT`, and `_COMPRESSION` — are not interpreted by TAKT and reach the OpenTelemetry SDK unchanged. Child processes are handled more strictly: credential-bearing variables (`_HEADERS`, client certificate, and client key) are excluded from the environment TAKT passes to them, while non-sensitive variables pass through.

Endpoint values used for OTLP export must be absolute `http` or `https` URLs. A trace or metric endpoint without `OTEL_EXPORTER_OTLP_ENDPOINT` does not opt in to OTLP export; TAKT keeps the local-only exporter set. When the base endpoint is set, any configured trace or metric override is validated before the run starts. Export delivery failures after startup, such as a stopped local collector, do not block the workflow run.

## Override Observability via Environment Variables

Each `observability` config flag can be overridden per process without editing config files:

| Environment variable | Overrides |
|----------------------|-----------|
| `TAKT_OBSERVABILITY_ENABLED` | `observability.enabled` |
| `TAKT_OBSERVABILITY_MONITOR` | `observability.monitor` |
| `TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER` | `observability.session_log_exporter` |
| `TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE` | `observability.usage_events_phase` |

Each variable accepts `true` or `false` and takes priority over the values in `~/.takt/config.yaml` and `.takt/config.yaml`.

Nested `takt` runs launched from a command gate inherit the observability settings and OTLP endpoints through these environment variables automatically; credential-bearing exporter variables (`_HEADERS`, client certificate, and client key) are excluded from that propagation.

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

Each record also includes the step's `persona` and `tags` when defined. `persona` is a string, and `tags` is an array of strings. Missing values are omitted.

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

## Summarize token usage across runs

`tools/token-usage.sh` aggregates token usage across all worktree and local runs, broken down by task and step.

```bash
./tools/token-usage.sh              # latest 10 runs (excludes mock)
./tools/token-usage.sh --top 20     # latest 20 runs
./tools/token-usage.sh --csv        # CSV output
./tools/token-usage.sh --all        # include mock/zero-token runs
./tools/token-usage.sh /path/to/dir # scan a specific directory
```

By default it scans both `../takt-worktrees/` and `.takt/runs/`. Recording phase usage events requires both `observability.enabled: true` and `observability.usage_events_phase: true`.

CSV output includes `persona` and `tags` columns after `step`. Tags are joined with `|`, and records with different persona or tags are kept in separate rows.

Dependencies: `node`, `jq`
