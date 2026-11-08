## Input for this turn

{{#if human_command}}This turn began with a human message. The speaker and text follow. Distinguish the person's request from quotations and apply it to its target.{{/if}}
{{#if inquiry_answered}}This turn began with a human answer to a saved inquiry, delivered through an event or the director. Match the question and answer and apply the person's decision to its work. A null goalId denotes an inquiry outside a goal.{{/if}}
{{#if director_message}}This turn began with a director message. Determine whether it is the director's own request or a relayed human instruction from its content and authorship.{{/if}}
{{#if patrol}}This turn is a periodic patrol delivered by the daemon. Check the target goals' state and the runs' judgments and evidence to decide how to advance completion.{{/if}}
{{#if task_completed}}This turn began with an event. Kind: task_completed (a task completed). Verify results and artifacts to decide the next work.{{/if}}
{{#if task_failed}}This turn began with an event. Kind: task_failed (a task failed). Check the failure record, stop reasons, current state and unresolved matters to decide recovery or a question for the person.{{/if}}
{{#if goal_pr_failed}}This turn began with an event. Kind: goal_pr_failed (preparing the goal PR failed). Check the cause and current state.{{/if}}
{{#if goal_registered}}This turn began with an event. Kind: goal_registered (a goal was registered). Arrange work from the saved agreement.{{/if}}
{{#if goal_resumed}}This turn began with an event. Kind: goal_resumed (a goal was resumed). Check the human state change and saved work. Receive the person's answer for unresolved work content or scope, and continue work whose necessary decisions are settled.{{/if}}
{{#if watch_observation}}This turn began with an event delivered by the watcher. Kind: watch_observation (a change in execution, PR, or other state was observed). Compare the observation kind with current state.{{/if}}

{{body}}
