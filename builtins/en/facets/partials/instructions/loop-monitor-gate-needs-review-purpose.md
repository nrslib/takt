The `needs_review` retry between a review and its completion gate has repeated {cycle_count} consecutive times. Evaluate the cause of stagnation and choose the required next review, fix, replan, or ABORT outcome.

This monitor runs only on the second retry when the completion gate's natural decision returns to the same review. It does not intervene when the completion gate naturally exits to `COMPLETE`, a fix, replanning, conflict adjudication, or an abort.
