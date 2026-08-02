# Test Creation Report

## Requirement-to-Test Mapping

The rows intentionally follow execution order rather than plan order. Contract identity remains defined by `plan.md`.

| Contract ID | Origin | Observable Contract | Test Location | Counterexample Rejected |
|-------------|--------|---------------------|---------------|-------------------------|
| `CTR-03` | Plan | Whitespace-only input becomes an empty string | `tests/session-label.test.js` | Returning the original whitespace-only input |
| `CTR-02` | Plan | Surrounding whitespace is removed | `tests/session-label.test.js` | Returning the input unchanged |
| `CTR-01` | Plan | Case and internal whitespace are preserved | `tests/session-label.test.js` | Lowercasing or removing internal whitespace |
| `TEST-DISC-01` | Newly discovered during testing from existing behavior | Preserve the existing rejection of non-string input with a `TypeError` | `tests/session-label.test.js` | Coercing `null` to an empty or textual label |
