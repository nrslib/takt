Focus on reviewing **test quality**.

## Step-Specific Additional Procedure

1. Cross-reference the test plan / test scope reports in the Report Directory with the implemented tests
2. For an HTTP or API contract, verify each input location declared by that contract, such as root body, query, or path. Report an uncovered location only when it creates a concrete observable failure path
3. For changes involving side effects or state transitions, check whether representative failure paths are tested, not just the happy path
4. For changes that standardize a contract through consolidation or abstraction, check that contract tests cover existing equivalent branches as well as the new shared path
5. For changes to config values, runtime-selected capabilities, backends, options, or permissions, verify only the branch conditions declared by the contract or applicable to the change, such as unset, set, override, inherited, and non-inherited, and report a gap only with a concrete observable failure path
6. For changes where a non-execution entry displays, validates, or explains the same value, verify that tests check displayed values against the resolution input used during execution
7. Do not treat mock-substituted verification as proof that the real integration was verified
8. For prohibition, rejection, non-inheritance, unsupported targets, and isolation, verify that tests extract observable units and check each forbidden value instead of relying on exact-string absence alone
9. For new configuration boundaries, check normalization inputs such as empty strings, whitespace-only strings, empty arrays, and case variants when relevant
10. Verify that E2E timeout, cleanup, and forced-termination handling follows existing same-kind test conventions
11. When forming findings from uncovered conditions, preserve the applicable authority policy's decisions and do not aggregate conditions that the policy requires to remain separate

Report a test-addition concern only when you can identify an acceptance criterion or observable contract that this change can break and a concrete failure path that existing tests cannot detect. Do not request duplicate tests; assertions that freeze workflow names, full natural-language text, raw YAML structure, helpers, or internal implementation details; assertions already covered by loader, gate, or higher-level behavior tests; permanent migration-inventory assertions; or assertions without concrete regression-detection value. Do not report test reduction or consolidation as a separate problem unless it is causally required by this change.
