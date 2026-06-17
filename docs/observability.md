# Observability

[日本語](./observability.ja.md)

TAKT observability is opt-in. When disabled, workflow execution, session logs, provider events, and the existing `logging.usage_events` output keep their current behavior.

## Visualize Locally with OTLP

Start the local observability stack:

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

Point the OpenTelemetry HTTP exporters at the local collector and run TAKT:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
takt run
```

When `observability.enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT` is set, TAKT sends spans and metrics through OTLP while keeping the local exporters enabled by config. Without `OTEL_EXPORTER_OTLP_ENDPOINT`, TAKT keeps using only the local exporters and does not send telemetry over the network. When `observability.enabled: false`, the OpenTelemetry SDK is not initialized even if OTLP environment variables are set.

Open Grafana at `http://127.0.0.1:3000` and inspect the `takt` service. Traces use the existing workflow span tree (`workflow.<name>` with `step.<name>` and phase or judge spans below it), and metrics are exported alongside the local `monitor.json` stream.

While a workflow is still running, OpenTelemetry exporters can deliver completed child spans before the long-lived root `workflow.<name>` span has ended. To make those active traces discoverable in Tempo, TAKT also emits a short-lived `workflow_start.<workflowName>` span under the root workflow span. This helper span carries the workflow and run attributes, including `takt.workflow.status = running`, but it does not replace or rename the root, step, phase, or judge spans. It is used only for trace discovery and is not converted into a canonical shadow session log record.

Useful Tempo TraceQL filters for active workflows include:

```traceql
{ resource.service.name = "takt" && span."takt.workflow.name" = "takt-default" }
{ resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
{ resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-finding-contract" }
{ resource.service.name = "takt" && span."takt.task.summary" =~ ".*finding contract.*" }
{ resource.service.name = "takt" && name =~ "workflow_start\\..*" }
```

After a workflow completes or aborts, TAKT prints a `TraceQL discovery:` block when observability is enabled. The same discovery data is saved in `.takt/runs/<run>/meta.json` under `observability.traceDiscovery` so the run can be found later. The generated queries always include `takt.run.id` and add filters for available task or git metadata, such as `takt.task.pr_number`, `takt.task.issue_number`, and `takt.git.branch`.

Example CLI output:

```text
TraceQL discovery:
  { resource.service.name = "takt" && span."takt.run.id" = "<run-id>" }
  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }
  { resource.service.name = "takt" && span."takt.task.issue_number" = 792 }
  { resource.service.name = "takt" && span."takt.git.branch" = "takt/816/implement-finding-contract" }
```

When a workflow aborts or errors, the root `workflow.<name>` span also records step-level failure attributes:

| Attribute | Meaning |
|-----------|---------|
| `takt.failure.kind` | Abort category, such as `step_error`, `runtime_error`, or `iteration_limit`. |
| `takt.failure.step` | Current workflow step when the abort was recorded. |
| `takt.failure.reason` | Sanitized abort reason. |

The base endpoint is required for OTLP export:

| Environment variable | Purpose |
|----------------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required opt-in endpoint. TAKT derives `/v1/traces` and `/v1/metrics` from it. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional absolute HTTP(S) trace endpoint override. Used only when `OTEL_EXPORTER_OTLP_ENDPOINT` is also set. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional absolute HTTP(S) metric endpoint override. Used only when `OTEL_EXPORTER_OTLP_ENDPOINT` is also set. |

Endpoint values used for OTLP export must be absolute `http` or `https` URLs. A trace or metric endpoint without `OTEL_EXPORTER_OTLP_ENDPOINT` does not opt in to OTLP export; TAKT keeps the local-only exporter set. When the base endpoint is set, any configured trace or metric override is validated before the run starts. Export delivery failures after startup, such as a stopped local collector, do not block the workflow run.

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
