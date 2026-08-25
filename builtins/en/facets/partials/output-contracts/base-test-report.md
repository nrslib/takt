```markdown
# Test Creation Report

## Completion Contract-Test Matrix
| Contract ID | Origin | Observable Contract | Entry / Path | Test | Result | Uncovered Reason |
|-------------|--------|---------------------|--------------|------|--------|------------------|
| `{ID}` | Plan / Newly discovered | {return value, persisted format, config key, CLI output, event, error classification, side effect, etc.} | {CLI / config load / config save / runtime / batch / child / event / persistence, etc.} | `{test name or test file}` | Created / Existing / Not created | {reason only when not created} |

## Verification Boundaries (only for contracts with external or environment-dependent boundaries)
| Contract ID | Mock-Verified Scope | Real-Integration Scope | Test Environment / HOME / Configuration Isolation | Unverified Reason |
|-------------|---------------------|------------------------|---------------------------------------------------|-------------------|
| `{ID}` | {behavior proved by test doubles} | {real integration verified or remaining scope} | {isolation used} | {reason only when scope remains unverified} |

## Risky Branch and Discrimination Tests
| Contract ID | Branch | Incorrect Implementation To Catch | Rejecting Input / State and Assertion | Test | Uncovered Reason |
|-------------|--------|-----------------------------------|---------------------------------------|------|------------------|
| `{ID}` | {missing, unknown, invalid value, precedence conflict, override, round-trip, partial failure, etc.} | {incorrect implementation this test should detect} | {input or state and the assertion that rejects the incorrect implementation} | `{test name or test file}` | {reason only when not created or not demonstrated} |

## Impact-Path Tests (only for applicable contracts)
| Contract ID | Path | Producer | Consumer | Contract Guaranteed | Test | Uncovered Reason |
|-------------|------|----------|----------|---------------------|------|------------------|
| `{ID}` | {path from entry point to endpoint} | {where the value or state is produced} | {where the value or state is consumed} | {propagation, conversion, persistence, event emission, etc.} | `{test name or test file}` | {reason only when not created} |

## Continuous Execution, Ownership, and Concurrency (when applicable)
This section applies when the requirement asks behavior to follow the state at that time after an event and the same entity persists before and after the event.

| Contract ID | Execution Sequence or Interleaving | Real Upper-Level Entry Point | Invariant Observed | Test | Uncovered Reason |
|-------------|------------------------------------|------------------------------|--------------------|------|------------------|
| `{ID}` | {create->persist->restore->continue->re-enter, failure terminal, parallel interleaving, etc.} | {production-equivalent entry point} | {ownership, identity, terminal pairing, etc.} | `{test name or test file}` | {reason only when not created} |

## Negative Contracts
| Contract ID | Prohibited Behavior | Observation Method | Test | Uncovered Reason |
|-------------|---------------------|--------------------|------|------------------|
| `{ID}` | {value that must not be emitted, format that must not be saved, data that must not be sent, etc.} | {how to observe it as behavior} | `{test name or test file}` | {reason only when not created} |

## Created Tests
| File | Type | Count | Summary |
|------|------|-------|---------|
| `{test file path}` | Unit / Integration | {N} | {what is tested} |

## Uncovered Items
| Requirement / Branch | Uncovered Reason | Required Follow-up |
|----------------------|------------------|--------------------|
| {uncovered requirement or branch} | {why it was not tested} | {implementation, review, or manual verification needed later} |

## Execution Results (Reference)
Test failures and import errors are expected before implementation.

| Status | Count | Notes |
|--------|-------|-------|
| Pass | {N} | |
| Fail / Import Error (expected) | {N} | Due to unimplemented modules |
| Error (needs fix) | {N} | Wrong paths for existing modules, etc. |

## Notes (only if decisions were made)
- {Test design decisions or notes}
```
