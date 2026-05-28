Review evidence from executed tests, builds, and manual verification, then make the final approval decision including whether any unnecessary maintenance diff remains.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section from each source (do not cherry-pick)
3. Match the criteria from the listed sections against the diff, execution evidence, and reports

## Step-specific additional procedure

1. Extract each requirement from the task instructions one by one
   - If one sentence contains multiple conditions or paths, split it into the smallest verifiable units
   - Split parallel expressions by default
2. For each requirement, identify the implemented code (file:line)
3. Actually verify that the code satisfies the requirement by reading files and checking build/test evidence
   - Do not mark a compound requirement ✅ after checking only one side
   - Do not trust plan or requirements-review judgments without independent verification per requirement
   - REJECT if any single requirement is unsatisfied
4. Validate the maintenance scope
   - Check whether required, related, and unnecessary change classifications are valid
   - Check that comments, type names, file placement, UI copy, accessible names, and test expectations did not change out of scope
   - REJECT if any diff remains that is justified only by general quality improvement or style cleanup
5. Re-evaluate prior review findings
   - If a finding does not hold in the code, record it as false_positive
   - If a valid finding is outside the task purpose or over-generalized, record it as overreach
   - Do not silently pass through false_positive or overreach findings

## Report priority (supervise-specific)

- Summary reports are not primary evidence. Primary evidence is execution-result reports, review reports with concrete checks, and actual code
- `Build Results` / `Test Results` inside execution-result reports may be treated as primary evidence
- In `architecture-review` / `qa-review` / `testing-review` / `security-review` / `requirements-review`, prioritize each report's verification-evidence section
- Treat a verification-evidence item as supporting evidence only when target, check content, and result are all present. Otherwise treat it as unverified
- When evidence conflicts, prefer `execution-result report > review report with concrete checks > summary report`

**Validation output contract:**
```markdown
# Final Validation Result

## Result: APPROVE / REJECT

## Requirement Satisfaction Check

Extract requirements from the task instructions and verify each requirement against actual code.

| # | Requirement (from task instructions) | Satisfied | Evidence (file:line) |
|---|--------------------------------------|-----------|----------------------|
| 1 | {Requirement 1} | ✅/❌ | `src/file.ts:42` |
| 2 | {Requirement 2} | ✅/❌ | `src/file.ts:55` |

- Any ❌ requires REJECT
- ✅ without evidence is invalid
- Do not mark ✅ when only part of a compound case was checked
- Do not trust the plan report without independent verification per requirement

## Maintenance Scope Check

| Check | Result | Evidence |
|-------|--------|----------|
| Only required changes remain | ✅/❌ | {Evidence} |
| Related changes have clear reasons | ✅/❌ | {Evidence} |
| No unnecessary changes remain | ✅/❌ | {Evidence} |
| No out-of-scope comment deletion occurred | ✅/❌ | {Evidence} |
| Type names, file placement, and public APIs did not change out of scope | ✅/❌ | {Evidence} |
| UI copy, accessible names, and test expectations did not change out of scope | ✅/❌ | {Evidence} |

## Prior Finding Re-evaluation

| finding_id | Prior status | Re-evaluation | Evidence |
|------------|--------------|---------------|----------|
| {id} | new / persists / resolved | valid / false_positive / overreach | `src/file.ts:42`, `reports/plan.md` |

- If final judgment differs from prior review conclusions, write the reason with evidence
- When marking false_positive / overreach, state whether it is inappropriate relative to the task or the plan
- If overturning requirements-review, provide evidence-backed reasoning

## Verification Summary
| Item | Status | Verification Method |
|------|--------|---------------------|
| Tests | ✅ / ⚠️ / ❌ | {Execution log, report, CI evidence} |
| Build | ✅ / ⚠️ / ❌ | {Execution log, report, CI evidence} |
| Manual verification | ✅ / ⚠️ / ❌ | {Evidence checked, or state not verified} |

## Artifacts
- Created: {Created files}
- Modified: {Modified files}

## Incomplete Items (for REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {Item} | {Reason} |
```

**Summary output contract (APPROVE only):**
```markdown
# Task Completion Summary

## Task
{Original request in 1-2 sentences}

## Result
Complete

## Changes
| Type | File | Summary |
|------|------|---------|
| Created | `src/file.ts` | Summary |

## Verification Evidence
- {Test/build/manual verification evidence}
```
