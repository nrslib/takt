```markdown
# CQRS+ES Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Aggregate design | ✅ | - |
| Event design | ✅ | - |
| Command/Query separation | ✅ | - |
| Projections | ✅ | - |
| Eventual consistency | ✅ | - |

## Observed Findings
| # | family_tag | Severity | Scope | Location | Issue | Impact | Fix Suggestion |
|---|------------|----------|-------|----------|-------|--------|----------------|
| 1 | cqrs-violation | High / Medium / Low | In-scope | `src/file.ts:42` | Issue description | Domain consistency or maintainability impact | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include only relevant finding rows (30 lines or fewer)
