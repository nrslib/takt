Replace the iteration-based resume namespace with `call-path:<workflow-call-path>` for both saving and restoring resume records. The workflow-call path is already available at both boundaries. Resume records are persisted between executions, and resume after the change must restore the same logical workflow-call instance. Update the implementation and behavioral tests for the new namespace. Do not change unrelated resume behavior.

The current implementation and fixtures use `iteration-<n>--step-<name>`.

Inspect the current project and produce an implementation plan.
