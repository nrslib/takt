```markdown
# AI-Generated Code Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
| Assumption / Existing Contract | Checked Route | Result |
|-------------------------------|---------------|--------|
| {assumption or wiring} | {code, existing use, and test} | {verified result or unverified} |
## Re-scan Evidence
| Checked Chapters | Unverified Chapters (only when any) | Checked Route | Current Evidence | Result |
|------------------|------------------------------------|---------------|------------------|--------|
| Checked Chapters N/N | {unverified chapters; otherwise "none"} | {cumulative diff, code, and test} | {current file:line or execution evidence} | {verified result or unverified} |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Keep verification evidence concise, but include every machine claim required by the active Finding Contract format without truncation.
