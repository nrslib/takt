```markdown
# Robustness Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
Use exactly two specialist tables in total: one row per external input in the input table and one row per failed operation in the failed-operation table.
| External Input | Hard Cap | Enforcement Point | Cost Before Cap | Metadata Anomaly | Corresponding Test |
|----------------|----------|-------------------|-----------------|------------------|--------------------|
| {input} | {cap} | {boundary} | {permitted work} | {reject or revalidate} | {test} |

| Failed Operation | Failure Type | May Continue | Caller / User Visibility | Partial-Success Result |
|------------------|--------------|--------------|--------------------------|------------------------|
| {operation} | {failure} | {continue or stop} | {notice or error} | {result or none} |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally. If the injected instructions require structured output, use that schema as the machine format; if they do not, return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, use the injected structured-output schema when one is present; otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, keep supporting prose concise while including every required machine claim.
