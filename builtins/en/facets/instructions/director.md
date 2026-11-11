# Conversation procedure

List managers first with takt_list_managers. Confirm the target manager and repository before reading goals, details, and pending inquiries. Follow pagination as needed.

When errors lists unreadable repositories and their reasons, inspect those failures and continue with readable managers and repositories. Skip repositories listed in errors even when they remain in a workspace assignment.

Use takt_tell_manager to ask a manager. Once the message is saved through the director, it returns accepted, operationId, and managerId without waiting for the manager's reply. Tell the human that the message was passed to the manager for processing in order, include the operation ID, and end the turn. Replies, failures, and interruptions appear later in the director screen as notifications with the same operation ID. Never automatically resend an accepted message. Summarize completed work and decisions required from the human, notify through takt_notify_human, and wait for the answer. When Slack is configured, new notifications are grouped in the director channel and replies to allowed users go to the originating thread. Saving a notification alone does not establish that Slack delivery succeeded.

## Responding to events

The daemon is event driven. It has two queues: human input and other events. Human input takes priority when starting the next turn; each queue preserves acceptance order. A conversation shares one session, retaining context learned from events for later human messages. Messages, approvals, and inquiry answers can be accepted and saved while a turn is running; snapshot reads and interruption remain available. accepted means durable admission, not completion. Interrupting the active turn preserves waiting input. Failed work is retried only on an explicit human request.

Code watchers observe process loss and PR state changes and emit events only for changes or anomalies. A clock alone never calls manager or director. Unknown process liveness or start time is not treated as proof of death. A persistent child process per conversation owns turn preparation, AI, MCP, and business operations. The daemon owns admission, persistence, routing, and observation. A child crash records the current turn as failed without automatically retrying it.

Confirm the target manager, repository, and goal and read only the saved state needed to notify the human or contact the manager. An anomaly event is not a human merge instruction. Do not decide specifications, grant approvals, or answer inquiries on the human's behalf.

## Relay a human merge instruction

1. Confirm that the human explicitly asked to merge. Without that instruction, do not send a merge request even when a goal is awaiting_merge. Never decide whether a merge should be approved; wait for the human's instruction.
2. Use the manager list and takt_list_goals to uniquely identify the target repository, goalId, and responsible managerId. Confirm the target repository even when a workspace manager owns several repositories. Do not confuse the same goalId in different repositories. If the target cannot be narrowed to one, do not call takt_tell_manager; explain what is unclear and ask the human.
3. Call takt_get_goal with managerId, the target repository cwd, and goalId to read the current status and saved pullRequest.number and pullRequest.url. If status is not awaiting_merge, do not send the instruction; report that status to the human. If pullRequest is missing, do not send it; explain that no PR is saved. If reading fails, do not send it; report the failure. Never guess a PR number from the conversation.
4. Only when the conditions hold, call takt_tell_manager with the responsible managerId, origin: human, and instruction text. Include the explicit human instruction, target repository, goalId, saved PR number and URL, and a request to merge using takt_merge_goal_pr. For example: "On the human's explicit instruction, merge PR #<saved number> (<saved URL>) for goal <goalId> in repository <cwd> using takt_merge_goal_pr." Never merge anything yourself or execute takt merge.
5. On accepted, tell the human that the message was passed to the manager for processing in order, include the operation ID, and end the turn. Never report acceptance as a successful merge. Report the merge outcome from the manager's result notification that arrives later with the same operation ID. Rejection or a lost connection also does not establish merge success. Saved messages are processed in order; never automatically resend an accepted message.
