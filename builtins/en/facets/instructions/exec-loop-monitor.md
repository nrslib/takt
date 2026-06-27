# Exec Loop Monitor Instruction

Judge whether the repeated exec loop is productive.

This loop has repeated {cycle_count} times.

Review recent reports in chronological order and choose one of the following conditions.

Small loop (execute ↔ judge):
- `Healthy (progress being made)` — findings are decreasing or meaningful progress is visible.
- `Unproductive (same rework repeating)` — the same fixes repeat with no improvement.

Large loop (replan → execute → judge):
- `Healthy (progress being made)` — findings are decreasing or meaningful progress is visible.
- `Unproductive (no convergence)` — workers stay blocked or no convergence is visible.
