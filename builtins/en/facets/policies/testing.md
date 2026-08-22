# Testing Policy

Subject to the four-part evidence gate below, an observable behavior change requires the minimum test needed to prevent regressions that existing tests cannot detect, and a bug fix requires an existing or new regression test that would detect the pre-fix failure.

## Principles

| Principle | Criteria |
|-----------|----------|
| Given-When-Then | Structure tests in 3 phases |
| One test, one concept | Do not mix multiple concerns in a single test |
| Test behavior | Test behavior, not implementation details |
| Do not turn internals into contracts | Do not use line counts, source wording, imports, helper names, file layout, runtime freezing, or reference identity as proxies for observable contracts |
| Independence | Do not depend on other tests or execution order |
| Type safety | Code must pass the build (type check) |
| Reproducibility | Do not depend on time or randomness. Same result every run |
| Do not freeze non-executable assets | Do not make prose or section structure that does not define runtime behavior a CI failure condition |
| Do not duplicate shipped definitions | Do not copy concrete definitions from bundled declarative assets into test expectations |
| Verify negative contracts at observable units | Do not pass prohibition, rejection, non-inheritance, or unsupported cases by exact-string absence alone |
| Mock contract fidelity | Keep external SDK/API mocks aligned with real contracts and do not freeze wrong assumptions in tests |

Delete existing tests that pin only internal structure instead of replacing them with another internal-structure assertion. Limit this check to existing tests that import, invoke, or directly reference the changed contract owner; do not exclude them by filename or claimed purpose, and do not expand the check into repository-wide cleanup of unrelated tests. Add a replacement only when a real external contract or regression risk exists, and verify the observable behavior. Exact strings remain appropriate when the string itself is a public contract such as CLI output, a protocol value, or a published error code.

A test may be required only when all of the following can be shown: an acceptance criterion or observable contract that serves as the source of truth, a concrete failure reachable through a real path, evidence that existing tests cannot detect that failure, and the smallest layer that owns its verification. Do not require a test when any of these is absent. Module count, call-chain length, internal branch count, and file layout are not test-addition grounds. When an existing unit, integration, or E2E test detects the same failure, do not duplicate it at another layer or per consumer.

## Coverage Criteria

| Target | Criteria |
|--------|----------|
| New observable behavior | A test at the smallest contract-owning layer is required only when existing tests cannot detect the regression |
| Bug fix | An existing or new regression test must detect the pre-fix failure. No additional test is needed when an existing test already does so |
| Observable behavior change | Update tests when they assert only the old contract. No addition or update is needed when existing tests already detect the new contract |
| Side-effect or state-transition change | REJECT only when contract-relevant successful and representative failure paths are untested at every layer |
| Contract changes through consolidation or abstraction | When existing evidence cannot detect regressions in equivalent branches, verify representative behavior at the contract owner |
| Parser or configuration boundary changes | Verify only input classes relevant to the changed contract and not detected by existing tests |
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

Tests that freeze prose, headings, or structure in non-executable assets such as explanations, guides, README files, or Markdown documentation are prohibited by default. These assets change often during wording improvements and reorganization, so making prose diffs fail CI creates high maintenance cost.

| Criteria | Verdict |
|----------|---------|
| Exact prose, heading, or section-structure assertions for non-executable assets | REJECT |
| Scanning all non-executable assets only to enforce wording or terminology | REJECT |
| Tests that require explanatory files that may be deleted or consolidated | REJECT |
| Adding tests for docs-only changes when no executable contract exists | REJECT |
| Validating executable or machine-processed contracts such as CLI examples, config examples, or generated artifacts | OK |
| Contract tests for schemas, configuration, code, generators, or runtime behavior | OK |
| Not adding tests for docs-only changes that have no executable contract | OK |

## Natural-Language and Declarative Asset Tests

Prompts, instructions, natural-language conditions, and declarative definitions such as workflows are runtime inputs. Do not treat pinned natural-language strings or duplicated shipped definitions as behavioral regression tests; choose the appropriate verification layer for each target.

| Criteria | Verdict |
|----------|---------|
| Claiming that a prompt performs the intended classification or judgment based only on `toContain` or full-string equality | REJECT |
| Pinning a condition description by exact equality so wording-only changes fail | REJECT |
| Verifying parser or loader structure contracts with a dedicated minimal fixture | OK |
| Loading every shipped declarative asset and checking schema conformance in a smoke test | OK |
| Copying step names, rules, transition targets, or configuration values from an individual shipped asset into expectations that detect definition diffs only | REJECT |
| Verifying state transitions or side effects through execution of a representative minimal scenario | OK |
| Extracting semantic decisions into deterministic code and testing inputs and results at boundaries | OK |
| Evaluating model judgment with scenarios while keeping it separate from deterministic tests | OK |
| Using exact equality when the string itself is an externally published contract, such as CLI output, protocol values, or error codes | OK |

## Tests for Replaced Old Specifications

When a specification change replaces elements of an old design (UI, API, events, state, labels, etc.) with a new design, tests must positively verify the new behavior. Do not freeze only the absence of the old specification.

