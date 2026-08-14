**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

Reconstruct the complete graph of every accepted family that the fix verifier classified as `incomplete`. When the fix verifier recorded a failed search or proof method, invalidate it, reopen every affected path closed by the same assumption, and rescan and repair aliases, obsolete paths, unmigrated consumers, and one-sided updates.

The recurrence record in fix-verification.md authorizes fix-retry to apply the plan's structural enforcement without recomputing verification numbers, cumulative count, or whether recurrence on a different path is confirmed. When the record says `confirmed`, or says `cannot determine` because an artifact is deficient, apply conservative enforcement-point-oriented remediation rather than a path-local-only repair.

Do not alter recurrence history while carrying it forward. Do not treat missing implementation, execution evidence, or carry-forward artifacts as a plan defect. Classify a plan defect or revise its remediation boundary only when a plan change can resolve missing or inconsistent required fields, assumptions, boundary, methods, or evidentiary power.
