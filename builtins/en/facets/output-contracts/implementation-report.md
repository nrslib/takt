```markdown
# Implementation Completion Evidence

## Completion Contracts
| Contract ID | Origin | Upstream Completion Obligation | Implementation Result | Implementation Location | Counterexample and Observed Result | Evidence | Status |
|-------------|--------|-------------------------------|-----------------------|-------------------------|------------------------------------|----------|--------|
| `{ID}` | Plan / Newly discovered (discovery stage) | {meaning of the same ID in the upstream contract ledger} | {implemented behavior or preservation obligation} | `{file:line, or "not implemented"}` | {rejected incorrect implementation and concrete observed value, effect, record, field, argument, or event; do not infer rejection from string absence alone; or not run with reason} | Valid: {result}; Failure: {result or N/A with basis}; Boundary: {result or N/A with basis}; Assertion: {observation}; Command: `{execution}` | Verified / Incomplete / Environment-limited |

## Impact-Path Verification (only for applicable contracts)
| Contract ID | Producers / Equivalent Branches / Auxiliary Entry Points / Consumers Checked | Migrated / Preserved / Obsolete Paths | Applicable Invariants and Continuous Scenario |
|-------------|--------------------------------------------------------------------------------|-----------------------------------------|-----------------------------------------------|
| `{ID}` | {searched and inspected scope} | {change, preservation, and obsolete-path handling} | {separate named evidence for each applicable axis among State, Ownership, Identity, Authorization/Allow-Deny, Failure/Re-entry/Terminal, Retry/Re-execution, and Concurrency/Interleaving; then Scenario and Command; omit non-applicable axes} |

## Quality Gates
| Type | Execution | Result |
|------|-----------|--------|
| Build / Test / Static Check | `{execution}` | Pass / Fail |

## Unverified Scope
| Item | Reason | Deterministic Alternative Verification | Remaining Risk |
|------|--------|----------------------------------------|----------------|
| {unverified item, or "none"} | {incomplete implementation, failed verification, environmental limitation, etc.} | {alternative verification performed, or "none"} | {remaining risk and next action} |

`Verified` is allowed only when all applicable contract and impact-path evidence succeeded. Record every failed or unexecuted item under Unverified Scope with its reason, deterministic alternative verification, and remaining risk.
```
