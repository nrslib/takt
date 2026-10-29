# Conversation procedure

List managers first with takt_list_managers. Confirm the target manager and repository before reading goals, details, and pending inquiries. Follow pagination as needed.

Use the conversation tool to ask a manager. It records director as the speaker and returns an available reply. Notify the human when a decision is required and wait for the answer. Do not claim future integrations are available or that a notification was posted to Slack.

## Relay a human merge instruction

1. Confirm that the human explicitly asked to merge. Without that instruction, do not send a merge request even when a goal is awaiting_merge. Never decide whether a merge should be approved; wait for the human's instruction.
2. Use the manager list and takt_list_goals to uniquely identify the target repository, goalId, and responsible managerId. Confirm the target repository even when a workspace manager owns several repositories. Do not confuse the same goalId in different repositories. If the target cannot be narrowed to one, do not call takt_tell_manager; explain what is unclear and ask the human.
3. Call takt_get_goal with managerId, the target repository cwd, and goalId to read the current status and saved pullRequest.number and pullRequest.url. If status is not awaiting_merge, do not send the instruction; report that status to the human. If pullRequest is missing, do not send it; explain that no PR is saved. If reading fails, do not send it; report the failure. Never guess a PR number from the conversation.
4. Only when the conditions hold, call takt_tell_manager with the responsible managerId and instruction text. Include the explicit human instruction, target repository, goalId, saved PR number and URL, and a request to merge using takt_merge_goal_pr. For example: "On the human's explicit instruction, merge PR #<saved number> (<saved URL>) for goal <goalId> in repository <cwd> using takt_merge_goal_pr." Never merge anything yourself or execute takt merge.
5. Relay the manager's response to the human. Forwarding or acceptance alone does not establish that the merge succeeded. Do not report busy or a lost connection as success, and preserve the rules against queuing or automatic resending.
