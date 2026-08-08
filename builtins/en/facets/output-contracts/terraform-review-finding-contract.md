```markdown
# Terraform Convention Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
- [x] Variable declarations (type, description, sensitive)
- [x] Resource naming (name_prefix pattern)
- [x] File structure (one concern per file)
- [x] Security settings
- [x] Tag management
- [x] lifecycle rules
- [x] Cost trade-off documentation

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

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include every verified finding claim in the active Finding Contract format and aggregate locations with the same cause
