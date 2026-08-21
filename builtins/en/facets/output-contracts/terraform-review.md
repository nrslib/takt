```markdown
# Terraform Convention Review

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## Reviewed Aspects
- [x] Variable declarations (type, description, sensitive)
- [x] Resource naming (name_prefix pattern)
- [x] File structure (one concern per file)
- [x] Security settings
- [x] Tag management
- [x] lifecycle rules
- [x] Cost trade-off documentation

{{include:output-contracts/base-review-problem-family-completion-sweep}}

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | TF-NEW-file-L42 | tf-convention | In-scope | `modules/example/main.tf:42` | Issue description | {For follow-up, the exact single machine value selected by the applicable policy; not applicable for initial review} | {Independent causal evidence for the follow-up omission; not applicable for initial review} | Fix approach |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | TF-PERSIST-file-L77 | tf-convention | `file.tf:77` | `file.tf:77` | Still unresolved | Apply prior fix plan |

{{include:output-contracts/base-review-resolved-findings}}
| TF-RESOLVED-file-L10 | `file.tf:10` now satisfies the convention |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | TF-REOPENED-file-L55 | tf-convention | `review-resolution.md`: previously resolved | d | `Recurred at file.tf:55` | Issue description | Fix approach |

{{include:output-contracts/base-review-reopened}}
## Rejection Gate
{{include:output-contracts/base-review-rejection-gate}}
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include every verified finding row and aggregate locations with the same cause
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
