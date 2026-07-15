```markdown
# Robustness Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentence summary of the review outcome}

## Observed Findings
| # | family_tag | Severity | Evidence Location | Problem | Breaking Condition | Suggested Fix |
|---|------------|----------|-------------------|---------|--------------------|---------------|
| 1 | robustness | High / Medium / Low | `src/file.ts:42` | {problem} | {failure, retry, interruption, or cleanup condition} | {suggested fix} |

## Verification Evidence
- Normal path: {committed effects and expected result checked}
- Failure contract: {requirement, specification, or existing contract used to determine atomicity or partial success}
- Citation check: {confirmation that every evidence location was verified against actual code}
```

**Cognitive-load rules:**
- APPROVE -> summary only (within 5 lines)
- REJECT -> only relevant raw findings in the table (within 30 lines)
