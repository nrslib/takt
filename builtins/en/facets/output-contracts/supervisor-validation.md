```markdown
# Final Validation Results

## Result: APPROVE / REJECT / BLOCKED

## Requirements Fulfillment Check
| # | Decomposed Requirement | Original Requirement Source | Status | Basis |
|---|------------------------|-----------------------------|--------|-------|
| 1 | {Requirement} | {Location in the task specification} | {Fulfilled / Unfulfilled / Cannot determine} | {Current-code file:line or a statement in a preceding report} |

{{include:output-contracts/invariant-register-carry-forward}}

## Re-evaluation of Prior Findings
| Finding ID / Source | Original Acceptance Criteria | Resolution Status | Basis |
|---------------------|------------------------------|-------------------|-------|
| {ID and report name} | {Original finding acceptance criteria} | {Resolved / Unresolved / false_positive / overreach} | {Current-code file:line or a statement in a preceding report} |

## Actionable Families
| family | Responsible source | Observable invariant | Reason to change from the same cause | Finding ID / source | Evidence | Problem -> root cause | Added path | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|--------------------|----------------------|--------------------------------------|---------------------|----------|-----------------------|------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {Single responsibility and source that defines the invariant and guarantees it holds} | {Condition to preserve} | {Why the paths need to change for the same cause} | {All IDs and report names} | {file:line or a statement in a preceding report} | {Verified causal chain} | {New path checked in this review, or none} | {Actual contract paths} | {Observable completion conditions} | {Required minimal change and explicitly excluded scope} |

## Finding Dispositions
| Finding ID / source | Technical validity | Disposition | Target family | Reason to change from the same cause | Rationale | Evidence |
|---------------------|--------------------|-------------|---------------|--------------------------------------|-----------|----------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {actionable / duplicate / false_positive / overreach / out_of_scope / no_issue_after_verification / environment_unverified} | {Actionable family or none} | {Same reason as the target family, reason for keeping a separate family, or not applicable} | {Reason for merging into the target family, keeping a separate family, or not applicable} | {Current-code file:line or a statement in a preceding report} |

## Reason the Decision Cannot Be Made (when BLOCKED)
- {Requirement that current code and preceding reports cannot decide, required external decision or information, and why task-scope code changes cannot provide it}
```

**Cognitive-load rules:**
- Select APPROVE only when every requirement is fulfilled, every preceding finding is resolved, and the recurrence register has been carried forward under the invariant-recurrence rules
- Select REJECT only when an unfulfilled requirement or unresolved finding is recorded as an actionable family
- Select BLOCKED only when current code and preceding reports cannot decide a requirement and task-scope code changes cannot provide the required external decision or information
- Do not request or inspect machine-gate execution status, results, or logs, including tests and builds, and do not use their absence as a reason for REJECT or BLOCKED
- Include in `Actionable Families` only problems that support the current `REJECT`; never copy a row there solely from carry-forward, requirements fulfillment, prior-finding re-evaluation, finding dispositions, or history
