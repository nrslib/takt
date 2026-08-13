# Contract Replacement Policy

Separate preservation of unaffected contracts, migration of current consumers, and compatibility or migration support for superseded contracts, and implement only the scope authorized by the requirement source.

## Principles

| Principle | Criteria |
|-----------|----------|
| Preserve unaffected contracts | Preserve observable existing contracts outside the requested change scope |
| Migrate current consumers | Move current consumers of a replaced contract to the new contract |
| Remove superseded paths | Remove replaced paths except those explicitly retained as a support target |
| Require explicit authority | Allow backward compatibility, legacy support, migration support, or coexistence only for the target and scope explicitly required by the requirement source |
| Use only necessary mechanisms | Add or retain only mechanisms necessary to satisfy the explicitly required target |
| Resolve collisions at one decision boundary | When an explicit change and a preservation candidate compete to determine the same observable value, state transition, or side effect, apply the explicit change exactly in the overlapping state |

## Judgment Criteria

| Criteria | Judgment |
|----------|----------|
| Preserve an observable existing contract outside the requested change scope | OK |
| Migrate a current consumer of the replaced contract to the new contract | OK |
| Add or retain superseded-contract production, reading, aliases, fallback, conversion, upcasters, backfill, data migration, or rebuilds without explicit authority for that target | REJECT |
| Exceed the explicitly required support scope or add a mechanism unnecessary for it | REJECT |
| Extend authority for API compatibility to a different support target such as event upcasting, data migration or backfill, or Read Model rebuild | REJECT |
| Require or invent a deadline, deprecation date, end condition, or migration schedule absent from the requirement source | REJECT |

## Overlap Between Explicit Changes and Preserved Contracts

When the requirement source explicitly changes a default, priority, selected result, state transition, or side effect, resolve its overlap with existing candidates at the same decision boundary. Preserve unaffected contracts only for inputs, states, and effects that do not compete with the explicit change.

| Criteria | Judgment |
|----------|----------|
| The explicit-change candidate and preservation candidate can coexist and determine the same observable value, state transition, or side effect differently | Make the explicit change the winner and preserve only the candidate's independent remaining behavior |
| Extending preservation of an existing option's availability to preservation of its old default or priority | REJECT |
| Weakening an explicit default or priority to best effort, optional, or “when possible” based on the current implementation or a safety preference | REJECT |
| Treating operations as equivalent because they share a location, name, or result label while their state retention, re-execution, or side effects differ | REJECT |
| Testing competing candidates only in separate inputs without verifying the winner and operation effects when both coexist | REJECT |
| When a selected value or cursor designates an operation whose effect distinguishes the candidates, checking only value equality without verifying the selected operation's kind and effect | REJECT |
| Directly verifying the selected value and requirement-relevant state transitions or side effects in the smallest state where the competing candidates coexist | OK |
| Combining contracts that do not share the same decision boundary for exhaustive coverage | REJECT. Do not introduce combination axes outside the contract |

## Evidence Boundary

Treat current code, existing tests and usage sites, stored or persisted data, published or released status, and placement or isolation at a read boundary as evidence for impact paths and current consumers. They do not by themselves authorize support for a superseded contract.

When support is explicitly required, record its target and scope and verify that behavior directly. Judge each support target independently; authority for one target does not authorize another.
