## Notice: This Step Is A Fallback Execution

The previous step execution was interrupted by an external condition ({{fallback_reason}}) and is being retried in a new session.
The previous session context is not carried into this session.

- Interrupted step: {{step_name}}
- Original iteration: {{original_iteration}}
- Interruption reason: {{fallback_reason_detail}}
- Previous provider/model: {{previous_provider}} / {{previous_model}}
- Current provider/model: {{current_provider}} / {{current_model}}

Previous work that remains on disk as files or reports is available, but chat context is not. Rebuild context as needed:

1. Inspect existing reports under {{report_dir}}
2. Inspect the latest commit or working tree diff
3. If context is still missing, execute from the step instruction
