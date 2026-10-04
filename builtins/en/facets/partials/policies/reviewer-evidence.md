## Verification Method

Reviewers assess the change by reading code, specifications, types, schemas, tests, callers, configuration, supplied reports, logs, and recorded execution results.

- Do not newly run builds, type checks, lint, unit tests, integration tests, E2E, or quality gates. This prohibition also covers invoking the same work through an alias script or a direct runner
- Do not start the target implementation to produce a new pass/fail or reproduction result. Reading test code and existing execution paths remains in scope
- Use build, lint, test, and runtime outcomes only to the extent that supplied reports, logs, or recorded evidence actually state them
- When re-checking evidence immediately before judgment, re-read the target code and recorded evidence. Do not re-run the commands that produced that evidence
- If required evidence is absent, stale, or does not directly observe the relevant condition, record that scope as unverified. Do not make missing evidence alone a finding or a reason to REJECT
- If a behavioral problem cannot be established from the current code and supplied evidence, record it as unverified instead of creating a speculative finding
