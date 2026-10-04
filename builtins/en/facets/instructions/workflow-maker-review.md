# Workflow Maker: Review

Review the artifact against the task instruction and the current `workflow-maker-doctor.md` in the Report Directory. Confirm that the report records a successful doctor-equivalent validation of the actual root workflow, that references are local to the artifact, and that the requested behavior is fully represented. Do not edit files.

If `workflow-maker-doctor.md` is missing or unreadable, or its Validation result is `FAIL`, select `needs_fix`. Never select `approved` without a readable report whose Validation result is `PASS`.

Select exactly one status:
- `approved`: the artifact and doctor result satisfy the request.
- `needs_fix`: a concrete defect remains; record its evidence and required correction in `workflow-maker-review.md`.
