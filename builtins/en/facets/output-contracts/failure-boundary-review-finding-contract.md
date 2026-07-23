```markdown
# Failure Boundary Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Failure-Boundary Evidence
| Operation | Required / Optional | Failure Class | Continue / Stop | Caller / User Visibility | Partial Result | Evidence |
|-----------|---------------------|---------------|-----------------|--------------------------|----------------|----------|
| {operation} | {required or optional} | {failure type} | {continue or stop} | {notice or error} | {preserved result or none} | `file:line` |
## Observed Findings
| # | family_tag | Severity | Location | Boundary Defect | Lost Result / Visibility | Fix Direction |
|---|------------|----------|----------|-----------------|--------------------------|---------------|
| 1 | failure-boundary | critical / high / medium / low | `file:line` | {classification, continuation, or visibility defect} | {affected result or notice} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- When containment, caller or user visibility, and partial-result preservation occur on different lines, use separate Failure-Boundary Evidence rows with direct evidence for each fact.
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- If the summary or failure-boundary evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `failure-boundary` as its family_tag. Omit non-boundary defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary failure-boundary evidence; for REJECT, include only relevant rows within 30 lines.
