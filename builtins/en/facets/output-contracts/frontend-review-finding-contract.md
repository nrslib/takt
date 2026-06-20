```markdown
# Frontend Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Component design | ✅ | - |
| State management | ✅ | - |
| Canonical and derived state | ✅ | - |
| Performance | ✅ | - |
| Accessibility | ✅ | - |
| Type safety | ✅ | - |

## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact | Fix Suggestion |
|---|------------|----------|----------|-------|--------|----------------|
| 1 | component-design | High / Medium / Low | `src/file.tsx:42` | Issue description | User experience or maintainability impact | Fix approach |

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include only relevant finding rows (30 lines or fewer)
