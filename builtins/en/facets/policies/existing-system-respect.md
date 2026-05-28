# Existing System Respect Policy

For released or operational systems, make only the minimum changes required by the request and avoid changing existing contracts unnecessarily.

## Principles

| Principle | Criteria |
|-----------|----------|
| Existing contracts first | Preserve contracts relied on by users, tests, and operations |
| Minimum diff | Keep only changes required to satisfy the request |
| Necessity over proximity | Do not use nearby code as a reason to change it |
| Respect existing structure | Do not change file placement, type names, public APIs, or responsibility boundaries without explicit need |
| Preserve comments | Do not delete comments that explain intent, constraints, or calculation rationale |
| Tests are contracts | Do not treat behavior asserted by existing tests as incidental |
| Separate improvements | Style or cleanup improvements must be directly required by the task |
| Maintenance constraints first | Prefer preserving existing behavior and structure over general quality improvements |

## Change Boundary

| Criteria | Verdict |
|----------|---------|
| Change required to satisfy the request | OK |
| Call-site update required to wire a necessary change | OK |
| Local fix required to prevent side effects of a necessary change | OK |
| Cleanup justified only because the file was touched | REJECT |
| Moving files, renaming types, or changing public APIs without explicit need | REJECT |
| Mixing framework-style improvements into the task | REJECT |
| Including improvements that can be handled in another PR | REJECT |

## Priority Against Other Policies

In existing-system maintenance, apply general quality policies such as coding, frontend, design-fidelity, and testing only within the scope required by the request.

| Conflict | Verdict |
|----------|---------|
| General quality criteria suggest an improvement, but the request does not require it | Do not change |
| Existing structure is imperfect, but can satisfy this request | Preserve existing structure |
| Satisfying a quality criterion requires changing an existing contract | Requires an explicit user request or plan-level rationale |
| A minimal structural change is required for a bug fix | Make it with reason and impact scope documented |

## Observable Contracts

UI, accessibility, tests, logs, APIs, types, file placement, and comments can be contracts observed by users or developers.

| Contract | Change condition |
|----------|------------------|
| UI copy, accessible names, role/state | Change only when directly required by the request |
| Hook return values, Props type names, public function names | Change only when caller updates are required to satisfy the request |
| Test expectations | Change only when the requested behavior changes |
| Comments | Change only when correcting inaccurate comments or when code makes them truly obsolete |
| File placement | Change only when the existing structure cannot satisfy the request |

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
| Unnecessary change | Justified only by readability, style, cleanup, or future extensibility |
