```markdown
# Implementation Semantics Review

## Verdict: APPROVE / REJECT

## Summary
{1-2 sentence summary of the review result}

## Non-Finding Concerns
| Item | Location | Category | Reason not raised as a finding |
|------|----------|----------|--------------------------------|
| {concern, or "none"} | `src/file.ts:42` | false_positive / overreach / outside_contract_jurisdiction / no_issue_after_verification | {reason} |

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## New Findings (new)
| # | finding_id | family_tag | Severity | Location | Problem | Breaking condition | Authorization Basis | Reason Absent from Initial Round | Fix |
|---|------------|------------|----------|----------|---------|--------------------|---------------------|----------------------------------|-----|
| 1 | SEM-NEW-src-file-L42 | data-structure | High / Medium / Low | `src/file.ts:42` | {problem} | {what input/state breaks it} | {accepted_family_unvisited_consumer / remediation_regression / direct_acceptance_criterion_violation / required_consumer_migration for follow-up; not applicable for initial review} | {Independent evidence explaining why the initial review omitted this follow-up finding; not applicable for initial review} | {fix} |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
## Persisting Findings (persists)
| # | finding_id | family_tag | Previous evidence | Current evidence | Problem | Fix |
|---|------------|------------|-------------------|------------------|---------|-----|
| 1 | SEM-PERSIST-src-file-L77 | derived-state | `src/file.ts:77` | `src/file.ts:77` | {unresolved problem} | {fix} |

## Resolved (resolved)
| finding_id | Original acceptance condition | Resolution evidence |
|------------|------------------------------|---------------------|
| SEM-RESOLVED-src-file-L10 | {acceptance condition of the original finding} | resolved at `src/file.ts:10` |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
## Reopened Findings (reopened)
| # | finding_id | family_tag | Immediately Preceding Adjudication | Reopening Basis (a-d) | New Evidence | Problem | Fix |
|---|------------|------------|------------------------------------|-----------------------|--------------|---------|-----|
| 1 | SEM-REOPENED-src-file-L55 | fail-fast | `review-resolution.md`: previously resolved | d | `src/file.ts:55` | {recurred problem} | {fix} |

{{include:output-contracts/base-review-reopened}}
## Verification Evidence
- Diff check: {what was checked}
- Citation existence check: {confirmation that every cited file:line was verified against real code}

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge chapter checked | Diff-side evidence (`file:line` or "none applicable") |
|----------------------------------|------------------------------------------------------|
| {chapter} | {evidence} |

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate-only-when}}
- Findings without a `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary + Verification Evidence + Re-scan Evidence (from the second iteration onward), plus Non-Finding Concerns only when needed
- REJECT → Include every verified finding in tables and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
