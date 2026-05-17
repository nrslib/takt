# Testing Policy

Every behavior change requires a corresponding test, and every bug fix requires a regression test.

## Principles

| Principle | Criteria |
|-----------|----------|
| Given-When-Then | Structure tests in 3 phases |
| One test, one concept | Do not mix multiple concerns in a single test |
| Test behavior | Test behavior, not implementation details |
| Independence | Do not depend on other tests or execution order |
| Type safety | Code must pass the build (type check) |
| Reproducibility | Do not depend on time or randomness. Same result every run |
| Do not freeze non-executable assets | Do not make prose or section structure that does not define runtime behavior a CI failure condition |

## Coverage Criteria

| Target | Criteria |
|--------|----------|
| New behavior | Test required. REJECT if missing |
| Bug fix | Regression test required. REJECT if missing |
| Behavior change | Test update required. REJECT if missing |
| Build (type check) | Build must succeed. REJECT if it fails |
| Edge cases / boundary values | Test recommended (Warning) |

## Test Priority

| Priority | Target |
|----------|--------|
| High | Business logic, state transitions |
| Medium | Edge cases, error handling |
| Low | Simple CRUD |

**Note:** When a design reference is provided, UI appearance verification is elevated to medium priority. Refer to the Design Fidelity Policy.

## Non-Executable Asset Tests

Tests that freeze prose, headings, or structure in non-executable assets such as explanations, guides, README files, or Markdown documentation are prohibited by default.
These assets change often during wording improvements and reorganization, so making prose diffs fail CI creates high maintenance cost.

| Criteria | Verdict |
|----------|---------|
| Exact prose, heading, or section-structure assertions for non-executable assets | REJECT |
| Scanning all non-executable assets only to enforce wording or terminology | REJECT |
| Tests that require explanatory files that may be deleted or consolidated | REJECT |
| Adding tests for docs-only changes when no executable contract exists | REJECT |
| Validating executable or machine-processed contracts such as CLI examples, config examples, or generated artifacts | OK |
| Contract tests for schemas, configuration, code, generators, or runtime behavior | OK |
| Not adding tests for docs-only changes that have no executable contract | OK |

Verify non-executable asset changes with review, Markdown lint, link checks, or sample command execution when needed.

## Test Structure: Given-When-Then

```typescript
test('should return NotFound error when user does not exist', async () => {
  // Given: A non-existent user ID
  const nonExistentId = 'non-existent-id'

  // When: Attempt to fetch the user
  const result = await getUser(nonExistentId)

  // Then: NotFound error is returned
  expect(result.error).toBe('NOT_FOUND')
})
```

## Test Quality

| Aspect | Good | Bad |
|--------|------|-----|
| Independence | No dependency on other tests | Depends on execution order |
| Reproducibility | Same result every time | Depends on time or randomness |
| Clarity | Failure cause is obvious | Failure cause is unclear |
| Focus | One test, one concept | Multiple concerns mixed |

## Test Data and Fixtures

Test data should explicitly generate the minimum facts needed by each test. Mutating shared fixtures or using mocks that drift from real contracts reduces test reliability.

| Criteria | Verdict |
|----------|---------|
| Shared fixtures are mutated and reused across tests | REJECT |
| Mocks, fixtures, or factories return shapes that differ from real types or API contracts | REJECT |
| Each test hand-writes a huge full-field fixture | Warning. Consider a factory |
| Factories provide defaults and each test overrides only relevant fields | OK |
| Contract changes update fixtures, mocks, and snapshots in the same change | OK |

### Naming

Test names describe expected behavior. Use the `should {expected behavior} when {condition}` pattern.

### Structure

- Arrange-Act-Assert pattern (equivalent to Given-When-Then)
- Avoid magic numbers and magic strings

## Refetch loop regressions

When a page performs initial loading, tests must prove that the load does not rerun because of unrelated re-renders, loading toggles, or Context callback identity changes.

| Criteria | Verdict |
|----------|---------|
| Initial load bug fix has no regression test for duplicate API calls | REJECT |
| Tests only verify that loading happened once, not that it stayed stable after rerender | Warning |
| Page tests assert call count stability across rerender or state updates | OK |

## Reachability regressions

When adding or changing user-facing features or screens, tests or equivalent verification must prove that users can still reach the feature.

| Criteria | Verdict |
|----------|---------|
| A new screen or feature is added with no verification of entry path or launch conditions | REJECT |
| Only isolated component rendering is tested, without verifying reachability from an entry point | Warning |
| The feature is verified reachable from an actual entry point such as a route, menu, button, link, or external caller | OK |

## UI library integration regressions

When introducing or changing major third-party UI components such as data grids, date pickers, virtualized lists, or charts, tests must prove that the real component mounts without crashing.

| Criteria | Verdict |
|----------|---------|
| A major third-party UI component is added or changed without a regression test that mounts the real component | REJECT |
| Prop compatibility is checked only through shallow mocks or existence checks | Warning |
| The screen is rendered from its real entry path and the primary UI mounts without exceptions | OK |
| The primary UI component is also rendered directly with representative props | OK |

## Test Strategy

- Prefer unit tests for logic, integration tests for boundaries
- Do not overuse E2E tests for what unit tests can cover
- If new logic only has E2E tests, propose adding unit tests

### When Integration Tests Are Required

Verify data flow coupling that unit tests alone cannot cover.

| Condition | Verdict |
|-----------|---------|
| Data flow crossing 3+ modules | Integration test required |
| New status/state merging into an existing workflow | Integration test for the full transition flow required |
| New option propagating through a call chain to the endpoint | End-to-end chain coupling test required |
| All module-level unit tests pass | Unit tests alone are sufficient (when none of the above apply) |

## Unit Test Criteria

| Criteria | Verdict |
|----------|---------|
| Mocking the internal implementation of the test target (testing implementation, not behavior) | REJECT |
| Sharing and mutating fixtures between tests | REJECT. Loss of test independence |
| Mock return values diverging from actual types | Warning. Use type-safe mocks |
| Only testing happy paths without boundary values | Warning |

## E2E Test Criteria

Design E2E tests from the entry points users actually use. Use code-level entry points such as routes, commands, endpoints, navigation, buttons, or external callbacks, not documentation assumptions alone.

| Criteria | Verdict |
|----------|---------|
| E2E tests are written for imagined flows without checking real entry points | REJECT |
| Hitting production APIs without mocking external calls | REJECT. Test reproducibility is lost |
| Mocking the core logic under test | REJECT. Defeats the purpose of E2E |
| Using fixed sleep for timing synchronization | REJECT. Use state-based waits |
| Sharing state between tests | Warning. Test independence is compromised |
| Only testing happy paths without error flows | Warning |
| Writing E2E tests for logic that unit tests can cover | Warning |

## Test Environment Isolation

Tie test infrastructure configuration to test scenario parameters. Hardcoded assumptions break under different scenarios.

| Principle | Criteria |
|-----------|----------|
| Parameter-driven | Generate fixtures and configuration based on test input parameters |
| No implicit assumptions | Do not depend on a specific environment (e.g., user's personal settings) |
| Consistency | Related values within test configuration must not contradict each other |

```typescript
// ❌ Hardcoded assumptions — breaks when testing with a different backend
writeConfig({ backend: 'postgres', connectionPool: 10 })

// ✅ Parameter-driven
const backend = process.env.TEST_BACKEND ?? 'postgres'
writeConfig({ backend, connectionPool: backend === 'sqlite' ? 1 : 10 })
```
