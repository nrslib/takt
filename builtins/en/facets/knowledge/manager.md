# TAKT manager

## Goals, tasks, and results

One manager can be responsible for multiple repositories in a workspace. Each goal progresses in one assigned repository. A repository can be removed from the assignment once each of its goals is completed or aborted.

Task termination, integration of results into the goal branch, PR merging, and goal completion each have their own operations and recorded states. accepted denotes receipt; task success describes the execution result. takt_list_tasks returns integration state in goalIntegration (integrated / not_integrated / unknown / direct_push), with the reason for unknown in goalIntegrationReason. direct_push identifies tasks that push directly to the PR branch.

A goal is registered when a person approves its proposal in the TUI or Slack. /make-goal regenerates a proposal from the conversation.

## Execution and events

Pausing holds execution and subsequent events; aborting is terminal. Resuming also makes pending tasks eligible to run. Saved task instructions are updated through the instruction-change operation.

Task termination, human answers, and saved PR merges, closures, or conflicts with the integration target arrive as events. Periodic patrols inspect eligible active goals together, including awaiting_merge goals with a linked merge task that is pending or running. Goals only waiting for a human merge are excluded from patrols and handled by the PR watcher.

The standard PR finishing workflows (merge-prepare / merge-review-fix-simple) handle integration of the target branch, conflict resolution, review, CodeRabbit feedback, and waiting for CI. Review and CI waiting in a custom merge.workflow follow its defined steps. Tasks can be submitted while CI is running. Their results distinguish prepared, merged, and unresolved and include the PR state.

manager.main_merge is resolved from project configuration. Both approve and auto create PRs. approve finishes preparation with until: prepare and waits for a person to merge. auto treats the person's setting as a continuing instruction to integrate and uses until: merge to finish preparation and merge.

The concurrency limit is shared across the project's run / watch processes. The manager's automatic run follows auto_run to execute goal tasks, with zero automatic retries. A lock coordinates execution to prevent duplicate starts; the manager decides recovery from saved state. A turn that fails after using tools is saved as failed, and the manager also decides its recovery.

## Tools and recovery

Goal operations use the target cwd and goalId. Each tool's arguments and return values follow its published definition.

- takt_get_workflow accepts a name, scope reference, or path in workflow and returns step names, descriptions, types, wait, system_inputs, effects, and rules. workflow_call returns the resolved callee and getInput; the workflow and callPath in getInput allow further traversal. Responses are limited to 64 KiB, and omitted steps can be retrieved with offset / limit.
- takt_enqueue_goal_task queues a task that runs in a worktree based on the goal branch. autoPr and shouldPublishBranchToOrigin default to false. workflow accepts a name, scope reference, or path, including workflows containing merge_pr / close_pr.
- takt_requeue_goal_task continues failed / exceeded tasks from a saved position. failed also accepts startStep; exceeded uses the saved position. Responses describe whether a saved position is available, the reason, and candidate starting steps.
- takt_retry_goal_task updates instructions and returns the same failed task to pending.
- takt_remove_goal_task takes a reason and handles cancellation of pending tasks and cleanup of stopped or integrated results. Pending tasks in paused goals can also be cancelled. discardUnmerged: true discards completed results awaiting integration. takt_stop_goal_task requests a stop for running tasks. Cleanup failures appear in the operation result.
- takt_stop_goal_task checks goalId, taskName, executionId, and the live PID before saving a stop request. The saved start time is also used in the check. The worker observes the request and stops; running remains until then.
- takt_tell_run sends additional instructions using cwd, goalId, taskName, and content and saves the original text in the work log.
- takt_pause_goal / takt_resume_goal / takt_abort_goal use cwd and goalId; aborting takes a reason. Tasks stopped by a pause remain as failures with `Goal <id> was paused`; interruptions before startup may have empty position or run information. After resuming, the same task can continue according to its saved state. Aborting invalidates unstarted work, interrupts running work, and retains records and branches. completed identifies a completed record available for reference.
- takt_list_standalone_inquiries returns unanswered inquiries without a goal for the current assignment. takt_withdraw_standalone_inquiry withdraws unanswered inquiries by id and reason and preserves answered records.

## Integration and PRs

Results from ordinary tasks are gathered in the goal branch and integrated from there into the target branch.

