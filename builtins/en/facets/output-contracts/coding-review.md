```markdown
# Coding Review

## Result: APPROVE / REJECT

## Summary
{Summarize the review result in 1-2 sentences}

## Contract Entry Check
Fill this when the diff adds or changes IDs, names, metadata, config, environment variables, or output contracts.

| Entry / Path | Original Requirement | Implementation Evidence | Test Evidence | Judgment | Exception / Unverified Evidence |
|--------------|----------------------|--------------------------|---------------|----------|---------------------------------|
| {normal entry / derived condition / validation / evaluation / output / re-injection, etc.} | {Requirement} | `src/file.ts:42` | `src/file.test.ts:10` | ✅/❌/⚠️ | {none / evidence} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Severity | Location | Issue | Impact | Fix Suggestion |
|---|------------|------------|----------|----------|-------|--------|----------------|
| 1 | CODE-NEW-src-file-L42 | bug | High / Medium / Low | `src/file.ts:42` | {Issue} | {Impact} | {Fix suggestion} |

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | CODE-PERSIST-src-file-L77 | regression | `src/file.ts:77` | `src/file.ts:77` | {Unresolved issue} | {Fix suggestion} |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| CODE-RESOLVED-src-file-L10 | {Original finding acceptance criteria} | Resolved at `src/file.ts:10` |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | CODE-REOPENED-src-file-L55 | bug | `Previously: src/file.ts:10` | `src/file.ts:55` | {Reopened issue} | {Fix suggestion} |

## Verification Evidence
- Diff review: {What was checked}
- Build: {Result, or state unverified}
- Tests: {Result, or state unverified}

## Rejection Gate
- REJECT only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary plus Contract Entry Check when needed (10 lines or fewer total)
- REJECT: Include only relevant finding rows (30 lines or fewer)
