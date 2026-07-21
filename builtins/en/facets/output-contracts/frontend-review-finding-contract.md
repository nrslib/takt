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

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE with no resolution confirmations → Summary only (5 lines or fewer)
- APPROVE with resolution confirmations → Summary and Resolution Confirmations only
- REJECT → Include only related finding rows and necessary resolution confirmations (30 lines or fewer)
