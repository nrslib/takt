```markdown
# Coding Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
| Public Entry / Execution Mode | Success / Failure | Corresponding Test |
|-------------------------------|-------------------|--------------------|
| {entry or mode} | {expected outcome and failure} | {test} |

| Resource API | Success / Failure / Interruption | Cleanup / Residual Artifacts |
|--------------|----------------------------------|------------------------------|
| {API} | {outcome by path} | {cleanup and artifacts} |
## Re-scan Evidence
| Checked Chapters | Unverified Chapters (only when any) | Checked Route | Current Evidence | Result |
|------------------|------------------------------------|---------------|------------------|--------|
| Checked Chapters N/N | {unverified chapters; otherwise "none"} | {cumulative diff, code, and test} | {current file:line or execution evidence} | {verified result or unverified} |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally. If the injected instructions require structured output, use that schema as the machine format; if they do not, return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, use the injected structured-output schema when one is present; otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Keep verification evidence concise, but include every machine claim required by the active Finding Contract format without truncation.