| Criteria | Verdict |
|----------|---------|
| Adding a test that only verifies elements of the old specification are not present or not called | REJECT |
| Keeping an absence-only test from the old specification in an implementation unit that no longer owns the responsibility | REJECT |
| Changing only tests in a file whose production code has no final diff, solely to negate the old specification | REJECT |
| Positively verifying the new specification in the layer that owns the new responsibility (upper module, service, integration flow, etc.) | OK |
| Deleting obsolete tests for removed old behavior and replacing them with regression tests for the new specification | OK |

## Test Quality

| Aspect | Good | Bad |
|--------|------|-----|
| Independence | No dependency on other tests | Depends on execution order |
| Reproducibility | Same result every time | Depends on time or randomness |
| Clarity | Failure cause is obvious | Failure cause is unclear |
| Focus | One test, one concept | Multiple concerns mixed |
| UI element identification | Identify targets by user-observable contracts such as role plus exact accessible name | Broad partial matches, first match, or display position used to identify the target |
| Collision cases | Verify targets remain distinguishable even with valid data sharing the same display string | Deliberately making all fixture display values unique, hiding the possibility of collisions |

## Assertion Contracts

Map every assertion to an invariant explicitly stated by the source of truth, an invariant indispensably and directly derived from that source with its origin and rationale recorded, or an observable existing contract outside the requested change scope. Do not add an assertion without such a mapping.

| Criteria | Verdict |
|----------|---------|
| The source specifies value equivalence, but the test also fixes reference identity or copying behavior | REJECT |
| The source specifies rejection, but the test also fixes an error type or wording that the source does not define | REJECT |
| Defensive implementation is used to invent an input class, behavior, error kind, wording, or internal representation as a new test contract | REJECT |
| Every assertion traces to an explicit or indispensable invariant or a preserved observable contract | OK |

## Testing Side Effects and State Transitions

Changes involving side effects or state transitions are not sufficiently verified by successful-path coverage alone.

| Criteria | Verdict |
|----------|---------|
| Only the successful path is tested, with no verification of state after failure, interruption, or early exit | REJECT |
| Cleanup or duplicate execution for acquired, started, registered, or applied state is not verified | REJECT |
| A change affects shared state or downstream execution but does not verify rerun behavior after partial failure | Warning. REJECT when it affects a primary path |
| Mock-verified behavior is not distinguished from unverified real-integration scope | Warning. REJECT when it is a primary requirement |
| Successful path, representative failure paths, and boundary state transitions are each verified | OK |

## Testing Contract Changes and Existing Branches

When a change standardizes a contract through a shared helper, normalizer, builder, or adapter, confirm that existing equivalent branches remain protected. Do not duplicate tests per consumer; use the contract owner's unit test, a representative parameterized test, or an existing higher-level behavior test, whichever detects the same fault at the smallest scope.

| Criteria | Verdict |
|----------|---------|
| A concrete regression path exists in an equivalent branch and no existing test detects it | REJECT |
| Tests are requested only because of module count, consumer count, or the number of return / throw / catch / early return paths | REJECT |
| The same fault-detecting assertion is duplicated per consumer or across multiple layers | REJECT |
| A contract-owner test or existing higher-level behavior test detects representative failures across equivalent branches | OK |

## Contract Test Sufficiency

When adding or changing a config value, runtime-selected capability, backend, option, permission, or output contract, tests must prove the branch conditions that change the contract, not merely that a value exists.

| Criteria | Verdict |
|----------|---------|
| Only the happy path for a new option is verified | Warning |
| Requirement-relevant branches among unset, set, invalid value, inherited, non-inherited, override, and unsupported target are not verified | REJECT |
| A user-facing display or validation entry is not verified to follow the same contract as the primary execution path | REJECT |
| A test only checks displayed values without verifying they match the resolution input used during execution | REJECT |
| Absence is verified only by exact string matching, missing order, case, whitespace, or partial-leak differences | REJECT |
| Boundary values that may be normalized at configuration boundaries, such as empty strings, whitespace-only strings, empty arrays, or case variants, are not tested | Warning. REJECT when this is a primary contract branch |
| The observable boundary owned by the contract verifies requirement-relevant happy, rejection, and non-inheritance cases | OK. Repeating them at every hop is unnecessary |

## Testing Negative, Non-Inheritance, and Rejection Contracts

Tests for prohibition, rejection, non-inheritance, unsupported targets, and isolation must not rely only on a specific string being absent from the whole output.
Extract observable units such as output lines, records, fields, or call arguments, then verify each forbidden value cannot leak through order, case, whitespace, delimiter, or partial-match differences.

| Criteria | Verdict |
|----------|---------|
| Exact-string absence alone is used to conclude that a forbidden or non-inherited value was not used | REJECT |
| Only allowed-value presence is checked, without proving rejected, forbidden, or non-inherited values do not reach final processing | REJECT |
| Observable units such as output lines, events, records, fields, or call arguments are extracted and checked per forbidden value | OK |
| Allowed vs rejected and inherited vs non-inherited cases are tested as pairs | OK |
| A new E2E test does not follow existing same-kind conventions for timeout, cleanup, and forced termination | Warning. REJECT when it can cause process leaks or flakes |

