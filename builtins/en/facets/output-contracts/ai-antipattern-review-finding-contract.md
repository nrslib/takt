```markdown
# AI-Generated Code Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in one sentence}

## Verified Items
| Aspect | Result | Notes |
|--------|--------|-------|
| Validity of assumptions | ✅ | - |
| API/library existence | ✅ | - |
| Context fit | ✅ | - |
| Scope | ✅ | - |

Expected `family_tag` values: `hallucination`, `unvalidated-assumption`, `off-by-one`, `api-mismatch`, `missing-edge-case`, `logic-error`, `scope-creep`.
When structured raw findings are requested, copy this table's `family_tag` value into the structured `familyTag` field.

## Observed Findings
| # | family_tag | Category | Severity | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|----------|-------|----------------|
| 1 | hallucination | Hallucinated API | high / medium / low | `src/file.ts:23` | Non-existent method | Replace with existing API |

## Rejection Gate
- REJECT is valid only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + empty finding sections (10 lines or fewer)
- Issues found → include table rows only for impacted sections (30 lines or fewer)
