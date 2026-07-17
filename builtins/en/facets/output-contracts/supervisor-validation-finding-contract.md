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
## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact or Failure Condition | Required Action |
|---|------------|----------|----------|-------|-----------------------------|-----------------|
| 1 | validation | high / medium / low | `file:line` | {current observed defect} | {impact or condition} | {fix} |
## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |
## Output Consistency
- Markdown Observed Findings and structured issues, and Markdown Resolution Confirmations and structured confirmations, must each be the same set. Do not assign final finding IDs.
- APPROVE means zero issues and required evidence is confirmed; REJECT means one or more currently observed defect issues; NEED_REPLAN means zero issues but approval is impossible because a major requirement or required evidence is unverified. Auxiliary unverified items may still APPROVE when other confirmed evidence is sufficient.
```

**Cognitive-load rule:** For APPROVE, include only requirement fulfillment and necessary evidence; for REJECT, include only relevant rows within 30 lines.
