```markdown
# Architecture Review

## Result: APPROVE / IMPROVE / REJECT

{{include:output-contracts/base-review-summary}}

## Reviewed Aspects
- [x] Structure & design
- [x] Code quality
- [x] Change scope
- [x] Test coverage
- [x] Dead code
- [x] Call chain verification

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | ARCH-NEW-src-file-L42 | design-violation | In-scope | `src/file.ts:42` | Issue description | `src/file.ts:42` | Fix approach |

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | ARCH-PERSIST-src-file-L77 | design-violation | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

{{include:output-contracts/base-review-resolved-findings}}
| ARCH-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | ARCH-REOPENED-src-file-L55 | design-violation | Immediately preceding disposition: resolved | Reintroduced by the repair | `Recurred at src/file.ts:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

{{include:output-contracts/base-review-rescan-evidence}}

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
{{include:output-contracts/base-review-rejection-gate-in-scope}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary + Verification Evidence + Impact-Path Evidence. Omit everything else
- REJECT → Include every verified finding row and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
