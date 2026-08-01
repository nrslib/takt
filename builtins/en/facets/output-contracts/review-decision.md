```markdown
# Review Finding Adjudication

## Result: ACTIONABLE FINDINGS / NO ACTIONABLE FINDINGS / REPLAN REQUIRED

## Decision Summary
{Source reports, actionable family count, non-actionable count, and evidence summary}

## Actionable Families
| family | Finding ID / source | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria |
|--------|---------------------|----------|-----------------------|-------------------------|---------------------|
| {Stable family name} | {All IDs and report names} | {file:line or reproduction evidence} | {Verified causal chain} | {Entry, production, validation, consumption, and side effects} | {Observable completion conditions} |

## Finding Dispositions
| Finding ID / source | Disposition | Target family | Evidence |
|---------------------|-------------|---------------|----------|
| {ID and report name} | {actionable / duplicate / false_positive / overreach / out_of_scope / no_issue_after_verification / environment_unverified} | {Actionable family or none} | {Defect evidence, consolidation rationale, counter-evidence, or applicable criteria} |

## Unresolved Premises
- {None, or conflicting requirements, plan decisions, or findings and why replanning is required}
```

**Cognitive-load rules:**
- Record every submitted finding ID exactly once in Finding Dispositions
- No actionable findings -> include only the summary, finding dispositions, and unresolved premises
- Actionable findings -> consolidate findings with the same cause into one family and include every `actionable` and `duplicate` finding ID in its target family
