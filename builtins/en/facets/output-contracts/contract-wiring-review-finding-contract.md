```markdown
# Contract Wiring Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Wiring Evidence
| Entry / Execution Mode | Producer | Normalization / Validation | Handoff / Persistence | Consumer | Evidence |
|------------------------|----------|----------------------------|-----------------------|----------|----------|
| {entry or mode} | {producer} | {validator} | {handoff or persistence target} | {consumer} | `file:line` |
## Observed Findings
| # | family_tag | Severity | Location | Wiring Defect | Broken Contract | Fix Direction |
|---|------------|----------|----------|---------------|-----------------|---------------|
| 1 | contract-wiring | critical / high / medium / low | `file:line` | {value or behavior propagation defect} | {affected entry or consumer} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- A Wiring Evidence row must cite the line that performs that entry's handoff or persistence. Do not substitute a producer or cleanup line.
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- If the summary or wiring evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `contract-wiring` as its family_tag. Omit non-wiring defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary wiring evidence; for REJECT, include only relevant rows within 30 lines.
