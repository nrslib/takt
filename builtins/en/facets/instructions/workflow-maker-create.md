# Workflow Maker: Create

Implement the complete workflow request in the current artifact directory. The task instruction is authoritative. Keep all generated files inside the existing `workflows/`, `steps/`, `facet-pools/`, and `facets/` directories, and do not modify the source workflow outside this directory.

Before reporting completion, perform the same configuration loading and validation checks used by TAKT doctor for the artifact's root workflow. Inspect every reported error, correct the artifact, and record the concrete validation result in `workflow-maker-doctor.md`. This validation and report are part of this step; do not delegate them to another workflow step.

Select exactly one status:
- `completed`: the requested artifact is implemented and the doctor-equivalent validation succeeds.
