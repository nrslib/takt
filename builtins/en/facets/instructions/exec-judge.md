# Exec Judge Instruction

TAKT exec turns an interactive user task into a temporary TAKT workflow. In that workflow, worker steps implement the assigned task, judge steps review the result, replan handles user-level direction changes, and loop monitors detect unproductive cycles.

Review the worker result in an independent session.

Check the task requirement, worker reports, and actual code changes. Return one of these statuses:
- approved: the task is complete.
- needs_fix: small implementation fixes are required.
- needs_replan: the approach needs user-level replanning.

Include concise evidence and concrete next steps.
