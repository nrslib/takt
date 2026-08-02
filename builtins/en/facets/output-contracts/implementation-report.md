```markdown
# Implementation Completion Evidence

## Completion Contracts
| Contract ID | Completion Obligation | Implementation Location | Counterexample and Observed Result | Evidence | Status |
|-------------|-----------------------|-------------------------|------------------------------------|----------|--------|
| `{ID}` | {implemented behavior or preservation obligation} | `{file:line, or "not implemented"}` | {rejected incorrect implementation and result, not run, or failed} | {test or execution result, incomplete reason, and next action} | Verified / Incomplete / Environment-limited |

## Impact-Path Verification (only for applicable contracts)
| Contract ID | Producers / Equivalent Branches / Auxiliary Entry Points / Consumers Checked | Migrated or Preserved | Obsolete Path Handling | Continuous Scenario |
|-------------|--------------------------------------------------------------------------------|-----------------------|------------------------|---------------------|
| `{ID}` | {searched and inspected scope} | {change or preservation rationale} | {removed, preserved, or not applicable} | {persistence and restore, re-entry, parallel interleaving, failure terminal, etc.} |

## Quality Gates
| Type | Execution | Result |
|------|-----------|--------|
| Build / Test / Static Check | `{execution}` | Pass / Fail |

## Unverified Scope
| Item | Reason | Deterministic Alternative Verification | Remaining Risk |
|------|--------|----------------------------------------|----------------|
| {unverified item, or "none"} | {incomplete implementation, failed verification, environmental limitation, etc.} | {alternative verification performed, or "none"} | {remaining risk and next action} |
```
