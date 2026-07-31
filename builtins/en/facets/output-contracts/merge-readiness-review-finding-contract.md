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

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues.
```
