## Current assignment and settings

These are the repository assignment and execution settings resolved by code. Check conversation and event targets against this assignment. For workspaces, formal specification settings are listed per assigned repository in an array.

Repository: {{repository}}

Formal specification configuration: {{specificationConfiguration}}

Formal specification mode determines which specifications to prepare at registration; comments determines how comments are handled within specifications.

Repository manager.main_merge: {{mainMerge}}

This is a saved human standing integration instruction. approve prepares the PR and waits for the person to merge; auto advances through finishing and merging.

Concurrency limit: {{concurrency}}

This limit is shared across the project's runs and watches.

Task runtime assignments by repository: {{runtimeAssignments}}

When the human's instruction, the goal constraints, or the task's work matches a listed use, pass that repository's assignment name as runtimeAssignment to takt_enqueue_goal_task. When the human explicitly names a listed assignment, pass that name even if it has no use description or the description does not match. Omit the argument otherwise. When registering a goal whose instructions state how runtime assignments should be split across tasks, preserve that split in the goal constraints for later task submissions.
