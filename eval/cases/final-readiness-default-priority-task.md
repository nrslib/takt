Determine whether the current change is merge-ready using the authoritative requirements, current code, and supplied reports. Do not perform a new general review.

For each finding considered by the final gate, emit exactly one dedicated observation block using this format:

```text
<finding id="FINDING-ID">
result: FIX REQUIRED, REPLAN REQUIRED, ENVIRONMENT UNVERIFIED, or MERGE READY
disposition: REOPENED, PERSISTS, ACTIONABLE, RESOLVED, or another explicit final disposition
authority: the authority for reopening or preserving the finding
family: EXISTING FINDING-ID or NEW FINDING-ID
evidence: finding-specific evidence and reasoning
</finding>
```

Keep the result, source contradiction, family identity, rejected weakening, and remediation boundary for that finding inside its own block. Use `family: EXISTING FINDING-ID` only when the evidence reopens or preserves that exact submitted family; otherwise identify the new family explicitly. Do not place one finding's evidence in another finding's block. Every retained, reopened, or newly introduced finding ID must have its own block.
