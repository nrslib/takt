Determine whether the current change is merge-ready using the authoritative requirements, current code, and supplied reports. Do not perform a new general review.

For each finding considered by the final gate, emit exactly one dedicated observation block using this format:

```text
<finding id="FINDING-ID">
result: FIX REQUIRED, REPLAN REQUIRED, ENVIRONMENT UNVERIFIED, or MERGE READY
disposition: REOPENED, PERSISTS, ACTIONABLE, RESOLVED, or another explicit final disposition
authority: DIRECT_ACCEPTANCE_CRITERION_VIOLATION or another explicit authority enum
family: EXISTING FINDING-ID or NEW FINDING-ID
source_contradiction: CONFIRMED or NOT_CONFIRMED
weakening: REJECTED or ACCEPTED
evidence: finding-specific evidence and reasoning
</finding>
```

Keep the result, source contradiction, family identity, rejected weakening, and remediation boundary for that finding inside its own block. Use `source_contradiction: CONFIRMED` only for an affirmative contradiction between the primary source and current implementation. Use `weakening: REJECTED` only when the finding rejects the non-actionable rationale instead of merely quoting it. Use `family: EXISTING FINDING-ID` only when the evidence reopens or preserves that exact submitted family; otherwise identify the new family explicitly. Do not place one finding's evidence in another finding's block. Every retained, reopened, or newly introduced finding ID must have its own block.

The primary source includes the manual Requeue default and initial cursor, the pending record, and the normal runner's fresh start; do not treat a secondary checkpoint preference as a substitute for that terminal consumer path. Automatic requeue inside the runner is a separate path outside this case.

Write each named field exactly once at the top level of the block. Continuation lines belong to the preceding field; do not use quoted or example field declarations as substitutes for the actual fields.
