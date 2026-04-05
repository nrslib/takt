Verify existing evidence for tests, builds, and functional checks, then perform final approval.

**Overall piece verification:**
1. Check all reports in the report directory and verify overall piece consistency
   - Does implementation match the plan?
   - Were all review movement findings properly addressed?
   - Was the original task objective achieved?
   - Are prior review findings themselves valid against the task spec, plan, and actual code?
2. Verify the task spec, plan, and decision history as primary sources
   - Read `order.md` and extract required behavior and prohibitions
   - Read `plan.md` and confirm intended approach and scope
   - Read `coder-decisions.md` and confirm why the implementation moved in that direction
   - Do not treat prior review conclusions or requirements-review conclusions as authoritative unless they align with all three and the code
3. Whether each task spec requirement has been achieved
   - Extract requirements one by one from the task spec
   - If a single sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
     - Example: treat `global/project` as separate requirements
     - Example: treat `JSON override / leaf override` as separate requirements
     - Example: split parallel expressions such as `A and B`, `A/B`, `allow/deny`, or `read/write`
   - For each requirement, identify the implementing code (file:line)
   - Verify the code actually fulfills the requirement (read the file, check existing test/build evidence)
   - Do not mark a composite requirement as ✅ based on only one side of the cases
   - Evidence must cover the full content of the requirement row
   - Do not rely on the plan report's judgment; independently verify each requirement
   - If any requirement is unfulfilled, REJECT
4. Re-evaluate prior review findings
   - Re-check each `new / persists / resolved` finding against the task spec, `plan.md`, `coder-decisions.md`, and actual code
   - If a finding does not hold in code, classify it as `false_positive`
   - If a finding holds technically but pushes work beyond the task objective or justified scope, classify it as `overreach`
   - Do not leave `false_positive` / `overreach` reasoning implicit
5. Handling tests, builds, and functional checks
   - Do not assume this movement will rerun commands
   - Use only evidence available in this run, such as execution logs, reports, or CI results
   - If evidence is missing, mark the item as unverified rather than successful
   - If report text conflicts with execution evidence, call out the inconsistency explicitly

**Report verification:** Read all reports in the Report Directory and
check whether any blocking finding remains unresolved and whether those findings are themselves valid.

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
