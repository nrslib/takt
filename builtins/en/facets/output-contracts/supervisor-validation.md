```markdown
# Final Validation Results

## Result: APPROVE / REJECT / BLOCKED

## Requirements Fulfillment Check
| # | Requirement | Source | Status | Evidence |
|---|-------------|--------|--------|----------|
| 1 | {Independently decidable requirement} | {Location in the task specification} | {Fulfilled / Unfulfilled / Cannot determine} | {Current-code file:line or a verification result in a preceding report} |

## Re-evaluation of Prior Findings
| Finding ID / Source | Acceptance Criteria | Status | Evidence |
|---------------------|---------------------|--------|----------|
| {ID and report name} | {Original acceptance criteria} | {Resolved / Unresolved / Unsupported / Unnecessary expansion} | {Current-code file:line or a verification result in a preceding report} |

## Unresolved Problems
| Problem ID | Related Requirement or Finding | Violated Condition | Cause | Relevant Paths | Evidence | Completion Criteria | Required Action |
|------------|--------------------------------|--------------------|-------|----------------|----------|---------------------|-----------------|
| {Reuse the existing ID when present} | {Requirement or finding ID} | {Externally observable condition} | {Verified cause} | {Actual affected paths} | {file:line or preceding verification result} | {Observable conditions} | {Minimum necessary action} |

## Reason the Decision Cannot Be Made (when BLOCKED)
- {Requirement that current code and preceding reports cannot decide, required external decision or information, and why task-scope code changes cannot provide it}
```

- Select APPROVE only when every requirement is fulfilled and every preceding finding is resolved
- Select REJECT only when an unfulfilled requirement or unresolved finding is recorded with evidence in Unresolved Problems
- Select BLOCKED only when a required external decision or information cannot be obtained through task-scope code changes and the available evidence cannot decide the requirement
- Do not use the absence of test or build records alone as a reason for REJECT or BLOCKED
