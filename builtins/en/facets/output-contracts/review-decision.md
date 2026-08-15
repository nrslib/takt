```markdown
# Review Finding Adjudication

## Result: ACTIONABLE FINDINGS / NO ACTIONABLE FINDINGS / REPLAN REQUIRED

## Decision Summary
{Source reports, actionable family count, non-actionable count, and evidence summary}

## Requirement Decision Grounds
| Subject | Status | Grounds |
|---------|--------|---------|
| {Decomposed requirement or preceding finding} | {Fulfilled / Unfulfilled / Unverified / Resolved} | {Current-code file:line or a verification result already recorded in a preceding report} |

{{include:output-contracts/invariant-register-carry-forward}}

## Actionable Families
| family | Finding ID / source | Authorization basis | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|---------------------|---------------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {All IDs and report names} | {Direct acceptance-criterion violation / regression introduced by this diff / required consumer migration / accepted-family closure} | {file:line or reproduction evidence} | {Verified causal chain} | {Actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output} | {Observable completion conditions} | {Required minimal change; explicitly excluded neighboring contracts, adjacent work, or mechanisms} |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Authorization basis | Reason absent from initial round | Evidence |
|---------------------|--------------------|-------------|---------------|---------------------|----------------------------------|----------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {actionable / duplicate / false_positive / overreach / out_of_scope / no_issue_after_verification / environment_unverified} | {Actionable family or none} | {Authorization basis or none} | {Required only for a new follow-up finding; otherwise not applicable} | {Defect evidence, consolidation rationale, counter-evidence, or applicable criteria} |

## Unresolved Premises
- {None, or conflicting requirements, plan decisions, or findings and why replanning is required}
```

**Cognitive-load rules:**
- Record every submitted finding ID exactly once in Finding Dispositions
- Record an authorization basis for every actionable family, and also record why a new follow-up finding was absent from the initial round
- No actionable findings -> include only the summary, invariant-register carry-forward, finding dispositions, and unresolved premises
- Actionable findings -> consolidate findings with the same cause into one family and include every `actionable` and `duplicate` finding ID in its target family
- Findings with any other disposition are excluded from remediation and must not appear in an actionable family
