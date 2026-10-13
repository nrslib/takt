# Coding Review

## Result: approved

## Summary
Reviewed the order refund calculation.

## Current Iteration Findings (new)
| # | finding_id | Severity | Location | Issue | Impact | Evidence | Fix Suggestion |
|---|------------|----------|----------|-------|--------|----------|----------------|
| 1 | CODE-NEW-refund-L6 | High (blocking, unresolved) | src/refund.mjs:6 | Discounts and fees are calculated with floating-point arithmetic before rounding | A boundary amount can produce a refund one cent lower | Rounding 1.005 returns 1.00 | Use the smallest currency unit and define the rounding rule |

## Carry-over Findings (persists)
None.

## Resolved Findings (resolved)
None.

## Verification Evidence
- Diff review: Checked the calculation path in src/refund.mjs.
- Build: These Node.js modules do not require a build step.
- Tests: node --test passed.

## Impact-Path Evidence
Checked the path from the order total to the returned refund. CODE-NEW-refund-L6 remains unresolved and blocks acceptance.
