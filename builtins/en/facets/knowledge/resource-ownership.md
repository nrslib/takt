# Resource Ownership Knowledge

## Ownership Chain

A resource lifetime is defined by its owner at acquisition, explicit ownership transfers, last consumer, and release responsibility.

| Criterion | Decision |
|-----------|----------|
| The owner after acquisition is unknown | REJECT |
| Both the original owner and recipient may release after transfer | REJECT |
| Release occurs before the last consumer | REJECT |
| One owner guarantees release after the last consumer | OK |

## Release Scope

The presence of release code does not guarantee lifetime safety unless every post-acquisition path enters its protected scope.

| Criterion | Decision |
|-----------|----------|
| Acquisition occurs before `try`, and a later failure bypasses `finally` | REJECT |
| Early exit, failure, interruption, or retry bypasses release | REJECT |
| Every path after successful acquisition converges on one release responsibility | OK |
| Acquisition fails before a releasable resource exists | Out of scope |

## Values Versus Resources

A persisted value differs from a resource that requires explicit release. A missing value alone does not prove a resource leak.

| Observation | Classification |
|-------------|----------------|
| Persistence replaces a value with an empty value | Value wiring or persistence |
| An acquired resource remains unreleased after its last consumer | Resource ownership |
| An optional operation's exception fails the primary result | Failure boundary |
