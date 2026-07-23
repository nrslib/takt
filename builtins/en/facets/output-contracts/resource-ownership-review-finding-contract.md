```markdown
# Resource Ownership Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Ownership Evidence
| Resource | Acquisition / Owner | Transfer | Last Consumer | Release Scope | Path | Evidence |
|----------|---------------------|----------|---------------|---------------|------|----------|
| {resource} | {acquisition and owner} | {recipient or none} | {last consumer} | {release operation} | {success, early exit, failure, interruption, or retry} | `file:line` |
## Observed Findings
| # | family_tag | Severity | Location | Ownership Defect | Leaking Path | Fix Direction |
|---|------------|----------|----------|------------------|--------------|---------------|
| 1 | resource-ownership | critical / high / medium / low | `file:line` | {acquisition, transfer, or release-scope defect} | {path that misses release} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- An Ownership Evidence row must cite a line that directly establishes acquisition or release scope. For APPROVE, show each entry's release line; for REJECT, show the acquisition line outside cleanup scope.
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- If the summary or ownership evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `resource-ownership` as its family_tag. Omit non-ownership defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary ownership evidence; for REJECT, include only relevant rows within 30 lines.
