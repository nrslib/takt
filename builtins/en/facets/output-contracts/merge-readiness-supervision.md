```markdown
# Final Merge-Readiness Adjudication

## Result: MERGEABLE / FIX REQUIRED / TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT

## Requirement and Evidence Summary
| Subject | State | Evidence |
|---------|-------|----------|
| {Decomposed requirement, quality gate, or prior finding} | {met / unmet / verified / unverified / resolved} | {file:line, report, or execution evidence} |

## Actionable Families
| family | Finding ID | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {FINAL-NEW-* / FINAL-PERSIST-*} | {file:line or execution evidence} | {Verified causal chain} | {Entry, production, validation, consumption, and side effects} | {Observable completion conditions} | {Required minimal change; explicitly excluded adjacent work or mechanism} |

## Prior Finding Dispositions
| Finding ID | State | Evidence |
|------------|-------|----------|
| {ID} | {resolved / remains_open / adjudicated_non_actionable} | {Original acceptance criteria or adjudication and current evidence} |

## Unresolved Premises and Environmental Constraints
- {None, or the reason replanning or an environment change is required and the unverified scope}
```

**Cognitive-load rules:**
- MERGEABLE -> include only the requirement and evidence summary plus prior finding dispositions
- FIX REQUIRED -> consolidate every confirmed blocker into families without omitting finding IDs or acceptance criteria
- TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT -> record why remediation cannot resolve the issue in unresolved premises and environmental constraints
