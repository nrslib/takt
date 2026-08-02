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
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact | Fix Suggestion |
|---|------------|----------|----------|-------|--------|----------------|
| 1 | cqrs-violation | High / Medium / Low | `src/file.ts:42` | Issue description | Domain consistency or maintainability impact | Fix approach |
## Non-blocking / Out-of-scope Notes
- {Existing issue or item not fixed in this change; do not report it as a finding}

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE with no resolution confirmations → Summary and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- APPROVE with resolution confirmations → Summary, Resolution Confirmations, and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- REJECT → Include every verified finding and necessary resolution confirmation, aggregating locations with the same cause