## Parser and Configuration Boundary Tests

At boundaries that read external files, configuration, YAML/JSON, or CLI input, verify the input classes relevant to the changed contract. Do not apply a generic invalid-input checklist mechanically to every parser.

| Criteria | Verdict |
|----------|---------|
| The changed input contract includes object/null/missing handling and has a concrete undetected failure | A test for the relevant representative input is required |
| Object/null/missing combinations are requested solely because a parser changed | REJECT |
| Regular-file, broken-link, and permission-error cases are required uniformly when file kind or access failure is unrelated to the changed contract | REJECT |
| Tests that can inherit existing user or machine configuration do not isolate with an empty config directory or temporary HOME | REJECT |
| A representative contract-invalid shape relevant to the change is pinned to ignore, normalize, or explicit-error behavior | OK |

## Test Data and Fixtures

Test data should explicitly generate the minimum facts needed by each test. Mutating shared fixtures or using mocks that drift from real contracts reduces test reliability.

| Criteria | Verdict |
|----------|---------|
| Shared fixtures are mutated and reused across tests | REJECT |
| Mocks, fixtures, or factories return shapes that differ from real types or API contracts | REJECT |
| Each test hand-writes a huge full-field fixture | Warning. Consider a factory |
| Factories provide defaults and each test overrides only relevant fields | OK |
| Contract changes update fixtures, mocks, and snapshots in the same change | OK |

## Contract Mocks and Test Doubles

When mocking an external SDK, external API, generated client, or CLI, align mocked exception types, statuses, return values, missing values, partial successes, and idempotency with the real contract. When using test doubles for internal builders, runners, or adapters, also match production semantics for permissions, capabilities, overrides, missing values, and side effects. Type compatibility alone does not verify the semantic contract.

| Criteria | Verdict |
|----------|---------|
| Mock values are chosen by checking official specs, SDK types, generated schemas, or existing equivalent tests | OK |
| The mock throws the exception or return value expected by the implementation, and test success is used as proof of the external contract | REJECT |
| Error types or response shapes from a different operation in the same service are reused | REJECT |
| The mock is type-safe but operation-specific semantic contracts, such as existing-resource behavior, partial success, or missing detection, are not verified | REJECT |
| Internal test double drops constraints, overrides, or side effects that production always passes | REJECT |
| When real integration is stubbed, the report separates what the mock verifies from the unverified real-integration scope | OK |

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

### Choosing Integration Tests

Verify data flow coupling that unit tests alone cannot cover.

| Condition | Verdict |
|-----------|---------|
| Data flow crosses multiple modules, without any other evidence | Not grounds for another test. Do not decide by module count |
| A contract-owner unit test can detect the same fault | Unit test is sufficient |
| A concrete cross-boundary miswiring or transformation omission cannot be detected by unit tests | A minimal integration test through that coupling is required |
| A new state merges into an existing workflow | Test transition decisions at their owner. Add a representative integration flow only for failures possible solely during composition |
| A new option propagates through a call chain | Verify the resolution owner and the smallest handoff not covered by existing tests. Do not repeat at every hop or consumer |
| Runtime configuration decides selection or precedence | Require production-like integration only for a concrete miswiring that a slice configuration would hide |
| An existing higher-level behavior test detects the same coupling failure | No addition needed. Do not require a duplicate integration test |

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
writeConfig({ backend, connectionPool: backend === 'embedded' ? 1 : 10 })
```

## e2e-testing Criteria

### E2E Test Scope

| Criteria | Judgment |
|----------|----------|
| Writing E2E tests for logic that unit tests can cover | Warning. Consider moving to unit tests |
| Verifying user operation flows | E2E test is appropriate |
| Scenarios spanning multiple commands/pages | E2E test is appropriate |
| Error message display verification | E2E test is appropriate |

### Behavior Observation

| Criteria | Judgment |
|----------|----------|
| Results from user actions or external inputs are observed | OK |
| Rejection, error, and recovery paths verify the expected result | OK |
| Only configuration or internal state is checked, with no user-visible result | REJECT |
| Only real external-environment verification exists, with no deterministic test for the main boundary | Warning or REJECT |

### Observing Negative Contracts

| Criteria | Judgment |
|----------|----------|
| Treating rejection, non-inheritance, or isolation as verified only because one exact sentence is absent | REJECT |
| Checking only the displayed allowed value without proving forbidden values do not reach final processing | REJECT |
| Extracting observable units and checking forbidden, rejected, or non-inherited values per value | OK |
| Comparing allowed vs rejected and inherited vs non-inherited cases in the same scenario family | OK |

## unit-testing Criteria

### Behavior Guarantees

| Criteria | Judgment |
|----------|----------|
| Expected return values, exceptions, or side effects are directly verified | OK |
| Both sides of a boundary change, such as success/failure or allow/deny, are verified | OK |
| Only configuration values or the last internal state are checked | REJECT |
| Main boundary conditions require an external environment to reproduce | Consider a deterministic test with a fake or stub |
