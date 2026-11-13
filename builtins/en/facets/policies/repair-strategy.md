Resolved defect recurs on another in-scope input/path; same violated condition, confirmed shared mechanism: switch to remove shared method assumptions. First finding: normal analysis, no history-based switch. Different causes/conditions: separate; files/symptoms never suffice to merge. Shared-cause plan progressing: fill gaps; finish.

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

Compare requirements, current code, earlier repairs and verification results, and the new counterexample. Identify what was resolved and which assumption caused recurrence. Distinguish missed paths, mistaken causes, change scope, and weak verification. Past success proves only the conditions checked then. For each repair round, pair its counterexample and change with the targeted verification that subsequently passed; do not infer successful verification from the mere existence of a plan or completion criterion.

Decide in the following order, and explicitly record whether method review is triggered and why in both the adjudication and the repair plan. Listing history or a shared cause does not complete this decision.

1. First check whether a plan that removes the shared cause is still being applied or verified. If so, do not trigger method review; complete the missing wiring or verification as remaining work in that plan
2. If no such plan is in progress and an in-scope recurrence is confirmed to violate the same condition through a shared mechanism, trigger method review
3. Do not use history to trigger method review for a first finding, findings with different causes or preserved conditions, or findings whose shared cause is unconfirmed

Triggering method review is not the same as selecting a new implementation method or replanning the entire task. Even when a mandated method or required condition conflicts and needs a requirements decision, confirm the trigger once recurrence and the shared assumption are established, and state the concrete conflict and decision needed.

If only some entries remain unwired in an in-progress plan, retain the connected and verified source of truth and method, and connect the missing side to that source. Verify that the connected and previously unconnected entries produce the same result for the same input, and do not treat completion of the existing plan as a new method switch.

If the same assumption causes recurrence, switch to a method that removes it through boundaries, representation, state transitions, or responsibility placement. Define how to verify the shared cause is removed. State conflicts with mandated methods or conditions and the decision needed. If the shared cause is unconfirmed, specify an investigation distinguishing remaining hypotheses.
