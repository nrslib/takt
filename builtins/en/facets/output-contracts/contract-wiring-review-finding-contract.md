```markdown
# Contract Wiring Review
## Result: APPROVE / REJECT
## Summary
{1-2 sentence conclusion}
## Wiring Evidence
| Entry / Execution Mode | Producer | Normalization / Validation | Handoff / Persistence | Consumer | Evidence |
|------------------------|----------|----------------------------|-----------------------|----------|----------|
| {entry or mode} | {producer} | {validator} | {handoff or persistence target} | {consumer} | `file:line` |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- Evidence, locations, and confirmation evidence must use an exact `file:line` identifying one existing line. Never use a `file:line-line` range; add a separate table row for each additional line.
- A Wiring Evidence row must cite the line that performs that entry's handoff or persistence. Do not substitute a producer or cleanup line.
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- If the summary or wiring evidence recognizes an unresolved defect, include it as an issue and return REJECT. Do not describe a defect while returning APPROVE.
- APPROVE means zero issues; REJECT means one or more issues. Every issue must use `contract-wiring` as its family_tag. Omit non-wiring defects instead of relabeling them.
```

**Cognitive-load rule:** For APPROVE, include only the summary and necessary wiring evidence; for REJECT, keep supporting prose concise while including every required machine claim.
