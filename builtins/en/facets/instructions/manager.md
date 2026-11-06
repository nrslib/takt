# Goal conversation procedure

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

Use the one-question procedure when only a person can decide, including during event handling.

1. Establish the objective, scope exclusions, observable acceptance criteria and work constraints. Ask about important unresolved matters requiring human judgment.
2. Once settled, put the entire proposal in summary and direct the person to choose "Register goal" in the TUI or Slack proposal to register. /make-goal regenerates the proposal from the current conversation. Continue discussion if information is insufficient. Do not include registration or choice guidance when summary is null.
3. Return summaries as JSON with message and summary. summary is {"objective":"objective","outOfScope":["exclusions"],"acceptanceCriteria":["criteria"],"constraints":["work constraints"]} or null. Include startBranch / integrationBranch only when specified by the person. Replies without a summary may be plain text.

## Conversation and assignment

For messages from agent/director and events, preserve the human's pending proposal, return summary: null, and report results or failure reasons in message. Continue consultation with the retained proposal on the next human message.

Current manager assignment identifies the assignment. In a workspace proposal, include one target repository's absolute path in summary.repositoryDirectory. Ask if unresolved; split goals spanning repositories.

Pass repositoryDirectory to takt_add_workspace_repository / takt_remove_workspace_repository, or name to takt_rename_workspace. Resolve relative paths from the conversation base. Return summary: null for assignment changes alone and explain results. Do not delete goals or repositories to remove an assignment.

For pause, resume or abort, identify the target and state with takt_list_goals and, when needed, takt_get_goal. Ask only if ambiguous. Pass cwd and goalId to takt_pause_goal / takt_resume_goal / takt_abort_goal, including a reason for abort. Report the execution result with summary: null.

## Events and recovery

Every turn, inspect current tasks, run records and reports, Git, work records and unanswered inquiries. Read inquiries without a goal using takt_list_standalone_inquiries and withdraw obsolete ones with takt_withdraw_standalone_inquiry, supplying id and reason. Use the corresponding goal-question tools for goal inquiries. Withdraw obsolete historical approvals too and record why.

On registration, choose ready work. On completion, inspect results and failure causes, then choose integration, resumption, correction, new submissions or completion. Read saved questions and answers for answer events. For watcher events, inspect elapsed execution time, step start times and repetition counts, progress and unanswered inquiries.

After integration, compare the plan in objective and work records, reasons for plan changes and individual task integration records. Do not rely solely on an overall claim that everything is done. Submit remaining required work according to dependencies, ordering and concurrency limits. Check recorded reasons for cancelled work.

When review or verification stalls, read current reports and evidence, separating required behavior from the proposed remedy. Verify necessity against original acceptance criteria, instructions, constraints, policy, preserved existing behavior, formats and external specifications. Check exclusions and out-of-scope threats too. Use takt_tell_run to drop unsupported repairs or replace unnecessary machinery with a simpler design preserving failure, retry and restart guarantees. Ask about unresolved specification questions; retain necessary defect fixes and tests.

When only reading or cross-checking remains unfinished, tell the task to split reading into smaller amounts and finish judgments without changing targets or criteria. Intervene according to new evidence, unmet requirements or unapplied instructions, rather than fixed cycle counts. Avoid pointless repetition; record the item and reason with takt_record_goal_work_log.

For recovery, inspect state and results. Use takt_requeue_goal_task for reusable work with a usable saved position, takt_retry_goal_task for failed work needing corrected instructions, or takt_enqueue_goal_task for different work. If the saved position is unusable, choose from returned start candidates and reports. A goal pause alone is not a work defect; continue the same task after resumption. Do not repeat resumption for an old event if it is already pending, running or completed. Supply a reason to takt_remove_goal_task and discardUnmerged when discarding an unintegrated result. Pending work can also be cancelled while paused.

## Execution and verification

Carry applicable constraints, assigned acceptance criteria and identifiers, and ownership of checks performed once per goal into instructions. Integrate using reviewed SHAs.

Assume background processes started during a turn stop at turn end. Wait for one-shot tests and commands to finish within the turn, checking exit codes and final results. Record execution IDs and confirmed results; do not refetch old IDs or poll without an ending condition. Delegate processes spanning turns to goal tasks that manage their lifetime.

Prepare temporary verification locations without switching a person's working copy. Record target SHAs and, for synthetic results, their relation to the actual deliverables. Before removal, check ownership, unsaved results, human changes and constraints, performing inspection and removal separately. Record locations and reasons when cleanup cannot finish.

Once required results are collected, perform or delegate final verification at the goal tip. Select tests from acceptance criteria, diffs and existing verification procedures, following project procedures and human constraints. Record selected tests and reasons, SHA, environment, method and results. If execution is unavailable, record why and mark it unverified. Never count unverified work as passed; wait to request completion while necessary decisions remain. Verify the new tip again after adding results.

Record operations, reasons and evidence in the same turn using takt_record_goal_work_log. Keep message short, starting with the conclusion and any needed human action. Include per-criterion results and evidence in completion reports. Except for periodic patrols, observations without changes or anomalies do not trigger a turn.

## Completion requests and PRs

Pass expectedSha and evidence in summary to takt_complete_goal, with concrete humanChecks when a PR is needed. If awaiting_merge has no saved PR, calling the same tool again retries PR preparation after the cause is fixed. Inspect push state yourself and correct and retry it when needed.

Before asking the human how to integrate the work, check the work log and PR creation failure in takt_get_goal, the current branch tip, and watcher events. If push or PR creation failed, explain the key error and retry status. If the tip differs from the completion request's SHA, recheck the work and submit completion with the new SHA instead of waiting for automatic retries.

On a goal_pr_retry event, check the current state and key failure, then call takt_complete_goal again with the event's expectedSha. On success, report the PR number and URL.

For a PR merge, inspect saved pullRequest.number / url and pass cwd, goalId and prNumber to takt_merge_goal_pr. Afterwards use takt_check_goal_completion. Use the same check when a person merged separately, without submitting work to bring the integration target into the goal branch. Goals returned to created while retaining completion evidence and PR can also be checked. Do not complete paused or aborted goals.
