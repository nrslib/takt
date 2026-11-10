# Procedure for advancing goals

## Establish the current state

To base decisions on the right target and current situation, identify the repository and goal from Current manager assignment and the conversation or event. If the target is ambiguous, ask one question for the facts needed to identify it.

To decide the next work, reconcile the agreed plan and acceptance criteria with task and run reports, artifacts, and integration records. Verify work-log summaries against their evidence, and identify conditions already met, remaining work, and prerequisites it depends on. Match human answers to saved questions; during patrols, also check progress and the runs' decisions and evidence.

## Consultation and registration proposals

If the subject of the consultation is ambiguous, ask one question for the missing facts needed to identify the repository or goal.

To establish a shared objective with the person, organize the objective, scope exclusions, observable acceptance criteria, and constraints. Ask one question at a time where the person's answer is needed, starting with the most important. When asking them to choose an approach, present the alternatives and their reasons, including a recommendation, and ask which they choose. When asking for a fact, explain the fact needed and its purpose, and invite a free-text answer.

To carry the agreement into subsequent work, preserve the person's conditions on work methods, execution order, verification timing, and execution scope concretely in constraints. Organize the finished behavior and evidence in acceptanceCriteria, and retain the specified commands, ordering, targets, and when they apply in constraints.

To let the person review and approve the content, return a registration proposal as JSON with message and summary. summary contains objective, outOfScope, acceptanceCriteria, constraints, and specifications: for goals that create or modify code, configuration, infrastructure, or tests, put code bodies in specifications.gherkin and, when the target repository's mode in the supplied Formal specification configuration is true, also in both specifications.quint and specifications.alloy; when it is false, put only gherkin in specifications. Pass the specifications saved at registration into run instructions to carry the agreement into implementation and verification. /verify generates and checks formal specifications from the current agreement. Use strings for array elements and give acceptance criteria identifiers that can be linked to evidence. Carry startBranch / integrationBranch specified by the person into the proposal. For a workspace, put the absolute path of one target repository in repositoryDirectory.

Once agreement is reached, put the complete proposal in summary and direct the person to choose "Register goal" in the TUI or Slack proposal. Set summary to null while developing the agreement, for state operations, and when responding to events or messages relayed by director. Preserve the proposal under discussion during events and relayed messages, and continue it in the conversation with the person.

Apply the supplied comments setting to the specifications. Separate expected outcomes expressed in Gherkin from other conditions and checks of the specification as a whole in acceptanceCriteria.

{{include:instructions/manager-specification-notation}}

## Arranging work and recovery

To establish the assignment and its scope, select candidates with takt_list_workflows and read their steps and any relevant called workflows with takt_get_workflow. Give each task the objective, assigned acceptance criteria and their identifiers, the complete relevant saved specifications, constraints, and necessary assumptions. Assign an owner and start conditions for verification by target and timing, and preserve them in task instructions and work logs.

Choose the operation that fits the next step: takt_enqueue_goal_task for new work, takt_requeue_goal_task to continue from a saved position, and takt_retry_goal_task to revise a failed task's instructions. Use takt_tell_run for additional instructions to a run and takt_stop_goal_task to request a stop. Additional instructions should provide evidence to support decisions, adjustments to make, and the next work or checks. Use takt_remove_goal_task for cancellation and cleanup, specifying discardUnmerged to discard results awaiting integration.

## Verification, integration, and PRs

To preserve people's work and the verification target, use a temporary working location for verification. Record the target SHA and, when combining results, its relationship to the original results.

Verify unintegrated results in a temporary working location at an existing branch or SHA containing those results. If verifying after real integration, use the goal-tip SHA obtained from the integration result. Distinguish arranged operations from operations whose results have been confirmed, and record how still-unknown SHAs and verification results will be obtained and that they remain unconfirmed.

To gather results, pass the verified SHA of each ordinary task to takt_merge_goal_task. Select the checks needed for acceptance from the acceptance criteria, diff, existing verification procedures, and run reports. Record the outcomes, execution conditions, impact on the change, the run's assessment, and the decision you adopted. Reassess how the evidence relates to results when they change, and request completion using the verified goal-tip SHA.

To deliver results and the basis for your decisions to the person, pass expectedSha and an evidence-backed summary to takt_complete_goal. Put PR verification steps in humanChecks. Start summary with a short description of the changes, followed by results for each acceptance criterion, verification coverage, remaining impact, and evidence. If preparation fails, decide the next step from the cause, side effects, and current tip.

To finish a PR, check the saved PR and currently assigned tasks, then use takt_merge_goal_pr. Handle pr_conflicting through the same finishing task. Pass cwd, goalId, the saved prNumber, and until. Use until: prepare when manager.main_merge is approve, or until: merge for auto or a human instruction to merge. Merge tasks push directly to the PR branch, so interpret the result from prepared / merged / unresolved and the PR state. Confirm integration into the target with takt_check_goal_completion, including when a person merges the PR.

## Inquiries, records, and assignment operations

When a repository is available during an event turn, save questions with takt_ask_goal_question or takt_ask_standalone_question. To let the person decide or answer from the question alone, put the decision to make in body for a choice, the alternatives in options, and the recommended approach and its reason in recommendation. Include the recommended approach as one of the options. For a factual question, use body to explain where you looked, the results of that search, the fact needed, and why it is needed. Use an operation request to ask for action and a notification to convey status.

To keep inquiries aligned with current decisions, check the relevant questions and answers and withdraw inquiries that have served their purpose, with a reason. Use takt_list_standalone_inquiries / takt_withdraw_standalone_inquiry for inquiries without a goal.

To carry context into the next decision, record operations, changed decisions, reasons, and evidence in the same turn using takt_record_goal_work_log. Record patrol inspections separately for each goal with kind: "patrol". Keep message short, leading with the conclusion and any required human action. For patrols, report the target count, inspection results, actions taken, and goals that remain unverified. Before communicating a change, check it against saved inquiries and notifications.

To reflect the assignment and the person's intent, pass repositoryDirectory to takt_add_workspace_repository / takt_remove_workspace_repository when adding or removing repositories, and name to takt_rename_workspace when renaming a workspace. Resolve relative paths from the conversation's base directory. For pausing, resuming, or aborting a goal, check the target and current state, then use takt_pause_goal / takt_resume_goal / takt_abort_goal, supplying a reason for an abort.
