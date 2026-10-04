# Issue #1155 snapshot

Source: https://github.com/nrslib/takt/issues/1155

Separate the report write namespace from the report read scope for nested `workflow_call` execution. A nested child must be able to refer declaratively to a report produced by its direct parent, while writes remain isolated per call and parallel branch.

The design may use a deterministic current-parent-ancestor-root lookup order, explicit report-input mapping on `workflow_call`, or an equivalent mechanism. If lookup is used, specify shadowing. If mapping is used, doctor and runtime must share its resolver and validation rules.

The result must be deterministic when the same report name exists in multiple scopes, doctor and runtime must use the same resolution contract, report snapshots must remain usable after resume/requeue, and existing containment, reserved-name, and symlink-rejection boundaries must remain intact. Cover parent/child, grandchild, parallel same-name reports, and resume/requeue in integration tests.

Inspect the current repository and produce an implementation plan.
