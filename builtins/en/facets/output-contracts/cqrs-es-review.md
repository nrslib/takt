```markdown
# CQRS+ES Review

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Aggregate design | ✅ | - |
| Event design | ✅ | - |
| Command/Query separation | ✅ | - |
| Projections | ✅ | - |
| Eventual consistency | ✅ | - |

{{include:output-contracts/base-review-problem-family-completion-sweep}}

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | CQRS-NEW-src-file-L42 | cqrs-violation | In-scope | `src/file.ts:42` | Issue description | remediation_regression | The repair introduced this regression after the initial review | Fix approach |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | CQRS-PERSIST-src-file-L77 | cqrs-violation | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

{{include:output-contracts/base-review-resolved-findings}}
| CQRS-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | CQRS-REOPENED-src-file-L55 | cqrs-violation | `review-resolution.md`: previously resolved | d | `Recurred at src/file.ts:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
{{include:output-contracts/base-review-rejection-gate-in-scope}}
- Findings without `finding_id` are invalid
```

{{include:output-contracts/base-review-cognitive-load-with-resolved}}
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
