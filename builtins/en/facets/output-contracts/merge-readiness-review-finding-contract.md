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
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues.
```
