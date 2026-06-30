# Unit Testing Knowledge

## Test Double Selection

Choose test doubles based on purpose. Excessive mocking reduces test reliability.

| Type | Purpose | Use Case |
|------|---------|----------|
| Stub | Return fixed values | Control output of external dependencies |
| Mock | Verify invocations | Confirm method calls and arguments |
| Spy | Record calls while preserving implementation | Verify side effects |
| Fake | Lightweight implementation | In-memory DB or similar lightweight substitutes |

### Mock Granularity

- Mock only direct dependencies of the test target (not indirect dependencies)
- "Too many mocks" suggests a design problem in the test target
- Pure functions have no dependencies and need no mocking

```typescript
// NG - mocking internal implementation (testing implementation, not behavior)
vi.spyOn(service, 'privateMethod')
service.execute()
expect(service.privateMethod).toHaveBeenCalled()

// OK - mock external dependency, verify behavior
const repository = { findById: vi.fn().mockResolvedValue(user) }
const service = new UserService(repository)
const result = await service.getUser('id')
expect(result).toEqual(user)
```

## Test Double Contract Fidelity

When replacing builders, runners, adapters, providers, or similar dependencies with test doubles, match the production semantic contract, not only the TypeScript shape. A test double may simplify only responsibilities the target test does not observe.

| Aspect | Check |
|--------|-------|
| Return value | Required values, optional values, missing values, and partial-success shapes match production |
| Input propagation | Overrides, context, options, and other branch-relevant inputs can be received and verified |
| Constraints | Permissions, capabilities, tool restrictions, and limits propagate with the same meaning as production |
| Side effects | Session updates, event emission, persistence, and invalidation can be observed |
| Simplification scope | Test names and expectations do not claim behavior the test double cannot prove |

If a test double omits part of the production contract, the test should verify only behavior that does not depend on that omission. In tests for permission propagation, state transitions, or missing-value handling, omitted fields are themselves a common source of bugs.

## Boundary Value Analysis

Boundary values and equivalence partitioning are fundamental unit testing techniques.

| Technique | Description |
|-----------|-------------|
| Equivalence partitioning | Divide inputs into equivalent groups, test one from each |
| Boundary value analysis | Test at equivalence class boundaries (boundary, boundary±1) |

```typescript
// NG - happy path only
test('validates age', () => {
  expect(validateAge(25)).toBe(true)
})

// OK - includes boundary values
test('validates age at boundaries', () => {
  expect(validateAge(0)).toBe(true)    // lower bound
  expect(validateAge(-1)).toBe(false)  // lower bound - 1
  expect(validateAge(150)).toBe(true)  // upper bound
  expect(validateAge(151)).toBe(false) // upper bound + 1
})
```

## Behavior Guarantees

Unit tests should verify that the public contract behaves as expected, not only that configuration values or internal-state snapshots changed. Boundary changes such as rejection, permission, isolation, or release should cover the main success/failure cases deterministically.

| Criteria | Judgment |
|----------|----------|
| Expected return values, exceptions, or side effects are directly verified | OK |
| Both sides of a boundary change, such as success/failure or allow/deny, are verified | OK |
| Only configuration values or the last internal state are checked | REJECT |
| Main boundary conditions require an external environment to reproduce | Consider a deterministic test with a fake or stub |

## Test Fixture Design

Manage test data with factory functions.

- Generate minimal fixtures with factory functions
- Fill test-irrelevant fields with defaults
- Do not share and mutate fixtures between tests (maintain test independence)

```typescript
// NG - defining all fields every time
const user = { id: '1', name: 'test', email: 'test@example.com', role: 'admin', createdAt: new Date() }

// OK - factory function with minimal overrides
const createUser = (overrides: Partial<User> = {}): User => ({
  id: 'test-id',
  name: 'test-user',
  email: 'test@example.com',
  role: 'user',
  ...overrides,
})

test('admin can delete', () => {
  const admin = createUser({ role: 'admin' })
  // only test-relevant fields are explicit
})
```

## Test Target Isolation

Testability is an indicator of design quality. Hard-to-test code has tightly coupled dependencies.

### Dependency Injection Patterns

| Pattern | Use Case |
|---------|----------|
| Constructor injection | Class-based dependency separation |
| Function arguments | Accept dependencies as function parameters |
| Module replacement | Replace entire modules during testing |

```typescript
// NG - creates dependency directly (cannot mock in tests)
class OrderService {
  private repo = new OrderRepository()
  async create(order: Order) { return this.repo.save(order) }
}

// OK - constructor injection (mockable in tests)
class OrderService {
  constructor(private readonly repo: OrderRepository) {}
  async create(order: Order) { return this.repo.save(order) }
}
```
