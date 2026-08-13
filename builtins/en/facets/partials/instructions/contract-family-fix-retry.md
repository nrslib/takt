**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

Reconstruct the complete graph of every accepted family that the verifier classified as `incomplete`. When the verifier recorded a failed search or proof method, invalidate it, reopen every `participates` path closed by the same assumption, and rescan and repair aliases, obsolete paths, unmigrated consumers, and one-sided updates.

The verifier's recurrence record authorizes fix-retry to apply the plan's structural enforcement without recomputing occurrence, count, or trigger. An artifact-deficient record authorizes conservative enforcement-point-oriented remediation, not a path-local-only repair.

Do not alter recurrence history while carrying it forward. Use the shared fix-plan-validity rules as the complete plan-defect and remediation-boundary decision set.
