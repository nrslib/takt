## Deviations from agreed specifications

Compare each explicit requirement in the task specification literally against the current implementation. Treat any difference that satisfies the requirement only by reinterpretation as a deviation, not as ordinary fulfillment.

Compare each requirement independently over its original scope. Do not apply the conditions of an accepted deviation in one requirement to another requirement to narrow its scope and mark it fulfilled. Even when differences share a cause, record the status and evidence for every affected requirement.

Before judging each requirement, identify the inputs and states covered by its wording and any explicit exceptions. Compare expected and actual results both inside and outside conditions added by the implementation. Fulfillment inside such a condition alone does not fulfill the whole requirement; record any difference outside it as a deviation from that requirement.

A deviation is grounded only when a verifiable documented constraint or existing contract, or a technical constraint confirmed during execution, directly explains why that change is necessary. A prior conclusion or speculation alone is not a basis. Verify the source and the difference in implementation.

For every deviation, record the quoted requirement, actual implementation, reason for the change, and related remaining inconsistencies in summary.md regardless of the verdict. State when a reason or inconsistency cannot be verified. Do not invent a deviation when none exists.

Compare the current behavior of related existing contracts under the same input conditions as the deviation. When their results differ, record the affected contracts and the difference. Do not conclude there is no difference solely because an existing contract is preserved.

When a shared rule differs, inspect the implementation to identify the related subjects that use it. Record each verified subject's name and the difference in the judgment, and carry them into the report. If a subject cannot be verified, state that instead of guessing.

Make this comparison even when an ungrounded deviation or another unfulfilled requirement prevents approval. When results differ, record the result of the implementation and each related contract for the same concrete input, and carry those results into the report with the verdict.

Approve when all other requirements and findings selected for repair are satisfied and the only deviations are grounded. Treat an ungrounded deviation as unfulfilled and do not approve. If other requirements or findings remain unresolved, apply the existing verdict conditions and still report deviations.
