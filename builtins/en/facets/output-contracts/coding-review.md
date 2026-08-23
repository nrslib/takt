```markdown
# Coding Review

{{include:output-contracts/base-review-result}}

## Summary
{Summarize the review result in 1-2 sentences}

## Contract Entry Check
Fill this when the diff adds or changes IDs, names, metadata, config, environment variables, or externally visible output formats.

| Entry / Path | Original Requirement | Implementation Evidence | Test Evidence | Judgment | Exception / Unverified Evidence |
|--------------|----------------------|--------------------------|---------------|----------|---------------------------------|
| {normal entry / derived condition / validation / evaluation / output / re-injection, etc.} | {Requirement} | `src/file.ts:42` | `src/file.test.ts:10` | ✅/❌/⚠️ | {none / evidence} |

{{include:output-contracts/base-review-non-finding-concerns}}

## Current Iteration Findings (new)
| # | finding_id | Severity | Location | Issue | Impact | Evidence | Fix Suggestion |
|---|------------|----------|----------|-------|--------|----------|----------------|
| 1 | CODE-NEW-src-file-L42 | High / Medium / Low | `src/file.ts:42` | {Issue} | {Impact} | {file:line or reproducible evidence} | {Fix suggestion} |

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | CODE-PERSIST-src-file-L77 | `src/file.ts:77` | `src/file.ts:77` | {Unresolved issue} | {Fix suggestion} |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| CODE-RESOLVED-src-file-L10 | {Original finding acceptance criteria} | Resolved at `src/file.ts:10` |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | CODE-REOPENED-src-file-L55 | Immediately preceding disposition: resolved | Reintroduced by the repair | `src/file.ts:55` | {Reopened issue} | {Fix suggestion} |

{{include:output-contracts/base-review-reopened}}
## Verification Evidence
- Diff review: {What was checked}
- Build: {Result, or state unverified}
- Tests: {Result, or state unverified}

{{include:output-contracts/base-review-rescan-evidence}}

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate-only-when}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary plus Verification Evidence, Contract Entry Check, Impact-Path Evidence, and Non-Finding Concerns when needed
- REJECT: Include every verified finding row and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
