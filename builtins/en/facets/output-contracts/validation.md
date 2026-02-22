```markdown
# Final Validation Results

## Result: APPROVE / REJECT

## Validation Summary
| Item | Status | Verification Method |
|------|--------|-------------------|
| Requirements met | ✅ | Checked against requirements list |
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
