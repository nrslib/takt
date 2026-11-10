<!-- policy-priority -->
Resolved defect recurs on another in-scope input/path; same violated condition, confirmed shared mechanism: switch to remove shared method assumptions. First finding: normal analysis, no history-based switch. Different causes/conditions: separate; files/symptoms never suffice to merge. Shared-cause plan progressing: fill gaps; finish.
<!-- /policy-priority -->

# Repair Strategy

Prevent recurrence using repair history.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Recurrence evidence | Link the resolved problem and counterexample through the same violated condition and mechanism |
| Requirements and methods | Separate required conditions from assumptions introduced by the earlier implementation |
| Address the cause | Choose a method that removes the shared assumption causing recurrence |
| Preserve contracts | Retain mandatory conditions, real affected paths, and success and failure outcomes |
| Evidence-based choice | Choose changes or retention from code and repair evidence |

## Recurrence

Compare requirements, current code, earlier repairs and verification results, and the new counterexample. Identify what was resolved and which assumption caused recurrence. Distinguish missed paths, mistaken causes, change scope, and weak verification. Past success proves only the conditions checked then.

If the same assumption causes recurrence, switch to a method that removes it through boundaries, representation, state transitions, or responsibility placement. Define how to verify the shared cause is removed. State conflicts with mandated methods or conditions and the decision needed. If the shared cause is unconfirmed, specify an investigation distinguishing remaining hypotheses.
