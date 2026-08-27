# Workflow Maker: Fix

Read `workflow-maker-review.md` from the Report Directory and correct every reported defect in the current artifact directory. Do not modify any source workflow outside this directory.

After the corrections, repeat the same configuration loading and validation checks used by TAKT doctor for the artifact's root workflow. Update `workflow-maker-doctor.md` with the concrete result. This validation and report are part of this step; do not delegate them to another workflow step.

Select exactly one status:
- `completed`: all review findings are fixed and the doctor-equivalent validation succeeds.
