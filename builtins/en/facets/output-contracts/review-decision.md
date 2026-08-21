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
| family | Responsible source | Observable invariant | Reason to change from the same cause | Finding ID / source | Authorization basis | Evidence | Problem -> root cause | Added path | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|--------------------|----------------------|--------------------------------------|---------------------|---------------------|----------|-----------------------|------------|-------------------------|---------------------|----------------------|
| {Stable family name; when findings in one family have different Authorization Bases, repeat the same family name in one row per basis} | {Single responsibility and source that defines the invariant and guarantees it holds} | {Condition to preserve} | {Why the paths need to change for the same cause} | {All IDs and report names with this row's Authorization Basis} | {The exact single machine value selected by the applicable policy} | {file:line or reproduction evidence} | {Verified causal chain; when a duplicate finding has a confirmed responsibility duplication or boundary bypass, retain that defect even if an excessive mechanism is excluded} | {New path checked in this review, or none} | {Actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output} | {Self-contained observable completion conditions verifiable from this row alone; include every relevant valid and invalid input class, precondition, dependency outcome, terminal result, preserved behavior, and prohibited expansion rather than relying on another row or column} | {Required minimal change; explicitly excluded neighboring contracts, adjacent work, or mechanisms} |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Reason to change from the same cause | Rationale | Authorization basis | Reason absent from initial round | Evidence |
|---------------------|--------------------|-------------|---------------|--------------------------------------|-----------|---------------------|----------------------------------|----------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {actionable / duplicate / false_positive / overreach / out_of_scope / no_issue_after_verification / environment_unverified} | {Actionable family or none} | {Same reason as the target family, reason for keeping a separate family, or not applicable} | {Reason for merging into the target family, keeping a separate family, or not applicable} | {For actionable/duplicate: this finding's exact single Authorization Basis, matching the target-family row with the same basis; otherwise none} | {Required only for a new follow-up finding; otherwise not applicable} | {Defect evidence, counter-evidence, or applicable criteria} |

## Unresolved Premises
- {None, or conflicting requirements, plan decisions, or findings and why replanning is required}
```

**Cognitive-load rules:**
- Record every submitted finding ID exactly once in Finding Dispositions
- Record exactly one machine Authorization Basis selected by the applicable policy for every actionable finding; reject prose labels and combined values. When findings in one family have different values, keep one family identity and repeat its name in one row per basis. Also record why a new follow-up finding was absent from the initial round
- No actionable findings -> include only the summary, invariant-register carry-forward, finding dispositions, and unresolved premises
- Actionable findings -> consolidate findings with the same cause under one family name and include every `actionable` and `duplicate` finding ID in the family row matching that finding's basis
- When an accepted duplicate finding confirms duplicated responsibility, an independent predicate, or a bypass of a shared boundary, preserve that concrete defect in Problem -> root cause and Acceptance criteria. Do not compress it to merely "use the shared helper"; make the absence of the duplicate predicate or boundary bypass a verifiable condition
- Findings with any other disposition are excluded from remediation and must not appear in an actionable family
- `Actionable Families` is the only selector-facing source of the current unresolved actionable set. Never copy a row there solely from carry-forward, requirement grounds, finding dispositions, or history
