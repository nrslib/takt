```markdown
# Test Creation Report

## Requirement-Test Matrix
| Requirement ID | Observable Contract | Entry / Path | Test | Result | Uncovered Reason |
|----------------|---------------------|--------------|------|--------|------------------|
| `{ID}` | {return value, persisted format, config key, CLI output, event, error classification, side effect, etc.} | {CLI / config load / config save / runtime / batch / child / event / persistence, etc.} | `{test name or test file}` | Created / Existing / Not created | {reason only when not created} |

## Risky Branch Tests
| Branch | Incorrect Implementation To Catch | Test | Uncovered Reason |
|--------|-----------------------------------|------|------------------|
| {missing, unknown, invalid value, precedence conflict, override, round-trip, partial failure, etc.} | {incorrect implementation this test should detect} | `{test name or test file}` | {reason only when not created} |

## Cross-Path Tests
| Path | Producer | Consumer | Contract Guaranteed | Test | Uncovered Reason |
|------|----------|----------|---------------------|------|------------------|
| {path from entry point to endpoint} | {where the value or state is produced} | {where the value or state is consumed} | {propagation, conversion, persistence, event emission, etc.} | `{test name or test file}` | {reason only when not created} |

## Negative Contracts
| Prohibited Behavior | Observation Method | Test | Uncovered Reason |
|---------------------|--------------------|------|------------------|
| {value that must not be emitted, format that must not be saved, data that must not be sent, etc.} | {how to observe it as behavior} | `{test name or test file}` | {reason only when not created} |

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
