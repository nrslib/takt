```markdown
# Architecture Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
| Structure / Contract | Checked Route | Result |
|----------------------|---------------|--------|
| {design or wiring} | {code, entry, and test} | {verified result or unverified} |
## Re-scan Evidence
| Checked Chapters | Unverified Chapters (only when any) | Checked Route | Current Evidence | Result |
|------------------|------------------------------------|---------------|------------------|--------|
| Checked Chapters N/N | {unverified chapters; otherwise "none"} | {cumulative diff, code, and test} | {current file:line or execution evidence} | {verified result or unverified} |
## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact or Failure Condition | Fix Direction |
|---|------------|----------|----------|-------|-----------------------------|---------------|
| 1 | design-violation | high / medium / low | `file:line` | {current observed defect} | {impact or condition} | {fix direction} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Even for APPROVE, include the one aggregated re-scan row; group like targets and stay within 30 lines. For REJECT, include only relevant rows.
