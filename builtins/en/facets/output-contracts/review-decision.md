```markdown
# Review Finding Adjudication

## Result: ACTIONABLE FINDINGS / NO ACTIONABLE FINDINGS / REPLAN REQUIRED

## Decision Summary
{Source reports, actionable family count, non-actionable count, and evidence summary}

## Invariant Register Carry-forward
Carry-forward source: {Relative path of the selected fix-verification / No prior remediation / Carry-forward source missing: reason}

| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|---------------------|---------------------|-----------------------------|--------------------------------|---------------|--------------|--------------------------------------|-------------------------------|---------|-----------------------------|------------------|
| {Copy one invariant row from the selected single source unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} |

When the source statement is No prior remediation or Carry-forward source missing, keep it and its reason on the `Carry-forward source` line and do not create an invariant row for it.

Do not change a row in this table when a new finding is merged into an existing family. Record the merger by adding the finding ID, source, and affected contract path to the existing row in Actionable Families, and record the target family and rationale in Finding Dispositions.

### Mapping When a Name or Responsible Source Changed
- {None, or old family ID, invariant name, and responsible source (the single responsibility and source that defines the invariant and guarantees it holds) -> the three new values, with the reason; do not treat only moving or splitting files as a change}

## Actionable Families
| family | Responsible source | Observable invariant | Reason to change from the same cause | Finding ID / source | Authorization basis | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|--------------------|----------------------|--------------------------------------|---------------------|---------------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {Single responsibility and source that defines the invariant and guarantees it holds} | {Condition to preserve} | {Why the paths need to change for the same cause} | {All IDs and report names} | {Direct acceptance-criterion violation / regression introduced by this diff / required consumer migration / accepted-family closure} | {file:line or reproduction evidence} | {Verified causal chain} | {Actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output} | {Observable completion conditions} | {Required minimal change; explicitly excluded neighboring contracts, adjacent work, or mechanisms} |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Reason to change from the same cause | Authorization basis | Reason absent from initial round | Evidence |
|---------------------|--------------------|-------------|---------------|--------------------------------------|---------------------|----------------------------------|----------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {actionable / duplicate / false_positive / overreach / out_of_scope / no_issue_after_verification / environment_unverified} | {Actionable family or none} | {Same reason as the target family, reason for keeping a separate family, or not applicable} | {Authorization basis or none} | {Required only for a new follow-up finding; otherwise not applicable} | {Defect evidence, consolidation rationale, counter-evidence, or applicable criteria} |

## Unresolved Premises
- {None, or conflicting requirements, plan decisions, or findings and why replanning is required}
```

**Cognitive-load rules:**
- Record every submitted finding ID exactly once in Finding Dispositions
- Record an authorization basis for every actionable family, and also record why a new follow-up finding was absent from the initial round
- No actionable findings -> include only the summary, invariant-register carry-forward, finding dispositions, and unresolved premises
- Actionable findings -> consolidate findings with the same cause into one family and include every `actionable` and `duplicate` finding ID in its target family
- Findings with any other disposition are excluded from remediation and must not appear in an actionable family
