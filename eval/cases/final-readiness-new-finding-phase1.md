# Final Validation Results

## Result: REJECT

## Requirements Fulfillment Check
| # | Decomposed Requirement | Original Requirement Source | Status | Basis |
|---|------------------------|-----------------------------|--------|-------|
| 1 | The project-configuration entry stores the normalized mode | Task acceptance criteria | Unfulfilled | `src/mode.js` stores the raw configuration value |

## Invariant Register Carry-forward
Carry-forward source: No prior remediation

| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|----------------|--------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|-------------------------------------------|-----------------------------|------------------|

## Re-evaluation of Prior Findings
| Finding ID / Source | Original Acceptance Criteria | Resolution Status | Basis |
|---------------------|------------------------------|-------------------|-------|
| OLD-REVIEW-readme-L1 | Exhaustive README examples | overreach | The current requirements provide no new counter-evidence |

## Actionable Families
| family | Finding ID / source | Authorization basis | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|---------------------|---------------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| mode-normalization | MERGE-NEW-mode-L1 | required consumer migration | `src/mode.js` project-configuration entry | The project-configuration consumer bypasses the shared normalization boundary | project configuration entry to stored mode | Both entries store the normalized supported mode | Change only the project-configuration consumer |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Authorization basis | Reason absent from initial round | Evidence |
|---------------------|--------------------|-------------|---------------|---------------------|----------------------------------|----------|
| MERGE-NEW-mode-L1 | Confirmed | actionable | mode-normalization | required_consumer_migration | Initial reviewer evidence covered only the CLI entry and did not inspect the project-configuration caller | `src/mode.js` stores the raw project setting |
| OLD-REVIEW-readme-L1 | Confirmed | out_of_scope | none | none | not applicable | The current requirements provide no new counter-evidence |

## Reason the Decision Cannot Be Made (when BLOCKED)
- Not applicable.
