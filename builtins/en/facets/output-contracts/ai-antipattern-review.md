```markdown
# AI-Generated Code Review

{{include:output-contracts/base-review-result}}

## Summary
{Summarize the result in one sentence}

## Verified Items
| Aspect | Result | Notes |
|--------|--------|-------|
| Validity of assumptions | ✅ | - |
| API/library existence | ✅ | - |
| Context fit | ✅ | - |
| Scope | ✅ | - |

{{include:output-contracts/base-review-non-finding-concerns}}

{{include:output-contracts/base-review-problem-family-completion-sweep}}

{{include:output-contracts/base-review-new-findings-category}}
| 1 | AI-NEW-src-file-L23 | hallucination | Hallucinated API | `src/file.ts:23` | Non-existent method | {For follow-up, the exact single machine value selected by the applicable policy; not applicable for initial review} | {Independent causal evidence for the follow-up omission; not applicable for initial review} | Replace with existing API |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | AI-PERSIST-src-file-L42 | hallucination | `src/file.ts:42` | `src/file.ts:42` | Still unresolved | Apply prior fix plan |

{{include:output-contracts/base-review-resolved-findings}}
| AI-RESOLVED-src-file-L10 | `src/file.ts:10` no longer contains the issue |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | AI-REOPENED-src-file-L55 | hallucination | `review-resolution.md`: previously resolved | d | `Recurred at src/file.ts:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-rescan-evidence}}

## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + Re-scan Evidence (from the second iteration onward) + Non-Finding Concerns when needed
- Issues found → include every verified finding in the impacted sections and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
