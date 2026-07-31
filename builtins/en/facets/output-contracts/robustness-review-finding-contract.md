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
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, keep supporting prose concise, include every verified finding and required machine claim, and aggregate locations with the same cause.
