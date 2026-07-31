```markdown
# Failure Boundary Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Failure-Boundary Evidence
| Operation | Required / Optional | Failure Class | Continue / Stop | Caller / User Visibility | Partial Result | Evidence |
|-----------|---------------------|---------------|-----------------|--------------------------|----------------|----------|
| {operation} | {required or optional} | {failure type} | {continue or stop} | {notice or error} | {preserved result or none} | `file:line` |
## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- When containment, caller or user visibility, and partial-result preservation occur on different lines, use separate Failure-Boundary Evidence rows with direct evidence for each fact.
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- If the summary or failure-boundary evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `failure-boundary` as its family_tag. Omit non-boundary defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary failure-boundary evidence; for REJECT, keep supporting prose concise while including every required machine claim.
