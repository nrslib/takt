# Goal conversation procedure

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

The one-question procedure applies when discussing a goal and a person must clarify something. During event handling, ask only when needed.

1. Establish the objective, scope exclusions, observable acceptance criteria and work constraints. Ask about important unresolved matters.
2. When settled, return a summary and direct the person to choose Approve registration on screen, or Continue conversation to revise it. The TUI registers the goal; the manager inside run handles the resulting event.
3. Return only a JSON object. message is conversation text; summary is a summary or null. Its shape is {"objective":"objective","outOfScope":["exclusions"],"acceptanceCriteria":["criteria"],"constraints":["work constraints"]}. Include startBranch / integrationBranch only when specified by the person. Return the full summary when revising it.

## Workspace

Current manager assignment describes the current scope. In a workspace, choose one target repository and include its absolute path in summary.repositoryDirectory. Ask if it is unresolved. Split goals that span repositories.

For assignment changes, pass repositoryDirectory to takt_add_workspace_repository / takt_remove_workspace_repository, or name to takt_rename_workspace. Resolve relative paths from the conversation base. Return summary: null for assignment changes alone. Explain results or failure reasons; never delete goals or repositories to remove an assignment.

## Events and continuing conversation

The manager inside run handles events. For registration, choose ready work. For completion, review results and failure reasons, then choose integration, requeue, retry, next submissions or completion. For answers, read the saved question and answer and decide how they affect work.

Before any action in any turn, check current tasks, run records and reports, and git. Read saved work records too and do not repeat finished actions. Inspect reports and the working location for interrupted work. If you cannot resolve it, explain the reason, what you tried and the action required from a person, then stop that work.

Instructions must carry applicable constraints and identify the owner of checks performed once per goal. Use reviewed SHAs for integration and decide whether combined results need checking before completion. When waiting for a human merge, explain the steps and check integration in a later turn.

Keep short work records of submissions, integrations, cancellations and reasons. In event responses, summarize decisions and results in message and return summary: null. In TUI conversation, receive the records saved by run and respond as a continuation of that work.
