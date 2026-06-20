# Token Saving Guide

[日本語](./token-saving.ja.md)

Use token-saving changes after measuring a baseline. Lower token counts are useful only when they also reduce total retries, loop count, wall time, or provider cost.

## Measure First

Enable phase-level usage events:

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

Build TAKT and analyze one or more runs:

```bash
npm run build
npm run analyze:usage -- .takt/runs/<run>
```

Compare by `step`, `phase`, `provider`, and `model`. Focus on repeated review loops, large `phase1_execute` prompts, and missing usage records before changing workflows.

## Reduce Workflow Cost

- Choose lighter builtin workflows such as `*-mini` when a task does not need the full planning/review loop.
- Use `provider_routing` to send cheaper or faster providers and models to low-risk steps.
- Route expensive models only to steps that need them, such as final review or difficult implementation steps.
- Split oversized tasks before running TAKT so each workflow has a smaller planning and review context.
- Shorten output contracts when a report does not need detailed prose.

## Keep Context Focused

- Keep personas, policies, knowledge, and instructions narrow to the step that uses them.
- Avoid shared-context bloat: do not attach broad knowledge files to every step if only one step needs them.
- Prefer task-specific facts over long copied background sections.
- Remove stale workflow-local facets when they are no longer referenced.

## Evaluate External Compression Proxies

External compression proxies should be evaluated only after baseline usage is known. Compare TAKT usage events before and after the proxy, and compare provider-side or proxy-side stats when available. A proxy is a loss if it lowers raw tokens but increases retries, review rejections, or total cost.

