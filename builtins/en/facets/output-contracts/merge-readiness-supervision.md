```markdown
# Final Merge-Readiness Adjudication

## Result: MERGEABLE / FIX REQUIRED / TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT

## Requirement and Evidence Summary
| Subject | State | Evidence |
|---------|-------|----------|
| {Decomposed requirement, quality gate, or prior finding} | {met / unmet / verified / unverified / resolved} | {file:line, report, or execution evidence} |

## Invariant Register Carry-forward
Carry-forward source: {Copy the value recorded in the current review-resolution.md unchanged}

| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|----------------|---------------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|-----------------------|-----------------------------|------------------|
| {Copy one invariant row from the Invariant Register Carry-forward in the current review-resolution.md unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} |

When the source statement is No prior remediation or Carry-forward source missing, copy it and its reason on the `Carry-forward source` line and do not create an invariant row for it.

### Mapping When a Name or Responsible Source Changed
- {None, or old family ID, invariant name, and responsible source (the single responsibility and source that defines the invariant and guarantees it holds) -> the three new values and the reason, copied unchanged from the current review-resolution.md; do not treat only moving or splitting files as a change}

## Actionable Families
| family | Finding ID | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {FINAL-NEW-* / FINAL-PERSIST-*} | {file:line or execution evidence} | {Verified causal chain} | {Entry, production, validation, consumption, and side effects} | {Observable completion conditions} | {Required minimal change; explicitly excluded adjacent work or mechanism} |

## Prior Finding Dispositions
| Finding ID | State | Evidence |
|------------|-------|----------|
| {ID} | {resolved / remains_open / adjudicated_non_actionable} | {Original acceptance criteria or adjudication and current evidence} |

## Unresolved Premises and Environmental Constraints
- {None, or the reason replanning or an environment change is required and the unverified scope}
```

**Cognitive-load rules:**
- MERGEABLE -> include only the requirement and evidence summary, invariant-register carry-forward, and prior finding dispositions
- FIX REQUIRED -> consolidate every confirmed blocker into families without omitting finding IDs or acceptance criteria
- TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT -> record why remediation cannot resolve the issue in unresolved premises and environmental constraints
