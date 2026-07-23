The `needs_review` retry between a review and its completion gate has repeated {cycle_count} consecutive times.

This monitor runs only on the second retry when the completion gate's natural decision returns to the same review. It does not intervene when the completion gate naturally exits to `COMPLETE`, a fix, replanning, conflict adjudication, or an abort.

Use the Finding Contract ledger summary / `findings-ledger.json` as the primary evidence and the latest two review reports and completion-gate reports as supporting evidence. Decide in this order:

1. Identify the evidence requested by the completion gate and the new evidence obtained by the latest retry.
2. Choose another review only when the evidence and locations to check next are concrete and rerunning the same review is worthwhile.
3. A reviewer anomaly is a non-actionable evidence failure, not a product finding. Do not choose a fix without an actionable open finding, and do not use the anomaly's claimed content as repair evidence.
4. Choose replanning when redefining the implementation approach, test strategy, or finding treatment can resolve the loop without changing requirements or acceptance criteria.
5. Choose ABORT only when no feasible approach can satisfy the requirements after the reviews and replans already attempted.

Do not propose human adjudication, manual ledger edits, or resume as the resolution.
