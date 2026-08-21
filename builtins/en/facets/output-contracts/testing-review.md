```markdown
# Testing Review

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

For every finding that requests a test, record the observable contract to preserve, the concrete failure path, and evidence that existing tests cannot detect it. Do not record findings whose only purpose is freezing internal structure or duplicating existing verification.

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Test coverage | ✅ | - |
| Test structure (Given-When-Then) | ✅ | - |
| Test naming | ✅ | - |
| Test independence & reproducibility | ✅ | - |
| Mocks & fixtures | ✅ | - |
| Test strategy (unit/integration/E2E) | ✅ | - |
| Contract input location (body/query/path) | ✅ | - |

{{include:output-contracts/base-review-new-findings-category}}
| 1 | TEST-NEW-src-test-L42 | test-structure | Coverage | `src/test.ts:42` | Issue description | `src/test.ts:42` | Fix suggestion |

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | TEST-PERSIST-src-test-L77 | test-structure | `src/test.ts:77` | `src/test.ts:77` | Unresolved | Fix suggestion |

{{include:output-contracts/base-review-resolved-findings}}
| TEST-RESOLVED-src-test-L10 | `src/test.ts:10` now has sufficient coverage |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | TEST-REOPENED-src-test-L55 | test-structure | Immediately preceding disposition: resolved | Reintroduced by the repair | `Recurred at src/test.ts:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

## Unverified Scope
| Item | Reason | Impact on Decision |
|------|--------|--------------------|
| {Unverified scope, or "none"} | {Reason it was not verified} | {APPROVE allowed / REJECT reason} |

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE with no resolved findings: Summary, unverified scope, and only the checked criteria and verification evidence supporting the judgment (concisely aggregated)
- APPROVE with resolved findings: Summary, Resolved Findings, unverified scope, and only the checked criteria and verification evidence supporting the judgment (concisely aggregated)
- REJECT: Include every verified finding in tables and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
