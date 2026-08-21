# Contract Replacement Policy

Separate preservation of unaffected contracts, migration of current consumers, and compatibility or migration support for superseded contracts, and implement only the scope stated by the requirement source.

## Principles

| Principle | Criteria |
|-----------|----------|
| Preserve unaffected contracts | Preserve observable existing contracts outside the requested change scope |
| Migrate current consumers | Move current consumers of a replaced contract to the new contract |
| Remove superseded paths | Remove replaced paths except those explicitly retained as a support target |
| Require an explicit requirement | Allow backward compatibility, legacy support, migration support, or coexistence only for the target and scope explicitly required by the requirement source |
| Use only necessary mechanisms | Add or retain only mechanisms necessary to satisfy the explicitly required target |
| Resolve collisions at one decision boundary | When an explicit change and a preservation candidate compete to determine the same observable value, state transition, or side effect, apply the explicit change exactly in the overlapping state |
| Carry the primary operation to its terminal consumer | Trace the primary operation's input and decision through production, persistence, state transition, and later execution, display, or API consumers before evaluating secondary paths |

## Legacy Forms Being Replaced

When a replacement request does not mention reading the legacy form, remove its regular expression, conversion branch, and fallback. Existing persisted data, isolation at a read boundary, and low risk do not establish a requirement to retain compatibility. The review must treat the legacy path as a problem and include its removal in the fix.

When coexistence with the legacy form is explicit, verify separately that (1) new writes produce only the new form, (2) the new form is read and restored, and (3) the required legacy form is read and restored. Do not infer write support, migration, backfill, or compatibility for another contract from permission to read the legacy form.

| Judgment | Criteria |
|----------|----------|
| REJECT | A replacement request does not explicitly require legacy reading, conversion, fallback, or compatibility, but the old form remains |
| REJECT | Existing persisted data, isolation at a read boundary, or low risk is used as the sole reason to support the old form |
| OK | Only the legacy reading explicitly required by the request coexists with the new form |

## Judgment Criteria

| Criteria | Judgment |
|----------|----------|
| Preserve an observable existing contract outside the requested change scope | OK |
| Migrate a current consumer of the replaced contract to the new contract | OK |
| Add or retain superseded-contract production, reading, aliases, fallback, conversion, upcasters, backfill, data migration, or rebuilds without an explicit requirement for that target | REJECT |
| Exceed the explicitly required support scope or add a mechanism unnecessary for it | REJECT |
| Extend a requirement for API compatibility to a different support target such as event upcasting, data migration or backfill, or Read Model rebuild | REJECT |
| Require or invent a deadline, deprecation date, end condition, or migration schedule absent from the requirement source | REJECT |

## Overlap Between Explicit Changes and Preserved Contracts

When the requirement source explicitly changes a default, priority, selected result, state transition, or side effect, resolve its overlap with existing candidates at the same decision boundary. Preserve unaffected contracts only for inputs, states, and effects that do not compete with the explicit change.

| Criteria | Judgment |
|----------|----------|
| The explicit-change candidate and preservation candidate can coexist and determine the same observable value, state transition, or side effect differently | Make the explicit change the winner and preserve only the candidate's independent remaining behavior |
| Extending preservation of an existing option's availability to preservation of its old default or priority | REJECT |
| Weakening an explicit default or priority to best effort, optional, or “when possible” based on the current implementation or a safety preference | REJECT |
| Treating operations as equivalent because they share a location, name, or result label while their state retention, re-execution, or side effects differ | REJECT |
| Combining contracts that do not share the same decision boundary for exhaustive coverage | REJECT. Do not introduce combination axes outside the contract |
| Testing competing candidates only in separate inputs without verifying the winner and operation effects when both coexist | REJECT |
| When a selected value or cursor designates an operation whose effect distinguishes the candidates, checking only value equality without verifying the selected operation's kind and effect | REJECT |
| Directly verifying the selected value and requirement-relevant state transitions or side effects in the smallest state where the competing candidates coexist | OK |
| Preserving behavior shown by the current implementation, existing tests, mocks, fixtures, or completion reports as an established contract for inputs, states, or side effects where it conflicts with an explicit change | REJECT. Apply the explicit change |

## Primary Operation and Terminal Consumer

Treat a changed primary operation as incomplete until the downstream terminal consumer uses its decision. Evaluate recovery, compatibility, and fallback paths only after the primary path is closed, and preserve only the independently required behavior that does not replace the primary operation.

| Criteria | Judgment |
|----------|----------|
| The primary operation's producer, persistence or state transition, later consumer, and terminal effect share the same invariant | Trace them as one path and verify each observable effect at its boundary |
| A later execution or processor reads a value persisted by the primary operation | Verify the path from producing the value through the later consumer's execution before evaluating secondary paths |
| A secondary operation shares a selector or state with the primary operation | Keep the primary winner authoritative and preserve only the secondary operation's independently required effect |
| Secondary availability or compatibility is used to omit the primary operation's terminal consumer or state transition from evaluation | REJECT |
| Primary and secondary combinations add axes not required by a real decision boundary or consumer | REJECT. Limit the contract to the smallest primary end-to-end path |

## Evidence Boundary

Treat current code, existing tests and usage sites, mocks, fixtures, test doubles, remediation completion reports, stored or persisted data, published or released status, and placement or isolation at a read boundary as evidence for impact paths and current consumers. By themselves, they do not establish a requirement to preserve a superseded contract.

To classify behavior as an established contract that must be preserved, identify the original requirement, acceptance criterion, public specification, or real consumer dependency that requires it. Otherwise, the behavior is evidence only of how the system currently behaves.

When support is explicitly required, record its target and scope and verify that behavior directly. Judge each support target independently; a requirement for one target does not extend to another.

## contract-lifecycle Criteria

### Lifecycle Coverage

| Criterion | Verdict |
|-----------|---------|
| A changed field or behavior is updated only at its producer or type declaration | REJECT |
| Validation, serialization, derived values, alternate entries, or consumers retain the previous meaning | REJECT |
| Every affected lifecycle boundary preserves the same required meaning | OK |
| An unaffected boundary is excluded with evidence that it cannot receive or derive the contract | OK |

### Equivalent Paths

| Criterion | Verdict |
|-----------|---------|
| One entry validates or persists a constraint that an equivalent entry bypasses | REJECT |
| A retry, replay, import, or derived path changes a contract's meaning without a specification | REJECT |
| Equivalent paths intentionally differ and the original requirement or specification defines the distinction | OK |

### Entry-Specific Paths and Resource Ownership

| Criterion | Verdict |
|-----------|---------|
| A CLI, API, pipeline, retry, or other mode differs in any producer, validator, or consumer | Treat it as a separate path. Satisfying one path does not prove another |
| A path is excluded without evidence that it is unreachable or unaffected by the contract | REJECT |
| A resource is released before its last consumer while ownership or ownership transfer is unclear | REJECT |
| A durable artifact needed for investigation or resumption is removed as though it were temporary | REJECT |
| Success, failure, interruption, and retry preserve a lifetime contract based on ownership and the last consumer | OK |

### Resolution Against the Original Contract

| Criterion | Verdict |
|-----------|---------|
| A local patch is called resolved without checking equivalent lifecycle paths | REJECT |
| Tests merely capture current implementation behavior that conflicts with the original requirement | REJECT |
| Resolution evidence shows the original requirement holds across every affected path | OK |
