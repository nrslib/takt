```markdown
# Final Validation Results

## Result: APPROVE / REJECT

## Requirements Fulfillment Check

Extract requirements from the task spec and verify each one individually against actual code.

| # | Decomposed requirement | Met | Evidence (file:line) |
|---|------------------------|-----|---------------------|
| 1 | {requirement 1} | ✅/❌ | `src/file.ts:42` |
| 2 | {requirement 2} | ✅/❌ | `src/file.ts:55` |

- If a sentence contains multiple conditions, split it into the smallest independently verifiable rows
- Do not combine parallel conditions such as `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, or `read/write` into one row
- If any ❌ exists, REJECT is mandatory
- ✅ without evidence is invalid (must verify against actual code)
- Do not mark a row as ✅ when the evidence covers only part of the cases
- Do not rely on plan report's judgment; independently verify each requirement

## Re-evaluation of Prior Findings
| finding_id | Prior Status | Re-evaluation | Evidence |
|------------|--------------|---------------|----------|
| {id} | new / persists / resolved | valid / false_positive / overreach | `src/file.ts:42`, `reports/plan.md` |

- If final judgment differs from prior review conclusions, explain why with evidence
- If marking `false_positive` or `overreach`, state whether it conflicts with the task objective, the plan, or both

## Validation Summary
| Item | Status | Verification Method |
|------|--------|-------------------|
| Tests | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Build | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Functional check | ✅ / ⚠️ / ❌ | {Evidence used, or state that it was not verified} |

- Do not claim success/failure/not-runnable for commands that were never executed
- When using `⚠️`, explain the missing evidence and the verified scope in the method column
- If report text conflicts with execution evidence, treat that inconsistency itself as a finding

## Current Iteration Findings (new)
| # | finding_id | Item | Evidence | Reason | Required Action |
|---|------------|------|----------|--------|-----------------|
| 1 | VAL-NEW-src-file-L42 | Requirement mismatch | `file:line` | Description | Fix required |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Reason | Required Action |
|---|------------|-------------------|------------------|--------|-----------------|
| 1 | VAL-PERSIST-src-file-L77 | `file:line` | `file:line` | Still unresolved | Apply fix |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| VAL-RESOLVED-src-file-L10 | `file:line` now passes validation |

## Deliverables
- Created: {Created files}
- Modified: {Modified files}

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```
