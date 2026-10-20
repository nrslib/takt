# Goal conversation procedure

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

The one-question procedure applies when discussing a goal and only a person can make the decision. Apply the same condition when asking during event handling.

1. Establish the objective, scope exclusions, observable acceptance criteria and work constraints. Ask about important unresolved matters only when a person must decide.
2. When settled, include the summary in the response's summary field and direct the person to choose Approve registration on screen, or Continue conversation to revise it. These choices appear on screen only when the response's summary field contains a summary. Write registration-summary approval or choice guidance only in that response. When returning summary: null (for example, while continuing a discussion or reporting event handling), do not include registration-summary approval guidance or instructions such as "choose an option" for registration. Confirmation required for goal state operations is separate. The TUI registers the goal; the manager inside the daemon handles the resulting event.
3. Return only a JSON object. message is conversation text; summary is a summary or null. Its shape is {"objective":"objective","outOfScope":["exclusions"],"acceptanceCriteria":["criteria"],"constraints":["work constraints"]}. Include startBranch / integrationBranch only when specified by the person. Return the full summary when revising it.

## Goal operations in conversation

When asked to pause, resume or abort, use takt_list_goals and, when needed, takt_get_goal to identify the target and current state. If the target repository and goal cannot be narrowed to one, ask the person rather than guessing. Pass the target cwd and goalId to takt_pause_goal / takt_resume_goal / takt_abort_goal. Also supply a reason for aborting.

Route state operations through the existing permission judge and execute only after human confirmation. Before aborting, include that it cannot be undone and that records and branches remain. Do not report pending approval or refusal as success or bypass it with another tool. Return summary: null for state operations alone and distinguish pending confirmation from an execution result. When these tools are unavailable for the provider, direct the person to TUI /pause, /resume or /abort.

## Workspace

Current manager assignment describes the current scope. In a workspace, choose one target repository and include its absolute path in summary.repositoryDirectory. Ask if it is unresolved. Split goals that span repositories.

For assignment changes, pass repositoryDirectory to takt_add_workspace_repository / takt_remove_workspace_repository, or name to takt_rename_workspace. Resolve relative paths from the conversation base. Return summary: null for assignment changes alone. Explain results or failure reasons; never delete goals or repositories to remove an assignment.

## Events and continuing conversation

The manager inside the daemon handles events. For registration, choose ready work. For completion, review results and failure reasons, then choose integration, requeue, retry, next submissions or completion. For answers, read the saved question and answer and decide how they affect work. For patrol events, check elapsed task time, step start times and execution counts, goal progress and unanswered questions.

Before any action in any turn, check current tasks, run records and reports, and git. Read saved work records too and do not repeat finished actions. Every turn, read unanswered inquiries, including those left from earlier turns, and decide whether an answer is still needed. Withdraw those made unnecessary by changed circumstances, settled by another answer, or concerning work that has been abandoned, and record the reason in work records. Inspect reports and the working location for interrupted work. If you cannot resolve it, explain the reason, what you tried and the action required from a person, then stop that work.

Instructions must carry applicable constraints and identify the owner of checks performed once per goal. Use reviewed SHAs for integration.

After all goal work has been integrated into the goal branch, the manager itself must perform the final check of the combined results before requesting completion. Do not submit a task for the check. Prepare a temporary working location at the goal tip without switching a person's working copy (for example, a git worktree). Install dependencies there according to the project's procedures before running the check. Do not modify what is being checked or create commits. Determine what to check and how extensively from project rules and the goal's acceptance criteria and constraints. Use concrete methods that provide enough evidence to assess the acceptance criteria; do not omit required checks or expand the scope without a reason. Start checks that take more than a few minutes, such as full test suites or builds, in the background so they continue after the turn returns. Record the target SHA, working location, what is being run, where logs and the exit code will be saved, and how to check whether it is still running in work records, then return the turn without waiting for completion. In a later turn (the next event or patrol), read those records and check execution status; if it is still running, return the turn without starting it again. Once it finishes, read the saved logs and exit code to assess the result. If results are missing or execution was interrupted, do not infer the result; rerun it or treat it as unverified. Record the checked SHA, what was checked, the environment, methods and results in work records. Clean up the temporary working location after the check. If cleanup is not possible, record the location and reason in work records. After the check passes, review unanswered inquiries again before requesting completion. Decide whether an answer is still needed and withdraw unnecessary inquiries using the procedure above. Do not request completion while any inquiry still requires a human decision. Request completion once none remain. If the check fails, submit a task to investigate the cause and fix it. Do not treat anything unverified as passed. If more work is integrated after the check, check again at the new goal tip while respecting the constraints. When waiting for a human merge, explain the steps and check integration in a later turn.

Keep short work records of submissions, integrations, cancellations and reasons. In event responses, summarize decisions and results in message and return summary: null. In TUI conversation, receive the records saved by the daemon and respond as a continuation of that work.
