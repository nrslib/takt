# Contract Lifecycle Knowledge

Contract correctness is an end-to-end property. A value or behavioral promise remains valid only when every path that creates, validates, transforms, stores, reads, derives, and resolves it agrees on its meaning.

## Lifecycle Coverage

Trace a changed contract through each affected boundary rather than stopping at its declaration or primary caller.

| Criterion | Verdict |
|-----------|---------|
| A changed field or behavior is updated only at its producer or type declaration | REJECT |
| Validation, serialization, derived values, alternate entries, or consumers retain the previous meaning | REJECT |
| Every affected lifecycle boundary preserves the same required meaning | OK |
| An unaffected boundary is excluded with evidence that it cannot receive or derive the contract | OK |

## Equivalent Paths

Equivalent entry and resolution paths must not silently apply different contract rules.

| Criterion | Verdict |
|-----------|---------|
| One entry validates or persists a constraint that an equivalent entry bypasses | REJECT |
| A retry, replay, import, or derived path changes a contract's meaning without a specification | REJECT |
| Equivalent paths intentionally differ and the original requirement or specification defines the distinction | OK |

## Entry-Specific Paths and Resource Ownership

Requirements have distinct paths for each public entry and execution mode, defined by their producers, validators, and consumers. Resource lifetime follows ownership, ownership transfer, and the last consumer; durable artifacts needed for investigation or resumption differ from temporary resources.

| Criterion | Verdict |
|-----------|---------|
| A CLI, API, pipeline, retry, or other mode differs in any producer, validator, or consumer | Treat it as a separate path. Satisfying one path does not prove another |
| A path is excluded without evidence that it is unreachable or unaffected by the contract | REJECT |
| A resource is released before its last consumer while ownership or ownership transfer is unclear | REJECT |
| A durable artifact needed for investigation or resumption is removed as though it were temporary | REJECT |
| Success, failure, interruption, and retry preserve a lifetime contract based on ownership and the last consumer | OK |

## Resolution Against the Original Contract

Resolving a finding requires rechecking the original acceptance criteria and all paths of that defect class.

| Criterion | Verdict |
|-----------|---------|
| A local patch is called resolved without checking equivalent lifecycle paths | REJECT |
| Tests merely capture current implementation behavior that conflicts with the original requirement | REJECT |
| Resolution evidence shows the original requirement holds across every affected path | OK |
