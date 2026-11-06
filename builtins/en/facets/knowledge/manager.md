# TAKT manager

## Conversation and state

The TUI handles discussion, proposal approval, answers, state operations and display. /make-goal regenerates a proposal from the conversation; it does not register it. Use ↑ Register goal / ↓ Return to conversation without registering / Enter Confirm to operate the proposal. Returning to the conversation or typing changes dismisses the proposal. Replies without summary do not display a proposal. Ctrl+R opens unanswered inquiries and Ctrl+G opens ongoing goals, including while processing. Tab accepts / completion; slash input other than /make-goal is ordinary speech.

A persistent child per conversation owns turn preparation, AI, MCP and business operations; the daemon owns admission, persistence, routing and observation. Two queues contain human input and other events. Human input has priority for the next turn; each queue preserves admission order. Turns in one conversation are serial and one session retains event knowledge. accepted means durable admission, not success. Saving input, reading and interruption remain available during processing; interruption preserves waiting input. A child crash records failure without blindly replaying the turn. Manager may inspect current state and decide recovery.

One manager can cover multiple repositories through a workspace. Starting from any member opens the same conversation. Each goal belongs to one assigned repository, and unfinished goals prevent assignment removal. Registration requires proposal approval in the TUI / Slack. State tools are exposed for all providers with the required MCP capability.

## Tools and recovery

Use the target cwd and goalId for goal operations and consult argument definitions. takt_list_tasks returns goalIntegration (integrated / not_integrated / unknown) and goalIntegrationReason when unknown. A success flag alone does not establish integration.

- takt_enqueue_goal_task accepts workflow names, scope references and paths, and runs in a worktree based on the goal branch. autoPr and shouldPublishBranchToOrigin default to false and can be set on submission. Workflows containing merge_pr / close_pr are supported.
- takt_requeue_goal_task continues failed / exceeded work from its saved position. Failed work may choose startStep; exceeded work cannot specify it. An unusable position returns the reason and candidates.
- takt_retry_goal_task corrects instructions and returns the same failed task to pending. Use new submissions for different work or splitting.
- takt_remove_goal_task cancels pending work or cleans up stopped or integrated results with a reason. Pending cancellation also works while paused. discardUnmerged: true explicitly discards an unintegrated completed result. Running work cannot be removed; cleanup failures are not success.
- takt_stop_goal_task saves a stop request after matching goalId, taskName, executionId and a live PID. A saved start time must also match the current start time. The worker observes the request and stops; running remains until it finishes.
- takt_tell_run sends an additional instruction to running work using cwd, goalId, taskName and content, saving the original text in work records.
- takt_pause_goal / takt_resume_goal / takt_abort_goal take cwd and goalId, with a reason for abort. Pause stops ongoing execution and defers new execution and relevant events. Stopped tasks retain failure reason `Goal <id> was paused`; there may be no saved position or run if stopped before startup. After resumption, inspect state and continue the same task. Abort invalidates unstarted work and interrupts running work. It is terminal; records and branches remain. Completed goals cannot undergo these state operations.
- takt_list_standalone_inquiries reads only unanswered inquiries without a goal under the current assignment. takt_withdraw_standalone_inquiry withdraws one by id and reason without changing answered inquiries.

Automatic manager runs respect auto_run, execute goal tasks only and prevent duplicate runs. Goal runs retry automatically zero times; manager decides recovery. Failed turns that used tools are not automatically replayed.

## Integration and PRs

Collect results on the goal branch, then integrate into the target. manager.main_merge uses project configuration only. The default approve prepares a PR and waits. auto is a continuing integration instruction set by the person and integrates automatically. A checked-out target results in PR preparation.

takt_complete_goal takes reviewed expectedSha and evidence in summary, with humanChecks when a PR is needed. awaiting_merge pushes the branch and creates or reuses a PR based on the saved integration target. It checks GitHub, origin and existing PR head/base, saving the number and URL in pullRequest. If push or PR preparation fails before a PR is saved, call takt_complete_goal again after fixing the cause. Manager can inspect push state and correct and retry it itself.

takt_merge_goal_pr runs takt merge with cwd, goalId and a prNumber matching the saved PR. It is also available when a person directly tells manager to merge. Saved PR, awaiting_merge and stopped-state checks remain. Afterwards use takt_check_goal_completion. A matching saved PR merged between the saved head/base can complete even after squash merging or extra commits. A PR closed without merging prevents completion. Awaiting-merge goals whose PR cannot be verified use content comparison. A goal returned to created retaining evidence and PR can also be checked.

## Memory, inquiries and notifications

Memory includes objective, outOfScope, acceptanceCriteria, constraints, workLog, questions and answers. Check current state in tasks, runs and Git. takt_record_goal_work_log can record during conversation. Historical kind: patrol is inspection alone, not progress.

People answer questions and operation requests through Ctrl+R in the TUI or Slack inquiry threads. Answer types and origins are saved; manager cannot answer on a person's behalf. Historical approvals remain readable and withdrawable but do not decide execution. Code closes inquiries on completion or abort; pause leaves them open.

manager.notifications switches question / awaiting_merge / completed / progress / blocked / custom by kind. Answer screens remain available when notifications are disabled. The normal display shows notification excerpts and does not replay notifications from before startup. Read goal records for full or past notifications. Delivery failures are logged and work continues.

Watchers deliver changes or anomalies such as lost processes or PR state changes; a clock alone does not call AI. Unknown liveness or start time is not proof of death. takt_get_run returns currentIteration, currentStepStartedAt, currentStepExecutionCount, and timestamp / iteration for finished steps. Start time is unknown without a corresponding saved record.
