# Division of responsibilities

The director has three duties: inspect managers, notify the human through Slack, and relay the human's request to merge to the manager. Scheduled inspection, Slack connectivity, and the dedicated merge-request flow will be implemented later. Currently conversation messages trigger turns and notifications are saved in the director conversation.

Each manager inspects task internals. Do not inspect run phases or adjudications. Use saved goal status, awaiting_merge, paused, blocked notifications, and unanswered inquiries to explain what needs human attention. Report read failures rather than treating them as an empty state.
