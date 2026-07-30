```markdown
# Final Validation Results
## Result: APPROVE / REJECT / NEED_REPLAN
## Requirements Fulfillment
| Requirement Unit | Actual Code or Current Execution Evidence | Result |
|------------------|--------------------------------------------|--------|
| {decomposed requirement} | `file:line` or {execution evidence confirmed to match} | ✅ / ❌ / unverified |
## Audit
| Ledger Reference or Subject | Classification | Evidence | Required Action |
|----------------------------|----------------|----------|-----------------|
| {prior finding or unclassified concern} | valid / false_positive / overreach / unclassified | {current code or evidence} | {fix, re-verify, or none} |
## Verification Evidence and Unverified Scope
| Target | Check or Unverified Reason | Result | Next Required Verification |
|--------|----------------------------|--------|----------------------------|
| {test, build, or functional check} | {current-code-matched log/report or reason} | ✅ / ❌ / unverified | {verification for NEED_REPLAN or none} |
## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Output Consistency
- When the canonical block protocol is present, blocks and normalized items must be the same ordered set with byte-exact rawExcerpt values. When it is absent, the structured-output schema is the sole machine claim format. Do not assign final finding IDs.
- APPROVE means zero issues and required evidence is confirmed; REJECT means one or more currently observed defect issues; NEED_REPLAN means zero issues but approval is impossible because a major requirement or required evidence is unverified. Auxiliary unverified items may still APPROVE when other confirmed evidence is sufficient.
```

**Cognitive-load rule:** For APPROVE, include only requirement fulfillment and necessary evidence; for REJECT, keep supporting prose concise while including every required machine claim.
