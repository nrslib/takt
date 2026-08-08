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
{Describe every observed defect or explicit ledger lifecycle claim here as its own entry, using the labelled fields of the injected Finding Contract instructions (Target files / Description / Evidence). Do not add classification fields (Severity / Title / Family Tag / Relation) to a claim; classification and identity are decided downstream. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- When containment, caller or user visibility, and partial-result preservation occur on different lines, use separate Failure-Boundary Evidence rows with direct evidence for each fact.
- Return ordinary Markdown report prose only. Do not return JSON or structured output. Do not assign final finding IDs.
- If the summary or failure-boundary evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Report no defect outside failure boundaries; do not relabel one from another area.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary failure-boundary evidence; for REJECT, keep supporting prose concise while including every required machine claim.
