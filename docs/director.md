# Using director (experimental)

[English](./director.md) | [日本語](./director.ja.md) | [简体中文](./director.zh-CN.md)

Director assigns requests to a manager, checks goal progress, and answers questions within the agreed scope. Manager carries out work in its assigned repository. Each request is assigned to one manager.

## Start a conversation

Run this in an interactive terminal:

```bash
takt director
```

The daemon starts if needed and owns the conversation. Closing and reopening the TUI continues it, even when launched from another assigned repository. Previous messages and replies are not redisplayed.

Director is experimental. Behavior, settings, and saved data formats may change without notice. Human and event turns incur provider costs.

## Choose a manager

Ask for work, for example, “Add an article listing page to the blog.” Director uses `takt_list_managers` and the request to select the responsible manager. You do not need to supply a manager ID first. If it cannot choose, for example because two managers match, it presents the candidates and asks for clarification without creating a goal.

For a repository without a manager, supply its absolute Git repository path, for example, “Do this in /work/new-app.” Director uses `takt_add_manager`, which returns the manager ID and makes it appear in the list even without a goal. Relative paths, missing locations, and non-Git directories are rejected. Director does not search for an alternative repository.

Names such as `takt_add_manager` are tools used by director. As a user, make the request in the conversation.

## Confirm the proposal once

Once the manager is selected, director presents a proposal containing the manager, repository, objective, out-of-scope items, acceptance criteria, and constraints. Review it. If changes are needed, describe them in the conversation and review the revised proposal.

In the TUI, leave the input field empty, use `↑↓` to select “Register goal,” and press `Enter`. Select “Return to conversation without registering” or press `Esc` to dismiss it. Returning to the conversation is also the default selection.

One human confirmation registers the goal with the selected manager. No second confirmation in manager is required. The goal records `director` as its creation origin and saves the approved proposal revision. AI text or a message to manager cannot register it without human confirmation.

## Confirm through Slack

Configure director Slack in global `~/.takt/config.yaml`:

```yaml
director:
  slack:
    channel_id: C0DIR
    allowed_user_ids: [U0AAA]
```

Use the same Slack App as manager and invite the bot to the director channel. Set `TAKT_SLACK_APP_TOKEN` and `TAKT_SLACK_BOT_TOKEN` in the shell that starts the daemon. Keep tokens out of configuration files. Restart the daemon after changing Slack settings. See the [configuration guide](./configuration.md#slack-conversations-with-director) for setup.

Proposals also appear in the configured channel. Click “Register goal” to register or “Return to conversation without registering” to dismiss. In Japanese these buttons are “登録する” and “登録せずに会話に戻る.” Confirm the current proposal rather than an older revision.

`director.slack.allowed_user_ids` applies to messages and director registration and inquiry buttons. A registration click from a user outside the list does not register a goal. The key is required when Slack is configured; an empty list accepts no users' messages or actions. Manager inquiry operations use the separate `manager.slack.allowed_user_ids` list.

Replies to permitted users stay in the original thread, and new notifications are grouped by turn. Acceptance and completion are separate: check the registration result. Without `director.slack`, director neither sends nor receives Slack messages.

## Decide who answers questions

Ordinary questions (`routine`) for goals created through director go to director, such as choosing an implementation method within the agreed scope. Questions for goals started directly in manager initially go to the human.

The following types go to the human even when the goal's question route is director:

| Type | What requires a human |
|------|-----------------------|
| `permission` | Granting permission |
| `irreversible` | An irreversible operation |
| `agreement` | Changing the agreement |
| `humanTask` | Work only a person can perform |
| `humanFact` | Facts only a person knows |
| `unsure` | A question director is unsure how to answer |

When unsure, director uses `takt_escalate_goal_question` to hand that question to the human as `unsure`, without changing the whole goal's route. Human questions arrive directly in the director TUI and configured Slack channel. In the TUI, press `Ctrl+R` to select and answer a question. On Slack, use its choice buttons or thread. Director does not answer human questions on your behalf.

The answer records `human` or `director` in `answeredBy`, separately from `source`, which records the transport such as `tui`, `slack`, or `mcp`. Ask to see a goal's questions and answers: director uses `takt_list_goal_questions` and `takt_get_goal_question` to read the history, including human answers.

## Delegate to director or return to the human

For a goal started in manager, tell director “Take over this goal” to delegate ordinary questions. This is promotion. Say “I will handle this goal myself” to return questions to the human. Identify the repository and goal so the target is clear.

Director uses `takt_set_goal_question_route` only in response to a current human instruction. It does not switch based on its own decision or a watcher event. Pending questions are rerouted too, but the six human question types remain human after promotion. The creation origin (`creationOrigin`) and past answers stay unchanged; `questionRoute` records the current route.

## Remove a manager (fire)

Explicitly ask, for example, “Remove the blog manager.” Director checks the target and uses `takt_fire_manager`. It refuses if any assigned goal is neither completed nor aborted, reports the reason, and keeps the manager listed. Paused goals and goals awaiting merge are unfinished too.

On success, the manager disappears from the director list. Its repositories, goal records, branches, and conversations remain. To restore it, supply the same repository's absolute path and ask for work there. Preparing it again with `takt_add_manager` returns it to the list. There is no automatic hiding of unused managers or dedicated restore operation.

## Limits

Slack messages missed while the daemon is stopped or the PC is asleep are not recovered from channel history. A Slack setup command such as `takt director slack init` and a bundled director Slack App Manifest are also outside this scope. Create the Slack App using the configuration guide.

Director does not inspect repository contents or run internals, or rewrite repository settings such as `main_merge`. Managers inspect work details. Director relays a merge request to the responsible manager only on an explicit human instruction and never performs the merge itself. Message acceptance does not mean the merge succeeded. See [Managing goals](./goal-management.md#director-responsibilities) for processing details and restrictions.
