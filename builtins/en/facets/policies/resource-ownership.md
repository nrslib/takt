# Resource Ownership Policy

Provide one source of truth for independent judgments about resource ownership.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Resource Ownership Criteria

### Ownership Chain

| Criterion | Decision |
|-----------|----------|
| The owner after acquisition is unknown | REJECT |
| Both the original owner and recipient may release after transfer | REJECT |
| Release occurs before the last consumer | REJECT |
| One owner guarantees release after the last consumer | OK |

### Release Scope

| Criterion | Decision |
|-----------|----------|
| Acquisition occurs before `try`, and a later failure bypasses `finally` | REJECT |
| Early exit, failure, interruption, or retry bypasses release | REJECT |
| Every path after successful acquisition converges on one release responsibility | OK |
| Acquisition fails before a releasable resource exists | Out of scope |
