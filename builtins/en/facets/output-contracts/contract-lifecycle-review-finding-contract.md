```markdown
# Contract Lifecycle Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
Use exactly two specialist tables in total: one row per requirement in the requirement table and one row per resource in the resource table.
| Requirement Unit | Public Entry / Execution Mode | Producer | Validator | Consumer | Corresponding Test |
|------------------|-------------------------------|----------|-----------|----------|--------------------|
| {requirement} | {entry or mode} | {producer} | {validator} | {consumer} | {test} |

| Resource | Owner / Transfer | Last Consumer | Release / Persist | Success / Failure / Interruption / Retry |
|----------|------------------|---------------|-------------------|-----------------------------------------|
| {resource} | {owner and transfer} | {last consumer} | {release or persistence} | {outcome by path} |
## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, keep supporting prose concise, include every verified finding and required machine claim, and aggregate locations with the same cause.
