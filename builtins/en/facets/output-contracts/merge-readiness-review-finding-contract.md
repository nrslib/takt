```markdown
# Merge Readiness Review

## Result: APPROVE / REJECT

## Summary
{Summarize merge readiness in 1-2 sentences}

## Fixed Evaluation Table
| Evaluation axis | Result | Evidence |
|-----------------|--------|----------|
| Requirement fulfillment | pass / fail | {evidence} |
| Impact on existing contracts and flows | pass / fail | {evidence} |
| Tests and verification | pass / fail | {evidence} |
| Out-of-scope changes and scope creep | pass / fail | {evidence} |
| Maintainability and ease of future change | pass / fail | {evidence} |
| Security, data protection, and operational risk | pass / fail | {evidence} |

## Observed Findings
| # | family_tag | Severity | Location | Problem | Impact or breaking condition | Fix direction |
|---|------------|----------|----------|---------|------------------------------|---------------|
| 1 | merge-readiness | high / medium / low | `file:line` | {currently observed defect} | {impact or condition} | {fix direction} |

## Resolution Confirmations
| Ledger reference | Original acceptance condition | Verification evidence |
|------------------|-----------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set. Keep Markdown and structured output 1:1.
- APPROVE means zero issues; REJECT means one or more issues.
```
