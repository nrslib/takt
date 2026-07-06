Write tests based on the plan before implementing production code.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.

**Important: Do NOT create or modify production code. Only test files may be created.**

**Actions:**
1. Review the plan report and understand the planned behavior and interfaces
2. Decompose the plan requirements into observable contracts
   - If the plan has no requirement IDs, assign stable IDs for this report
   - Treat return values, persisted formats, config keys, CLI output, events, logs, error classification, and side effects as contracts
3. Identify the entry points and paths for each contract
   - Check CLI, config load, config save, runtime resolution, batch processing, child execution, event creation, and persistence boundaries
   - When changing a shared helper, normalizer, builder, or adapter, include existing equivalent branches as entry points
4. Examine existing code and tests to learn the project's test patterns
5. Create a requirement-to-test matrix and record reasons for uncovered items
6. Write unit tests for the planned features
7. Determine whether integration tests are needed and create them if so
   - Does the data flow cross 3+ modules?
   - Does a new status/state merge into an existing workflow?
   - Does a new option propagate through a call chain to the endpoint?
   - Does a saved value need to round-trip through load again?
   - If any apply, create integration tests
8. Check whether the created tests would still pass with a plausible incorrect implementation

**Test writing guidelines:**
- Follow the project's existing test patterns (naming conventions, directory structure, helpers)
- Write tests in Given-When-Then structure
- One concept per test. Do not mix multiple concerns in a single test
- Cover happy path, error cases, boundary values, and edge cases
- For each requirement, leave at least one test or an explicit uncovered reason
- When an external contract exists, include tests that use the contract-defined input location
  - Example: pass request bodies using the defined root shape as-is
  - Example: keep query / path parameters in their defined location instead of moving them into the body
- Include tests that would catch implementations that incorrectly reuse a response envelope when reading requests
- When a shared helper, normalizer, builder, or adapter carries a contract, verify that existing equivalent branches preserve return values, side effects, events, and error classification
- Prioritize branches that implementations often miss: missing values, unknown values, invalid values, precedence conflicts, overrides, save/load round-trips, partial failures, and prohibited external transmission
- Do not rely only on absence assertions. Verify negative contracts through observable behavior
- When using test doubles, do not omit production contracts that the target test depends on
- Write tests that are expected to pass after implementation is complete (build errors and test failures are expected at this stage)

**Completion criteria:**
- The requirement-to-test matrix exists, and every requirement has a test or an uncovered reason
- Representative risky branches, negative contracts, and cross-module paths are recorded as tests or uncovered reasons
- Large changes include integration tests for the main entry points and paths, not only unit tests
- Changes to shared contract helpers, normalizers, builders, or adapters include tests that preserve existing equivalent branches
- Uncovered reasons do not end at "not enough time" or "not checked"

**Non-executable asset constraints:**
- Do not create tests that freeze prose, headings, or structure in explanations, guides, README files, or Markdown documentation
- For docs-only changes, do not add tests unless an explicit executable contract exists
- Tests are only needed when assets contain contracts tied to code behavior or machine processing, such as CLI examples, config examples, or generated artifacts

**Test execution:**
- Run tests after creating them to check results
- Test failures and import errors are expected before implementation (including imports of not-yet-implemented modules)
- Fix errors that will persist after implementation, such as wrong import paths for existing modules
