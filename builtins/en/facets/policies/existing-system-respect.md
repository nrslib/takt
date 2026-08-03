# Existing System Respect Policy

For released or operational systems, make changes that are causally related to the request and do not change existing contracts that lack that relationship.

## Principles

| Principle | Criteria |
|-----------|----------|
| Existing contracts first | Preserve contracts outside the requested change scope that users, tests, and operations rely on |
| Causal diff | Make changes causally related to the request; exclude changes without causal relationship |
| Necessity over proximity | Do not use nearby code as a reason to change it |
| Respect existing structure | Do not change file placement, type names, public APIs, or responsibility boundaries without causal relationship to the request |
| Preserve comments | Do not delete comments that explain intent, constraints, or calculation rationale |
| Tests are contracts | Do not treat behavior asserted by existing tests as incidental |
| Verify external contracts from primary evidence | Confirm behavior of external services, SDKs, and generated artifacts from official specs or actual types/schemas |
| Causal improvement judgment | Perform style improvements and refactoring when causally related to the request. Do not mix improvements without causal relationship |
| Protect unrelated code | Prioritize preserving existing behavior and structure that is not causally related to the request |

## Change Boundary

| Criteria | Verdict |
|----------|---------|
| Change required to satisfy the request | OK |
| Call-site update required to wire a necessary change | OK |
| Local fix required to prevent side effects of a necessary change | OK |
| Structural change or refactoring causally related to the request | OK |
| Cleanup justified only because the file was touched | REJECT |
| Moving files, renaming types, or changing public APIs without causal relationship to the request | REJECT |
| Mixing framework-style improvements not causally related to the request | REJECT |
| Including improvements not causally related to the request | REJECT |

## Priority Against Other Policies

In existing-system maintenance, apply general quality policies such as coding, frontend, design-fidelity, and testing within the scope causally related to the request.

| Conflict | Verdict |
|----------|---------|
| General quality criteria suggest an improvement, but it is not causally related to the request | Do not change |
| Existing structure is imperfect, but not causally related to the request | Preserve existing structure |
| Satisfying a quality criterion requires changing an existing contract | Requires an explicit user request or plan-level rationale |
| Structural change causally related to the request | Make it with reason and impact scope documented |

Do not confuse existing-contract preservation, consumer migration, and backward compatibility, legacy support, migration support, or coexistence. When a requirement targets an old format, API, or path for replacement, migrate current consumers to the new contract. Add or retain only old-format production, reading, aliases, conversion, upcasters, fallback, backfill, data migration, or rebuilds necessary for backward compatibility, legacy support, migration support, or coexistence explicitly required by the requirement source for that target and scope. Treat API compatibility, event upcasters, data migration or backfill, and Read Model rebuilds as independent support targets; authority for one does not authorize another. Current code, existing tests and usage sites, stored or persisted data, published or released status, and placement or isolation at a read boundary justify impact analysis, but do not create authority for that support.

## Observable Contracts

UI, accessibility, tests, logs, APIs, types, file placement, and comments can be contracts observed by users or developers.

| Contract | Change condition |
|----------|------------------|
| UI copy, accessible names, role/state | Change only when causally related to the request |
| Hook return values, Props type names, public function names | Change only when required for caller updates causally related to the request |
| Test expectations | Change only when the requested behavior changes |
| Comments | Change only when correcting inaccurate comments or when code makes them truly obsolete |
| File placement | Change only when causally related to the request |

## External Dependency Contracts

Treat behavior of external services, SDKs, generated code, schemas, and CLIs as boundary contracts of the existing system. Do not infer one operation's error types, statuses, return values, idempotency, limits, or optionality from another operation without verification.

| Criteria | Verdict |
|----------|---------|
| The concrete contract is verified from official specs, actual type definitions, generated schemas, or existing equivalent implementation | OK |
| Error types, statuses, or return values from a different operation in the same service are generalized as "equivalent" and reused for an unverified operation | REJECT |
| Compile success, mock success, or stub expectations alone are treated as proof of the external contract | REJECT |
| Plans or implementation guidelines keep vague external-contract wording such as "equivalent" or "same as" | REJECT |
| When the external contract cannot be verified, the unverified scope, risk, and verification method are recorded | OK |

## Test Changes

Tests should distinguish existing contracts from new requirements, not merely follow the implementation.

| Pattern | Verdict |
|---------|---------|
| Add tests for new requirements | OK |
| Add regression tests to preserve existing contracts | OK |
| Merely weaken existing expectations to match implementation changes | REJECT |
| Remove tested existing behavior to make tests pass | REJECT |
| Delete tests because they obstruct the new implementation | REJECT |

## Pre-Completion Check

Before completion, classify the full diff as required changes, related changes, or unnecessary changes. Do not complete while unnecessary changes remain.

| Classification | Criteria |
|----------------|----------|
| Required change | The request fails without it |
| Related change | Needed to connect, verify, or keep a required change consistent |
| Unnecessary change | Not causally related to the request; justified only by readability, style, cleanup, or future extensibility |
