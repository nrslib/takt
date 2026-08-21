Inspect the completed run directory identified in the task.

Read the available session JSONL logs under `logs/`, `trace.md`, `monitor.json`, report files, and the saved `workflow-bundle`. Inspect both the workflow definition and the facets actually referenced by each step.

Reconstruct the executed step and transition sequence. Identify where repeated misunderstanding, rejection for the same cause, ineffective correction, or redundant work created avoidable loops.

For each proposal:

1. Trace the repeated behavior through the saved execution sequence.
2. Compare that behavior with the saved workflow definition and referenced facets.
3. Identify the layer that owns the cause. Express invariants needed by multiple steps as workflow-wide rules and step-specific problems as changes to the responsible facet.
4. Record plausible proposals you considered but rejected, with the reason for rejection.

Do not edit files. Produce an evidence-based proposal set for independent evaluation.
