# TAKT manager

## Conversation and events

The TUI handles discussion, summary approval, answers, pause/resume/abort and display. The manager inside the daemon handles registration, answer, task-completion and patrol events in order and saves work records. The TUI manager receives those records and continues the conversation. If automatic execution is disabled, a person starts run / watch.

One manager can cover several repositories through a workspace. People can request assignment additions/removals and renaming in conversation. Starting from any member repository opens the same workspace. Each goal proceeds in one assigned repository. A repository with unfinished goals cannot be removed.

## Tools

Manager tools expose existing TAKT features. Read tasks, run details, diffs, history and branch relations; submit, requeue, retry, remove, integrate into the goal branch and check completion. Pass the target repository's cwd and goalId for goal actions. Consult tool argument definitions before using them.

- Review the completion event and run details for the cause and stopped position before choosing a tool.
- Use takt_requeue_goal_task after external conditions (capacity, authentication, network or temporary failures) or limits stop work whose existing results are reusable.
- Use takt_retry_goal_task to correct missing or incorrect instructions and retry the same work.
- Use takt_enqueue_goal_task when changing the work split or choosing different work.
- Use takt_remove_goal_task with a reason to cancel unwanted pending work or clean up integrated results and failed or exceeded-limit tasks that will not be retried. Do not remove running tasks or completed tasks not yet integrated.

If the saved resume position is unavailable, choose a start position from returned candidates and run details.

Collect results on the goal branch, then integrate into the target to finish. manager.main_merge defaults to approve, waiting for a human merge. auto integrates automatically, but waits for a person when the target is checked out.

## Memory and notifications

Goal memory contains objective, scope exclusions, acceptance criteria, constraints, workLog, questions and answers. Check current state in tasks, runs and git. Use takt_record_goal_work_log to save work records during conversation too. Specify kind: patrol for records of inspection or notices alone. Omit it for actions that actually advance work, such as submissions or integrations.

Questions go to people. The TUI /answer command saves a selected or free-text answer. Receiving answers from Slack is not implemented. Paused goals defer events; aborted goals cannot resume.

Notifications appear in the TUI and Slack. manager.notifications switches question / awaiting_merge / completed / progress / blocked / custom on or off by kind. Question answering remains available when notifications are disabled. Failed event processing or TUI conversation sends blocked. Repeated failures still notify; no failure-state file is created. Without a Slack webhook nothing is sent; delivery failures are logged and work continues.

## Patrol evidence

A patrol event includes the observation time and the last work-record time excluding patrol-only records. Without work records, the goal creation time is used. Creation times absent from older records are unknown.

Task startedAt is the execution start; question and goal createdAt are their creation times. takt_get_run returns currentIteration, currentStepStartedAt, currentStepExecutionCount and timestamp / iteration for completed steps. Start times and counts come from saved start records; the current step start time is unknown when no corresponding record exists.

manager.patrol_interval is in seconds and defaults to 1800. Unfinished active goals are inspected at this interval after the previous patrol finishes; the first patrol for a new goal is measured from creation. A failed patrol sends blocked and removes its event. Both successful and failed patrols save their completion time. Ordinary failed events remaining in the inbox are retried during patrol.
