```markdown
# Security Review

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## Severity: None / Low / Medium / High / Critical

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## Current Iteration Findings (new)
| # | finding_id | family_tag | Severity | Type | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | SEC-NEW-src-db-L42 | injection-risk | High | SQLi | `src/db.ts:42` | Raw query string | {For follow-up, the exact single machine value selected by the applicable policy; not applicable for initial review} | {Independent causal evidence for the follow-up omission; not applicable for initial review} | Use parameterized queries |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | SEC-PERSIST-src-auth-L18 | injection-risk | `src/auth.ts:18` | `src/auth.ts:18` | Weak validation persists | Harden validation |

{{include:output-contracts/base-review-resolved-findings}}
| SEC-RESOLVED-src-db-L10 | `src/db.ts:10` now uses bound parameters |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | SEC-REOPENED-src-auth-L55 | injection-risk | `review-resolution.md`: previously resolved | d | `Recurred at src/auth.ts:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

## Warnings (non-blocking)
- {Security recommendations}

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- Initial APPROVE with no findings or prior adjudication to carry → Result: APPROVE, Severity: None, and a one- or two-sentence Summary only
- APPROVE with warnings → add Warnings in 1-2 lines
- Follow-up APPROVE → include only the existing adjudicated, resolved, or verification sections required by the follow-up contract
- Vulnerabilities found → include every verified finding in tables and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
