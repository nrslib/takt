```markdown
# Final Validation Results

## Result: APPROVE / REJECT

## Requirements Fulfillment Check

Extract requirements from the task spec and verify each one individually against actual code.

| # | Decomposed requirement | Original Requirement Source | Met | Evidence (file:line) | Exception / Optionalization Evidence |
|---|------------------------|-----------------------------|-----|----------------------|------------------------------------|
| 1 | {requirement 1} | `order.md:10` | ✅/❌ | `src/file.ts:42` | none |
| 2 | {requirement 2} | `order.md:11` | ✅/❌ | `src/file.ts:55` | none |

- If a sentence contains multiple conditions, split it into the smallest independently verifiable rows
- Do not combine parallel conditions such as `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, or `read/write` into one row
- If any ❌ exists, REJECT is mandatory
- ✅ without evidence is invalid (must verify against actual code)
- Do not mark a row as ✅ when the evidence covers only part of the cases
- Treat optionalization, exclusion, or exception not present in the task spec as unmet
- Do not rely on plan report's judgment; independently verify mergeability

## Re-evaluation of Prior Findings
| finding_id | Prior Status | Original Expected Result | Re-evaluation | Evidence |
|------------|--------------|--------------------------|---------------|----------|
| {id} | new / persists / resolved | {Original finding acceptance criteria} | valid / false_positive / overreach | `src/file.ts:42`, `reports/plan.md` |

- If final judgment differs from prior review conclusions, explain why with evidence
- Treat `resolved` as valid only when it satisfies the original expected result and original requirement
- If marking `false_positive` or `overreach`, state whether it conflicts with the task objective, the plan, or both
- If overturning a pure-review conclusion, explain why with concrete evidence

## Maintenance Scope Check (maintenance workflows only)

| Check | Result | Evidence |
|-------|--------|----------|
| Only required changes remain | ✅/❌ | {Evidence} |
| Related changes have clear reasons | ✅/❌ | {Evidence} |
| No unnecessary changes remain | ✅/❌ | {Evidence} |
| No out-of-scope comment deletion occurred | ✅/❌ | {Evidence} |
| Type names, file placement, and public APIs did not change out of scope | ✅/❌ | {Evidence} |
| UI copy, accessible names, and test expectations did not change out of scope | ✅/❌ | {Evidence} |

## Validation Summary
| Item | Status | Verification Method |
|------|--------|-------------------|
| Tests | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Build | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Functional check | ✅ / ⚠️ / ❌ | {Evidence used, or state that it was not verified} |

- Do not claim success/failure/not-runnable for commands that were never executed
- When using `⚠️`, explain the missing evidence and the verified scope in the method column
- If report text conflicts with execution evidence, treat that inconsistency itself as a finding

## Unverified Scope
| Item | Impact | Treatment |
|------|--------|-----------|
| {Unverified scope, or "none"} | {Primary or supporting requirement} | APPROVE allowed / REJECT reason |

## Current Iteration Findings (new)
| # | finding_id | Item | Evidence | Reason | Required Action |
|---|------------|------|----------|--------|-----------------|
| 1 | VAL-NEW-src-file-L42 | Requirement mismatch | `file:line` | Description | Fix required |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Reason | Required Action |
|---|------------|-------------------|------------------|--------|-----------------|
| 1 | VAL-PERSIST-src-file-L77 | `file:line` | `file:line` | Still unresolved | Apply fix |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| VAL-RESOLVED-src-file-L10 | {Original finding acceptance criteria} | `file:line` now passes validation |

## Deliverables
- Created: {Created files}
- Modified: {Modified files}

## Outstanding Items (if REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {Item} | {Reason} |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```
