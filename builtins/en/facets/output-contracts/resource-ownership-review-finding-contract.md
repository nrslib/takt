```markdown
# Resource Ownership Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Ownership Evidence
| Resource | Acquisition / Owner | Transfer | Last Consumer | Release Scope | Path | Evidence |
|----------|---------------------|----------|---------------|---------------|------|----------|
| {resource} | {acquisition and owner} | {recipient or none} | {last consumer} | {release operation} | {success, early exit, failure, interruption, or retry} | `file:line` |
## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here as its own entry, using the labelled fields of the injected Finding Contract instructions (Target files / Description / Evidence). Do not state a severity, a severity-like label, or an issue-family tag. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- An Ownership Evidence row must cite a line that directly establishes acquisition or release scope. For APPROVE, show each entry's release line; for REJECT, show the acquisition line outside cleanup scope.
- Return ordinary Markdown report prose only. Do not return JSON or structured output. Do not assign final finding IDs.
- If the summary or ownership evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `resource-ownership` as its family_tag. Omit non-ownership defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary ownership evidence; for REJECT, keep supporting prose concise while including every required machine claim.
