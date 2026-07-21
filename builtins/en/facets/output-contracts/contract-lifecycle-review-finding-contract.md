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
## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact or Failure Condition | Fix Direction |
|---|------------|----------|----------|-------|-----------------------------|---------------|
| 1 | contract-lifecycle | high / medium / low | `file:line` | {current observed defect} | {impact or condition} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, include only relevant rows within 30 lines.
