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

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When an injected structured-output schema is present, every issue described in the report must also appear in that structured output. Otherwise use ordinary report prose only. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. Do not make approvals or summaries issues.

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE with no resolution confirmations → Summary only (5 lines or fewer)
- APPROVE with resolution confirmations → Summary and every required claim in the active Finding Contract format
- REJECT → Include every verified finding and necessary resolution confirmation in the active Finding Contract format, aggregating locations with the same cause
