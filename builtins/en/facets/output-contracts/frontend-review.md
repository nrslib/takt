```markdown
# Frontend Review

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Component design | ✅ | - |
| State management | ✅ | - |
| Canonical and derived state | ✅ | - |
| Performance | ✅ | - |
| Accessibility | ✅ | - |
| Type safety | ✅ | - |

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## Current Iteration Findings (new)
| # | finding_id | family_tag | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | FE-NEW-src-file-L42 | component-design | `src/file.tsx:42` | Issue description | {For follow-up, the exact single machine value selected by the applicable policy; not applicable for initial review} | {Independent causal evidence for the follow-up omission; not applicable for initial review} | Fix approach |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | FE-PERSIST-src-file-L77 | component-design | `src/file.tsx:77` | `src/file.tsx:77` | Still unresolved | Apply prior fix plan |

{{include:output-contracts/base-review-resolved-findings}}
| FE-RESOLVED-src-file-L10 | `src/file.tsx:10` now satisfies the rule |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | FE-REOPENED-src-file-L55 | component-design | `review-resolution.md`: previously resolved | d | `Recurred at src/file.tsx:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
- Findings without `finding_id` are invalid
```

{{include:output-contracts/base-review-cognitive-load-with-resolved}}
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