takt_complete_goal accepts expectedSha, an evidence-backed summary, and humanChecks for the PR. In awaiting_merge, it pushes the branch and creates or reuses a PR with the saved integration target as base. It checks GitHub, origin, and the PR head/base, and saves the number and URL in pullRequest. While the goal content is not yet included in the target, a same-SHA request with an existing PR can refresh the completion summary and PR body. When retrying PR preparation without a saved PR, saved humanChecks take precedence; a supplied value only fills the field if none was saved, and the saved summary remains. If humanChecks is omitted, the saved value is reused and the supplied summary can be saved. If neither a saved nor supplied humanChecks value exists, the retry is rejected before PR preparation. If an existing PR body update failed, a supplied humanChecks value replaces the saved value and is published on retry. Before resubmitting, inspect and verify the current goal tip; if it has advanced beyond the saved goalSha, review the new tip and resubmit with its expectedSha, summary, and humanChecks. If only reading or updating an existing PR body fails, the saved PR is retained and pullRequestBodyError is returned.

Choose how to correct or check a saved completion record according to the approved SHA and the current goal branch tip:

- Before resubmitting, inspect and verify the current goal branch tip. If it has advanced beyond the approved SHA, review the new tip again and resubmit takt_complete_goal with the new expectedSha, summary, and humanChecks. This also applies when the approved SHA is already included in the target.
- If the tip is still the approved SHA and that SHA is not yet included in the target, use takt_reopen_goal with a reason to return to created, then resubmit takt_complete_goal with the reviewed expectedSha, corrected summary, and humanChecks to correct the saved evidence.
- For an awaiting_merge goal, if the approved SHA is already included in the target and is still the current goal branch tip, correct the evidence with takt_complete_goal using the same expectedSha, corrected summary, and saved humanChecks. This correction path does not work after the goal is completed: takt_complete_goal returns the existing record without changing its summary, and takt_reopen_goal rejects completed goals. Do not use takt_reopen_goal for an included SHA.
- If the approved SHA is already included in the target and no evidence correction is needed, use takt_check_goal_completion.

takt_merge_goal_pr accepts cwd, goalId, prNumber matching the saved PR, and until. It queues a merge task as pending and returns its name. until: prepare uses merge-prepare; until: merge uses merge.workflow (default: merge-review-fix-simple). It checks the saved PR, awaiting_merge, and pause/abort state.

Merge tasks push directly to the PR branch. The local goal branch is fast-forwarded when it is an ancestor; diverged branches and checked-out working copies retain their contents, and this is recorded in the result. When a workflow ends with COMPLETE and the PR is still at the preparation stage, the result arrives as successful with prepared.

takt_check_goal_completion checks the saved PR's head/base and merge state, supporting completion checks after squash merges or additional commits. A saved PR in CLOSED returns included: false. Content comparison with the integration target is also used according to the PR state. Goals in created that retain completion evidence and a merged PR can also be checked. Completion updates status to completed and closes the goal's inquiries.

## Conversation, records, and inquiries

A persistent child process for each conversation handles turn preparation, AI, MCP, and business operations; the daemon handles receipt, persistence, delivery, and monitoring. Human input and other events use separate queues, with human input prioritized for the next turn. Each queue preserves arrival order, and a conversation runs serially. Pending input is preserved through interruptions.

Saved information includes objective, outOfScope, acceptanceCriteria, constraints, specifications, workLog, questions, and answers. takt_record_goal_work_log can also be used from the conversation; kind: patrol denotes an inspection record.

People answer through Ctrl+R in the TUI or the inquiry thread in Slack, and the answer's source and type are saved. Historical approval records are available for reference and withdrawal. Completion and abortion close inquiries; pausing retains them.

The TUI handles consultation, proposal approval, answers, state operations, and display. Proposals are navigated with the arrow keys and Enter; returning to the conversation or entering revisions withdraws the proposal. Ctrl+R opens inquiries and Ctrl+G opens active goals. Both remain available during processing. Tab confirms / completions. /make-goal and /verify are conversation commands; other / input is treated as a message. Responses containing summary display a registration proposal.

manager.notifications toggles question / awaiting_merge / completed / progress / blocked / custom by kind. Answer screens are available from saved questions. The normal screen shows the beginning of notifications received since startup; full text and past notifications are available from goal records. Notification delivery results are saved in logs.

## Watching and specification verification

Watchers deliver process disappearance and PR state changes. Process liveness and start time are checked to determine state. takt_get_run returns currentIteration, currentStepStartedAt, currentStepExecutionCount, and timestamp / iteration for finished steps. Start time is a value or unknown according to the availability of corresponding logs.

Conflicts with the integration target arrive as pr_conflicting. Notifications follow changes in the conflict state, including recurrence after resolution. A mergeable value of UNKNOWN denotes a pending determination.

specifications is an optional saved field. Each body can be retrieved by passing specifications.gherkin, specifications.quint, or specifications.alloy as path to takt_get_goal. Saved specifications are automatically supplied to the final PR review task.

When formal specifications are enabled, a person sending /verify in the TUI or Slack conversation triggers specification generation from the current agreement, verification, and a result returned to the same conversation. Saved goals and specifications retain their pre-verification contents. Responses indicate whether verification is available according to formal specification configuration.
