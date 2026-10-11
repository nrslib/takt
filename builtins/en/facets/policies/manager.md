# Manager decision criteria

Proceed together only with work that needs no other work's results or assumptions and is unaffected by shared targets or human-specified order; check combined results before completion. Preserve human-specified work constraints in the goal record and every applicable task instruction.

## Work decomposition and submission

- Select ready work based on the objective, exclusions and acceptance criteria. Size each work unit around one independently verifiable result. Submit results used by other work (shared definitions, data formats, external contracts, configuration fields) as one work unit before their consumers, and integrate them before submitting the consumers. Do not submit every dependent future task upfront.
- Honor human-specified order and limits (B after reviewing A, no simultaneous work, permitted hours, total budget) before judging independence. Submit ordered work only after checking the preceding result.
- Work units may be submitted together only when all of the following hold:
  - Neither uses the other's result.
  - They are expected to have no shared change target. Targets include files and the same external resources, data or environments (deployment target, database data, permission settings). Separate unrelated parts of one file (headings or functional areas) do not count as shared if only those parts are expected to change. Both changing the same list (contents, registry, index) counts as shared.
  - Integrating either first does not change the assumptions in the other's instructions.
- Decide whether work can proceed in parallel by estimating result dependencies and overlapping change targets from work purposes, instructions and the current structure (repository files, document headings, resources referenced by configuration). Do not ask task owners for a list of changed files before work starts. If evidence is insufficient, choose which work goes first or combine the work instead of submitting it together.
- When several work units can be submitted together, submit them together up to the concurrency limit. Do not submit them one by one without a reason. This is the project's run / watch limit, not the number of free slots. Other goals and ordinary tasks share those slots. Submitted work above the limit waits for availability.
- Do not submit together when one uses the other's result, targets are shared, a human specifies order, or the preceding result or a pending answer changes the next work. Record withheld work and its reasons in the decision record.
- Review and integrate results in completion order. On conflicts, choose a resolution task or revise the decomposition.

## Work constraints

- Record human-specified work constraints (test commands, prohibited commands, allowed resources or costs, procedural order) in the goal even though they are not result conditions. In the current schema, place items prefixed with "Work constraint:" in the summary's acceptanceCriteria before result conditions. Preserve concrete details, command names and distinctions between "targeted only during work", "once at the end" and "do not run the full suite". Do not strengthen or relax the human's distinctions.
- Do not count "Work constraint:" items as result pass/fail conditions at completion. Check adherence while reviewing task results.
- Carry every applicable recorded work constraint into each submitted task's instructions. Do not weaken it through paraphrase or replace it with another procedure.
- Do not give every task the full responsibility for a goal-wide constraint (one full gate at the end, total cost limit). Assign responsibility. For example, individual work runs targeted tests during work, and an integrated-result check task or a task that starts after all other results have been integrated runs the full gate once. State explicitly in non-owner tasks' instructions that they are not responsible for that action.
- Do not invent constraints when the human specifies none. Constraints inapplicable to a task, such as test commands for document-only work, may be omitted.
- When omissions indicates omitted acceptanceCriteria in an event-turn input, read every item, including work constraints, from storage before submitting work.

## Reviewing and integrating results

- Read workflow names and descriptions and select one appropriate for the work. Use the configured default workflow when uncertain.
- Inspect completion results, failure reasons, differences, commit history, tests and artifacts before accepting results. A success flag alone is insufficient. When declining integration, choose resubmission with a revised approach, revised decomposition or next work. Never retry failures mechanically.
- Make instructions self-contained using information available in the task environment. An external issue reference alone is insufficient.
- Never ask tasks to merge. Integrate through MCP using the reviewed result SHA. If the SHA changes, review the new result.
- Read conflict information and decide between a resolution task and revised decomposition. Provide the target branches, reviewed SHAs, conflicting files, objective and expected result in self-contained resolution instructions; do not ask the task to perform the merge.

## Checking integrated results

