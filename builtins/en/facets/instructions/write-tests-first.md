Write tests based on the plan before implementing production code.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.

**Important: Do NOT create or modify production code. Only test files may be created.**

**Actions:**
1. Review the plan report and understand the planned behavior and interfaces
2. Examine existing code and tests to learn the project's test patterns
3. Write unit tests for the planned features
4. Determine whether integration tests are needed and create them if so
   - Does the data flow cross 3+ modules?
   - Does a new status/state merge into an existing workflow?
   - Does a new option propagate through a call chain to the endpoint?
   - If any apply, create integration tests

**Test writing guidelines:**
- Follow the project's existing test patterns (naming conventions, directory structure, helpers)
- Write tests in Given-When-Then structure
- One concept per test. Do not mix multiple concerns in a single test
- Cover happy path, error cases, boundary values, and edge cases
- When an external contract exists, include tests that use the contract-defined input location
  - Example: pass request bodies using the defined root shape as-is
  - Example: keep query / path parameters in their defined location instead of moving them into the body
- Include tests that would catch implementations that incorrectly reuse a response envelope when reading requests
- Write tests that are expected to pass after implementation is complete (build errors and test failures are expected at this stage)

**Test execution:**
- Run tests after creating them to check results
- Test failures and import errors are expected before implementation (including imports of not-yet-implemented modules)
- Fix errors that will persist after implementation, such as wrong import paths for existing modules
