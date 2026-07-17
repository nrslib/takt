```markdown
# Final Gate Summary

## Result: APPROVE / REJECT / NEED_REPLAN

## Key Points
{Summarize the actual verdict and its supporting key points in 1-2 sentences}

## Next Action or Unfinished Reason
{For APPROVE, the next progression; for REJECT, the required fix; for NEED_REPLAN, the unverified item and reason to replan}

## Observed Findings
| # | family_tag | Severity | Location | Issue | Required Action |
|---|------------|----------|----------|-------|-----------------|
| 1 | validation | high / medium / low | `file:line` | {current observed defect} | {fix} |

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set.
- APPROVE means zero issues; REJECT means one or more issues. NEED_REPLAN keeps zero issues and records the unverified item in Next Action or Unfinished Reason. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Always state the actual verdict, key points, and next action or unfinished reason; include only relevant rows within 20 lines.