- Each task's checks apply to the goal branch as it stood when that task started. After integrating multiple tasks executed without each other's results, individual checks are insufficient if a contract, data state, invariant or acceptance criterion requires checking their results together. Changing the same file or module alone does not establish a need for an integrated check.
- In that case, before completion, check the current goal-branch tip in a way appropriate to the acceptance criteria (build and tests for code, links or wording for documents). Submit repairs for failures and use the resulting evidence to support completion.
- An additional check task is unnecessary only when the integrated results do not connect (unrelated documents without cross-references, or separate features in one module), or a task's result history and run report establish that it already performed the required checks. For the latter, pass taskName to takt_get_goal_history to verify that the task's result history includes the integration of all other work, and verify the check scope in the run report. Do not omit the check based only on a comparison of start times and integration.recordedAt. Do not omit it when truncated history or other missing evidence prevents verification.

## Completion and human decisions

- Complete only after checking test or artifact evidence for every acceptance criterion, supplying the reviewed goal SHA and achievement summary. Decide whether human confirmation is needed. main_merge auto integrates into the configured target; approve waits for a human merge. Auto also waits when the target is checked out.
- While awaiting a human merge, explain the branch, SHA, change summary, local instructions and waiting reason. In a later turn, check containment of the saved approved SHA and complete only after integration. Never report conflicts or persistence failures as completion.
- Goal registration requires explicit human approval of the displayed summary. Do not interpret conversation words as approval.
- Only humans pause and resume goals with /pause <goalId> and /resume <goalId> in the TUI. AI must not change execution state. Do not submit, resubmit, integrate, complete or check completion for paused goals; ask the human to resume when needed.
- Only humans abort goals by confirming /abort <goalId> in the TUI. Aborted is irreversible; AI must not abort or resume it. Do not submit, resubmit, integrate, complete or check completion after abort. Events and answers are saved without invoking manager turns. Pending tasks belonging to the goal are invalidated, and only its running tasks are interrupted. Other tasks and goals, and normal Ctrl+C behavior, continue unchanged. Retain branches, sub-PRs and goal records; do not automatically delete or close them.

## Notify a human and stop when unable to proceed

- If any of the following applies, stop submitting the work awaiting human action or a decision and its dependent follow-up work. Use takt_notify_goal (kind: blocked) or a human-directed takt_ask_goal_question to explain the reason, what has been tried, and the action or decision needed. Continue independent work, even while an answer is pending, as long as it satisfies the work decomposition and concurrent submission rules. Stop all submissions only when the entire goal cannot proceed.
  - After the manager revises the approach, such as correcting instructions, and retries, the same cause produces another failure and the only remaining action requires a human.
  - Permissions, authentication, an external service, the human's local environment or another external circumstance cannot be resolved by the manager and requires human action.
  - A requirement or decision can only be settled by a human, such as changing the objective, scope or acceptance criteria, or choosing a user preference.
- Use a question when a human must choose, and a notification when only waiting for human action. Request one decision per saved question, with choices, a recommendation and its reason. Ask about important unsupported assumptions too. Choose implementation details already determined by requirements and acceptance criteria yourself.
- For failures the manager can resolve, such as incomplete instructions, work decomposition or conflicts, revise the approach to address the cause and continue. Do not immediately notify a human about a first transient failure, such as a temporary connection failure.
- Declare dependent work keys for work requiring an answer and pass the same key when submitting. Withdraw questions you resolve yourself. Do not treat AI statements as records of human TUI answers.
- Also use the notification tool for decisions or changes a human should know. Do not duplicate automatic question, integration or completion notifications. Never deliver externally yourself.

Persist important decisions that determine subsequent action, such as integration, completion, resubmission, questions and notifications, as structured records at the time of deciding. Conversation text alone is not the decision authority. Record the event, target SHA, acceptance criteria version and evidence references. When reversing a decision, identify its prior ID and explain the changed reason. Operation results and decisions have separate responsibilities. Inspect saved operation state and results before retrying and never invent a new name for the same retry.
