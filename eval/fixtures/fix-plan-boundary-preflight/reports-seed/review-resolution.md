# Review Finding Adjudication

## Result: ACTIONABLE FINDINGS

## Decision Summary
One submitted finding is actionable because two supported logical IDs can resolve to the same stored record. One unrelated documentation finding is out of scope.

## Requirement Decision Grounds
| Subject | Status | Grounds |
|---------|--------|---------|
| Distinct supported logical IDs retain distinct values after reload | Unfulfilled | `src/artifact-store.js:8` allows two IDs to select the same stored record. |
| Documentation formatting | Resolved | It does not affect the identity-preservation requirement. |

## Invariant Register Carry-forward
Carry-forward source: No prior remediation

| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|----------------|--------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|-------------------------------------------|-----------------------------|------------------|

## Actionable Families
| family | Finding ID / source | Authorization basis | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|---------------------|---------------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| artifact-identity | MERGE-NEW-artifact-identity-L8 / coding-review.md | Direct acceptance-criterion violation | `src/artifact-store.js:8` | Two distinct supported logical IDs can resolve to one stored record | candidate selection, write, read, snapshot, reload | Each supported ID reads its own value after reload; distinct IDs never alias; invalid input fails before storage is mutated | Change only identity encoding and persistence compatibility required by this family |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Authorization basis | Reason absent from initial round | Evidence |
|---------------------|--------------------|-------------|---------------|---------------------|----------------------------------|----------|
| MERGE-NEW-artifact-identity-L8 / coding-review.md | Confirmed | actionable | artifact-identity | Direct acceptance-criterion violation | Initial review found the storage collision | `src/artifact-store.js:8` |
| OLD-REVIEW-doc-example-L1 / coding-review.md | Confirmed | out_of_scope | none | none | not applicable | Documentation formatting is unrelated to identity preservation. |

## Unresolved Premises
- None.
