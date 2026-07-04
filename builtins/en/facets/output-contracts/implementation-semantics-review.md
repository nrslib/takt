```markdown
# Implementation Semantics Review

## Verdict: APPROVE / REJECT

## Summary
{1-2 sentence summary of the review result}

## Non-Finding Concerns
| Item | Location | Category | Reason not raised as a finding |
|------|----------|----------|--------------------------------|
| {concern, or "none"} | `src/file.ts:42` | false_positive / overreach / out_of_scope / no_issue_after_verification | {reason} |

## New Findings (new)
| # | finding_id | family_tag | Severity | Location | Problem | Breaking condition | Fix |
|---|------------|------------|----------|----------|---------|--------------------|-----|
| 1 | SEM-NEW-src-file-L42 | data-structure | High / Medium / Low | `src/file.ts:42` | {problem} | {what input/state breaks it} | {fix} |

## Persisting Findings (persists)
| # | finding_id | family_tag | Previous evidence | Current evidence | Problem | Fix |
|---|------------|------------|-------------------|------------------|---------|-----|
| 1 | SEM-PERSIST-src-file-L77 | derived-state | `src/file.ts:77` | `src/file.ts:77` | {unresolved problem} | {fix} |

## Resolved (resolved)
| finding_id | Original acceptance condition | Resolution evidence |
|------------|------------------------------|---------------------|
| SEM-RESOLVED-src-file-L10 | {acceptance condition of the original finding} | resolved at `src/file.ts:10` |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Resolution evidence (previous) | Recurrence evidence | Problem | Fix |
|---|------------|------------|-------------------------------|---------------------|---------|-----|
| 1 | SEM-REOPENED-src-file-L55 | fail-fast | `previous: src/file.ts:10` | `src/file.ts:55` | {recurred problem} | {fix} |

## Verification Evidence
- Diff check: {what was checked}
- Citation existence check: {confirmation that every cited file:line was verified against real code}

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge chapter checked | Diff-side evidence (`file:line` or "none applicable") |
|----------------------------------|------------------------------------------------------|
| {chapter} | {evidence} |

## Rejection Gate
- REJECT only when there is at least one `new`, `persists`, or `reopened` finding
- Findings without a `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary + Verification Evidence + Re-scan Evidence (from the second iteration onward), plus Non-Finding Concerns only when needed
- REJECT → List only the applicable findings in tables (30 lines or fewer)
