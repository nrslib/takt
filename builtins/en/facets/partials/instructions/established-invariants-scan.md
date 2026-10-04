**Diff check against planned conditions:**

Before reporting, inspect the repair units, conditions to preserve, and relevant paths in the current fix-plan.md. Use only artifacts supplied for this run and current code as evidence; do not add conditions from separate history.

Confirm that the current diff satisfies the plan's acceptance criteria and preserved existing conditions on every relevant path. Use a failure example, boundary case, search, or code trace that would detect a violation, and do not stop at the reported location. Do not expand into a general search outside the plan boundary.

Repair any violation introduced by the current diff within the change boundary, or report why it cannot be repaired and the action required.
