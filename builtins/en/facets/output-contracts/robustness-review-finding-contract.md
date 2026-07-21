```markdown
# Robustness Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
Use exactly two specialist tables in total: one row per external input in the input table and one row per failed operation in the failed-operation table.
| External Input | Hard Cap | Enforcement Point | Cost Before Cap | Metadata Anomaly | Corresponding Test |
|----------------|----------|-------------------|-----------------|------------------|--------------------|
| {input} | {cap} | {boundary} | {permitted work} | {reject or revalidate} | {test} |

| Failed Operation | Failure Type | May Continue | Caller / User Visibility | Partial-Success Result |
|------------------|--------------|--------------|--------------------------|------------------------|
| {operation} | {failure} | {continue or stop} | {notice or error} | {result or none} |
## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact or Failure Condition | Fix Direction |
|---|------------|----------|----------|-------|-----------------------------|---------------|
| 1 | robustness | high / medium / low | `file:line` | {current observed defect} | {impact or condition} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, include only relevant rows within 30 lines.
