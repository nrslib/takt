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
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally. If the injected instructions require structured output, use that schema as the machine format; if they do not, return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- When containment, caller or user visibility, and partial-result preservation occur on different lines, use separate Failure-Boundary Evidence rows with direct evidence for each fact.
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, use the injected structured-output schema when one is present; otherwise use ordinary report prose only. Do not assign final finding IDs.
- If the summary or failure-boundary evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `failure-boundary` as its family_tag. Omit non-boundary defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary failure-boundary evidence; for REJECT, keep supporting prose concise while including every required machine claim.
