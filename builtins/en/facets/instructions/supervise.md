Verify existing evidence for tests, builds, and functional checks, then perform final approval.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff, execution evidence, and reports

## Step-Specific Additional Procedure

1. Extract each requirement from the task spec one by one
   - If a single sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
     - Example: treat `global/project` as separate requirements
     - Example: treat `JSON override / leaf override` as separate requirements
     - Example: split parallel expressions such as `A and B`, `A/B`, `allow/deny`, or `read/write`
2. For each requirement, identify the implementing code (file:line)
3. Verify the code actually fulfills the requirement (read the file, check existing test/build evidence)
   - Do not mark a composite requirement as ✅ based on only one side of the cases
   - Do not rely on the plan report or requirements-review judgment; independently verify each requirement
   - If any requirement is unfulfilled, REJECT
4. Re-evaluate prior review findings
   - If a finding does not hold in code, classify it as `false_positive`
   - If a finding holds technically but pushes work beyond the task objective or justified scope, classify it as `overreach`
   - Do not leave `false_positive` / `overreach` reasoning implicit

## Report Priority (supervise-specific)

- Do not treat summary reports as primary evidence. Use execution-result reports, reviewer reports with concrete verification details, and actual code in that order
- You may treat `Build Results` / `Test Results` sections in execution-result reports as primary evidence
- For `architecture-review`, `qa-review`, `testing-review`, `security-review`, and `requirements-review`, prioritize each report's `Verification Evidence` section
- Treat each `Verification Evidence` item as supporting evidence only when it states the verified target, what was checked, and observed result. If any part is missing, mark that item as `unverified`
- If items of evidence conflict, prioritize them in this order: `execution-result report > reviewer report with concrete verification details > summary report`

**Validation output contract:**
```markdown
# Final Verification Results

## Result: APPROVE / REJECT

## Requirements Fulfillment Check

Extract requirements from the task spec and verify each one individually against actual code.

| # | Requirement (extracted from task spec) | Met | Evidence (file:line) |
|---|---------------------------------------|-----|---------------------|
| 1 | {requirement 1} | ✅/❌ | `src/file.ts:42` |
| 2 | {requirement 2} | ✅/❌ | `src/file.ts:55` |

- If any ❌ exists, REJECT is mandatory
- ✅ without evidence is invalid (must verify against actual code)
- Do not mark a row as ✅ when only part of the cases is verified
- Do not rely on plan report's judgment; independently verify each requirement

## Re-evaluation of Prior Findings
| finding_id | Prior status | Re-evaluation | Evidence |
|------------|--------------|---------------|----------|
| {id} | new / persists / resolved | valid / false_positive / overreach | `src/file.ts:42`, `reports/plan.md` |

- If final judgment differs from prior review conclusions, explain why with evidence
- If marking `false_positive` or `overreach`, state whether it conflicts with the task objective, the plan, or both
- If overturning a requirements-review conclusion, explain why with concrete evidence

## Verification Summary
| Item | Status | Verification method |
|------|--------|-------------------|
| Tests | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Build | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Functional check | ✅ / ⚠️ / ❌ | {Evidence used, or state that it was not verified} |

## Deliverables
- Created: {Created files}
- Modified: {Modified files}

## Outstanding items (if REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {Item} | {Reason} |
```

**Summary output contract (only if APPROVE):**
```markdown
# Task Completion Summary

## Task
{Original request in 1-2 sentences}

## Result
Complete

## Changes
| Type | File | Summary |
|------|------|---------|
| Create | `src/file.ts` | Summary description |

## Verification evidence
- {Evidence for tests/builds/functional checks}
```
