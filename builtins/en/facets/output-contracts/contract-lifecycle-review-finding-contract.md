```markdown
# Contract Lifecycle Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentence summary of the review outcome}

## Observed Findings
| # | family_tag | Severity | Evidence Location | Problem | Affected Paths | Suggested Fix |
|---|------------|----------|-------------------|---------|----------------|---------------|
| 1 | contract-lifecycle | High / Medium / Low | `src/file.ts:42` | {problem} | {producer, validator, consumer, or derived paths} | {suggested fix} |

## Verification Evidence
- Requirement and specification check: {source of the expected contract}
- Lifecycle re-scan: {paths checked, including any resolved defect class}
- Citation check: {confirmation that every evidence location was verified against actual code}
```

**Cognitive-load rules:**
- APPROVE -> summary only (within 5 lines)
- REJECT -> only relevant raw findings in the table (within 30 lines)
