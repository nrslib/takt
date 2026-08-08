```markdown
# CQRS+ES Review
## Result: APPROVE / REJECT
## Summary
{Summarize the result in 1-2 sentences}
## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Aggregate design | ✅ | - |
| Event design | ✅ | - |
| Command/Query separation | ✅ | - |
| Projections | ✅ | - |
| Eventual consistency | ✅ | - |
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

## Non-blocking / Out-of-scope Notes
- {Existing issue or item not fixed in this change; do not report it as a finding}

## Output Consistency
- Return ordinary Markdown report prose only. Do not return JSON or structured output. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE with no resolution confirmations → Summary and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- APPROVE with resolution confirmations → Summary, Resolution Confirmations, every required claim in the active Finding Contract format, and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- REJECT → Include every verified finding claim and necessary resolution confirmation in the active Finding Contract format, aggregating locations with the same cause
