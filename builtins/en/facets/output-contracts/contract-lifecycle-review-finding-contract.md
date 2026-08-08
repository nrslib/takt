```markdown
# Contract Lifecycle Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Verification Evidence
Use exactly two specialist tables in total: one row per requirement in the requirement table and one row per resource in the resource table.
| Requirement Unit | Public Entry / Execution Mode | Producer | Validator | Consumer | Corresponding Test |
|------------------|-------------------------------|----------|-----------|----------|--------------------|
| {requirement} | {entry or mode} | {producer} | {validator} | {consumer} | {test} |

| Resource | Owner / Transfer | Last Consumer | Release / Persist | Success / Failure / Interruption / Retry |
|----------|------------------|---------------|-------------------|-----------------------------------------|
| {resource} | {owner and transfer} | {last consumer} | {release or persistence} | {outcome by path} |
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
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary evidence; for REJECT, keep supporting prose concise, include every verified finding and required machine claim, and aggregate locations with the same cause.
