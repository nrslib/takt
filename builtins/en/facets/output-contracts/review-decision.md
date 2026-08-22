```markdown
# Review Finding Decision

## Result: Problems require repair / No problems require repair / The entire task must be replanned

## Decision Summary
{Reports inspected, number of problems to repair, number of findings not selected for repair, and key evidence}

## Requirement Check
| Subject | Status | Evidence |
|---------|--------|----------|
| {Requirement or preceding finding} | {Fulfilled / Unfulfilled / Unverified / Resolved} | {Current-code file:line or a verification result recorded in a preceding report} |

## Problems to Repair
| Problem ID | Related Findings | Violated Condition | Cause | Relevant Paths | Evidence | Acceptance Criteria | Repair Boundary |
|------------|------------------|--------------------|-------|----------------|----------|---------------------|-----------------|
| {Reuse the existing ID when present} | {All finding IDs and report names} | {Externally observable condition} | {Verified cause} | {Actual paths from the defining source through consumers to observable results} | {file:line or reproduction evidence} | {Conditions that establish resolution when all hold} | {Required changes and explicitly excluded separate problems} |

## Decision for Each Finding
| Finding ID / Source | Technical Check | Treatment in This Task | Problem ID | Reason and Evidence |
|---------------------|-----------------|------------------------|------------|---------------------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {Repair / Merge into same problem / Unsupported / Unnecessary expansion / Outside this task / No issue after verification / Cannot verify in this environment} | {Problem ID or none} | {Reason based on current code, requirements, or reproduction results} |

## Unresolved Premises
- {None, or conflicting requirements, plan decisions, or findings and why replanning is required}
```

- Record every submitted finding ID exactly once in Decision for Each Finding. When verification confirms an omission, identify its source using the actual reviewer report name, such as `testing-review.md (not reported)`
- Group findings only when their cause, violated condition, and acceptance criteria are the same
- Include in Problems to Repair only problems this change must resolve. Do not copy an item merely because it exists in history
- Omit Problems to Repair when no repair is required
