# Contract Lifecycle Knowledge

Contract correctness is an end-to-end property. A value or behavioral promise remains valid only when every path that creates, validates, transforms, stores, reads, derives, and resolves it agrees on its meaning.

## Lifecycle Coverage

Trace a changed contract through each affected boundary rather than stopping at its declaration or primary caller.


## Equivalent Paths

Equivalent entry and resolution paths must not silently apply different contract rules.


## Entry-Specific Paths and Resource Ownership

Requirements have distinct paths for each public entry and execution mode, defined by their producers, validators, and consumers. Resource lifetime follows ownership, ownership transfer, and the last consumer; durable artifacts needed for investigation or resumption differ from temporary resources.


## Resolution Against the Original Contract

Resolving a finding requires rechecking the original acceptance criteria and all paths of that defect class.
