```markdown
# Final Validation Results

## Result: APPROVE / REJECT

## Requirements Fulfillment Check

Extract requirements from the task spec and verify each one individually against actual code.

| # | Requirement (extracted from task spec) | Met | Evidence (file:line) |
|---|---------------------------------------|-----|---------------------|
| 1 | {requirement 1} | ✅/❌ | `src/file.ts:42` |
| 2 | {requirement 2} | ✅/❌ | `src/file.ts:55` |

- If any ❌ exists, REJECT is mandatory
- ✅ without evidence is invalid (must verify against actual code)
- Do not rely on plan report's judgment; independently verify each requirement

## Validation Summary
| Item | Status | Verification Method |
|------|--------|-------------------|
| Tests | ✅ | `npm test` (N passed) |
| Build | ✅ | `npm run build` succeeded |
| Functional check | ✅ | Main flow verified |

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
