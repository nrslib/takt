```markdown
# Implementation Semantics Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
| State or Generated Identifier | Existing Namespace | Downstream Syntax | Concrete Failure Condition | Result |
|-------------------------------|--------------------|-------------------|----------------------------|--------|
| {target} | {existing input or reserved word} | {storage, display, or lookup} | {collision or inconsistency condition} | {verified result or unverified} |
## Re-scan Evidence
| Checked Chapters | Unverified Chapters (only when any) | Checked Route | Current Evidence | Result |
|------------------|------------------------------------|---------------|------------------|--------|
| Checked Chapters N/N | {unverified chapters; otherwise "none"} | {cumulative diff, code, and test} | {current file:line or execution evidence} | {verified result or unverified} |
## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / Finding Contract claim} |

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Even for APPROVE, include the one aggregated re-scan row; group locations with the same cause. Keep verification evidence concise, but do not omit or truncate any machine claim required by the active Finding Contract format.
