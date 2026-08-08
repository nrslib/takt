```markdown
# Final Gate Summary

## Result: APPROVE / REJECT / NEED_REPLAN

## Key Points
{Summarize the actual verdict and its supporting key points in 1-2 sentences}

## Next Action or Unfinished Reason
{For APPROVE, the next progression; for REJECT, the required fix; for NEED_REPLAN, the unverified item and reason to replan}

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here as its own entry, using the labelled fields of the injected Finding Contract instructions (Target files / Description / Evidence). Do not state a severity, a severity-like label, or an issue-family tag. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Return ordinary Markdown report prose only. Do not return JSON or structured output. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. NEED_REPLAN keeps zero issues and records the unverified item in Next Action or Unfinished Reason. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Always state the actual verdict, key points, and next action or unfinished reason; include every required machine claim without truncation.
