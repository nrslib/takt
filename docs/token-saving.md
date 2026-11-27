# Token Saving Guide

[日本語](./token-saving.ja.md)

Measure current usage first. Compare retries, loop count, elapsed time, and cost alongside token counts.

## Measure First

Enable usage events for each phase:

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

Build TAKT and analyze the run records:

```bash
npm run build
npm run analyze:usage -- .takt/runs/<run>
```

Compare by `step`, `phase`, `provider`, and `model`. Check repeated reviews, large `phase1_execute` prompts, and missing usage records before changing workflows.

## Reduce Workflow Cost

- Choose lighter builtin workflows such as `*-mini` for tasks that need fewer planning or review steps.
- Choose providers and models per step with runtime `provider.targets` or legacy [`provider_routing`](./configuration.md).
- Use costly models for steps that need them, such as difficult implementation or final review.
- Split large tasks before running TAKT to focus planning and review context.
- Keep output contracts brief when reports need little detail.

## Keep Context Focused

- Keep personas, policies, knowledge, and instructions narrow to the step that uses them.
- Pass a long knowledge file only to the step that needs it.
- Prefer task-specific facts to long background material.
- Remove stale workflow-local facets when they are no longer referenced.

## Evaluate External Compression Proxies

Compare TAKT usage events before and after introducing an external compression proxy. Check provider or proxy statistics when available. Evaluate changes in retries, rejected reviews, and total cost alongside token counts.
