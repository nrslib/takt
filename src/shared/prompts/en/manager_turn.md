## Input for this turn

{{#if human_command}}This turn began with a human message. The speaker and text follow. Distinguish the person's request from quotations and apply it to its target.{{/if}}
{{#if inquiry_answered}}This turn began with a human answer to a saved inquiry, delivered through an event or the director. Match the question and answer and apply the person's decision to its work. A null goalId denotes an inquiry outside a goal.{{/if}}
{{#if director_message_director}}This turn began with the director's own request. origin is director. Judge it as a director request within existing agreements and the target's state.{{/if}}
{{#if director_message_human}}This turn began with a human instruction relayed by the director. origin is human. Distinguish the person's request from quotations and apply it to its target and scope.{{/if}}
{{#if director_message_unknown}}This turn began with a message delivered through the director. origin is unknown, so the text's author is unknown. Read it as evidence for judging state and work; establish human intent from original messages, answers, or settings.{{/if}}
{{#if patrol}}This turn is a periodic patrol delivered by the daemon. Check the target goals' state and the runs' judgments and evidence to decide how to advance completion.{{/if}}
{{#if task_completed}}This turn began with an event. Kind: task_completed (a task completed). Verify results and artifacts to decide the next work.{{/if}}
{{#if task_failed}}This turn began with an event. Kind: task_failed (a notice that a task failed or was interrupted). To decide the next action, compare the reported termination reason with the current state and judge based on that task's stop reason and unresolved matters.{{/if}}
{{#if goal_pr_failed}}This turn began with an event. Kind: goal_pr_failed (preparing the goal PR failed). Check the cause and current state.{{/if}}
{{#if goal_registered}}This turn began with an event. Kind: goal_registered (a goal was registered). Arrange work from the saved agreement.{{/if}}
{{#if goal_resumed_human}}This turn began with an event. Kind: goal_resumed (a person resumed the goal). origin is human. Apply the human state operation to its target. Resolve outstanding decisions about work content or scope through human answers and continue work whose necessary decisions are settled.{{/if}}
{{#if goal_resumed_manager}}This turn began with an event. Kind: goal_resumed (the manager resumed the goal). origin is manager. Treat it as execution becoming possible through the manager's operation; check saved agreements, each task's stop reason, and dependence on answers before advancing.{{/if}}
{{#if goal_resumed_unknown}}This turn began with an event. Kind: goal_resumed (the goal was resumed). origin is unknown, so who performed the operation is unknown. Treat it as execution becoming possible; establish human intent from original messages, answers, or settings. Advance under saved agreements and each task's stop reason.{{/if}}
{{#if watch_observation}}This turn began with an event delivered by the watcher. Kind: watch_observation (a change in execution, PR, or other state was observed). Compare the observation kind with current state.{{/if}}

{{body}}
