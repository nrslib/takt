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
| Low | Simple CRUD, UI appearance |

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

### Naming

Test names describe expected behavior. Use the `should {expected behavior} when {condition}` pattern.

### Structure

- Arrange-Act-Assert pattern (equivalent to Given-When-Then)
- Avoid magic numbers and magic strings

## Test Strategy

- Prefer unit tests for logic, integration tests for boundaries
- Do not overuse E2E tests for what unit tests can cover
- If new logic only has E2E tests, propose adding unit tests

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
