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

## Problem-Family Completion Sweep
| Issue family / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / Finding Contract claim} |

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here as its own entry, using the labelled fields of the injected Finding Contract instructions (Target files / Description / Evidence). Do not add classification fields (Severity / Title / Family Tag / Relation) to a claim; classification and identity are decided downstream. Do not use a findings table. If there are no claims, write `None`.}

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- Return ordinary Markdown report prose only. Do not return JSON or structured output. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues.
```
