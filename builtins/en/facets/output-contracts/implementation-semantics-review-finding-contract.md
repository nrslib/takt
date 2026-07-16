```markdown
# Implementation Semantics Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentence summary of the review outcome}

## Observed Findings
| # | family_tag | Severity | Location | Problem | Breaking Condition | Suggested Fix |
|---|------------|----------|----------|---------|--------------------|---------------|
| 1 | data-structure | High / Medium / Low | `src/file.ts:42` | {problem} | {which input or state breaks it} | {suggested fix} |

## Verification Evidence
- Diff check: {what was verified}
- Citation check: {confirmation that every cited file:line was verified against the actual code}

## REJECT Criteria
- REJECT only when at least one blocking finding exists
```

**Cognitive-load rules:**
- APPROVE -> summary only (within 5 lines)
- REJECT -> only the relevant findings in the table (within 30 lines)

**Cognitive-load rules:**
- APPROVE -> summary only (within 5 lines)
- REJECT -> only the relevant findings in the table (within 30 lines)
