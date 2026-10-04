# Fix Completion Verification

## Result: incomplete

## Summary
The direct producer still relies on mutable emitter state, failed completion clears the pending attempt, and hierarchical counting filters direct entries but counts non-call wrappers in recursive totals and maximum depth. These observations prove that the previous completion claim was too broad; they are examples to investigate, not a complete defect inventory.

## Unmet or Unverified Items
| Fix unit | Type | Evidence | Required action |
|----------|------|----------|-----------------|
| FP-01 | implementation gap | `src/direct.js` calls `emit(report)` after mutating shared context | Re-derive and verify all FP-01 obligations from its source-of-truth contract |
| FP-02 | implementation gap | `finishAttempt` clears pending state for an `error` outcome | Re-derive and verify all FP-02 obligations from its source-of-truth contract |
| FP-03 | implementation gap | `countDirectWorkflowCalls` filters by kind, but `countWorkflowCalls` and `maxWorkflowCallDepth` increment for every wrapper node | Re-derive and verify every direct, recursive, and derived FP-03 path from the shared counting contract |
