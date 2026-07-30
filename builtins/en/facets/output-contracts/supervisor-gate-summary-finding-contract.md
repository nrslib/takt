```markdown
# Final Gate Summary

## Result: APPROVE / REJECT / NEED_REPLAN

## Key Points
{Summarize the actual verdict and its supporting key points in 1-2 sentences}

## Next Action or Unfinished Reason
{For APPROVE, the next progression; for REJECT, the required fix; for NEED_REPLAN, the unverified item and reason to replan}

## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- APPROVE means zero issues; REJECT means one or more issues. NEED_REPLAN keeps zero issues and records the unverified item in Next Action or Unfinished Reason. Do not make approvals or summaries issues.
```

**Cognitive-load rule:** Always state the actual verdict, key points, and next action or unfinished reason; include every required machine claim without truncation.
