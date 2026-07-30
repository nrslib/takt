```markdown
# CQRS+ES Review
## Result: APPROVE / REJECT
## Summary
{Summarize the result in 1-2 sentences}
## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Aggregate design | ✅ | - |
| Event design | ✅ | - |
| Command/Query separation | ✅ | - |
| Projections | ✅ | - |
| Eventual consistency | ✅ | - |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Non-blocking / Out-of-scope Notes
- {Existing issue or item not fixed in this change; do not report it as a finding}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE with no lifecycle claims → Summary only
- APPROVE with confirmations → Summary and the required claims in the active Finding Contract format
- REJECT → Include every related claim and necessary resolution confirmation in the active Finding Contract format
