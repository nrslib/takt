```markdown
# Implementation Completion Evidence

## Completion Contracts
| Contract ID | Origin | Completion Obligation | Implementation Location | Counterexample and Observed Result | Evidence | Status |
|-------------|--------|-----------------------|-------------------------|------------------------------------|----------|--------|
| `{ID}` | Plan / Newly discovered | {implemented behavior or preservation obligation} | `{file:line, or "not implemented"}` | {rejected incorrect implementation and result, or not run with reason} | {applicable valid, failure, and boundary scenarios; assertions and commands} | Verified / Incomplete / Environment-limited |

## Impact-Path Verification (only for applicable contracts)
| Contract ID | Producers / Equivalent Branches / Auxiliary Entry Points / Consumers Checked | Migrated / Preserved / Obsolete Paths | Applicable Invariants and Continuous Scenario |
|-------------|--------------------------------------------------------------------------------|-----------------------------------------|-----------------------------------------------|
| `{ID}` | {searched and inspected scope} | {change, preservation, and obsolete-path handling} | {only applicable state, ownership, identity, failure, re-entry, terminal-pairing, or interleaving evidence; scenario and command} |

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
