# E2E Testing Knowledge

## E2E Test Scope

E2E tests verify the entire user operation flow. Their scope differs from unit and integration tests.

| Test Type | Scope | Verification Target |
|-----------|-------|-------------------|
| Unit | Function/Class | Logic correctness |
| Integration | Inter-module coupling | Data flow correctness |
| E2E | Entire user operation flow | Behavior as seen by the user |

| Criteria | Judgment |
|----------|----------|
| Writing E2E tests for logic that unit tests can cover | Warning. Consider moving to unit tests |
| Verifying user operation flows | E2E test is appropriate |
| Scenarios spanning multiple commands/pages | E2E test is appropriate |
| Error message display verification | E2E test is appropriate |

## Behavior Observation

E2E tests observe behavior visible to the user. Checking configuration values, logs, or snapshots alone does not prove that rejection, permission, isolation, or recovery actually occurred.

| Criteria | Judgment |
|----------|----------|
| Results from user actions or external inputs are observed | OK |
| Rejection, error, and recovery paths verify the expected result | OK |
| Only configuration or internal state is checked, with no user-visible result | REJECT |
| Only real external-environment verification exists, with no deterministic test for the main boundary | Warning or REJECT |

## UX Route Identification

E2E test completeness depends on thorough UX route identification. Identify entry points from code, not documentation.

### Entry Point Identification

| Application Type | How to Find Entry Points |
|-----------------|-------------------------|
| CLI | Extract command definitions, subcommand registrations, option/flag definitions from code |
| Web | Extract routing definitions, page component lists from code |
| API | Extract endpoint definitions, router registrations from code |

### Branch Patterns

Exhaustively enumerate routes branching from each entry point.

| Branch Pattern | Example |
|---------------|---------|
| Option/flag combinations | `--verbose` on/off, `--format json` vs `--format table` |
| State-dependent branches | First run vs existing data, config present vs absent |
| Permission/role | Admin vs regular user, authenticated vs unauthenticated |
| External dependency state | Connection success vs timeout, normal vs error response |
| Error recovery | Retry on midway failure, rollback |
| Input variations | Valid input, invalid input, empty input, boundary values |


## Mock Boundary Design

In E2E tests, deciding "how far to run real code and where to start mocking" is critical.

### Mock Design Principles

- Run the application code under test as-is
- Insert mocks at external service boundaries
- Follow existing fixture/helper mock patterns
- Check existing mock infrastructure before introducing new mechanisms

## Flaky Test Prevention

E2E tests are prone to non-deterministic failures.

| Cause | Mitigation |
|-------|-----------|
| Timing dependency | Use explicit wait conditions (state-based waits, not fixed sleeps) |
| Port conflicts | Assign random ports per test |
| Filesystem residue | Create temp directories per test, cleanup on teardown |
| Process leaks | Set timeouts and force-kill |
| Environment dependency | Explicitly set up prerequisites for test execution |
| Execution order dependency | Initialize state so each test runs independently |

```typescript
// NG - fixed sleep for timing
await sleep(3000)
expect(result).toBeDefined()

// OK - condition-based wait
await waitFor(() => expect(result).toBeDefined(), { timeout: 5000 })
```

## Test Case Management

Manage test cases as a list to guarantee E2E test completeness.

| Principle | Description |
|-----------|-------------|
| Numbered list | Assign a unique number to each test case and track implementation status |
| Classify by entry point | Group by command/page/endpoint |
| Prioritize | Determine priority by user impact × untested risk |
| Cross-reference with existing tests | Check existing test coverage before adding new tests |
