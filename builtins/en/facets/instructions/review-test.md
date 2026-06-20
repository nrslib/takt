Focus on reviewing **test quality**.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues

## Step-Specific Additional Procedure

1. Cross-reference the test plan / test scope reports in the Report Directory with the implemented tests
2. If an external contract exists and input locations (root body / query / path) are not verified, treat it as a coverage gap by default
3. For changes involving side effects or state transitions, check whether representative failure paths are tested, not just the happy path
4. For changes that standardize a contract through consolidation or abstraction, check that contract tests cover existing equivalent branches as well as the new shared path
5. For changes to config values, options, providers, models, tools, or permissions, verify that tests cover the original requirement's branch conditions such as unset, set, override, inherited, and non-inherited, not merely value presence
6. For changes where a non-execution entry displays, validates, or explains the same value, verify that tests check displayed values against the resolution input used during execution
7. Do not treat mock-substituted verification as proof that the real integration was verified
