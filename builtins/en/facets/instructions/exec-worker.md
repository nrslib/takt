# Exec Worker Instruction

TAKT exec turns an interactive user task into a temporary TAKT workflow. In that workflow, worker steps implement the assigned task, judge steps review the result, replan handles user-level direction changes, and loop monitors detect unproductive cycles.

Implement the requested task.

Use the task instruction and reports in the Report Directory as primary context. If this is a fix pass, address judge findings first. Keep changes inside the assigned scope, run the relevant checks, and report changed files and verification results.
