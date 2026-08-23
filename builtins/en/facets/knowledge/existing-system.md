# Existing System Knowledge

## Existing System Contracts

In an existing system, contracts are not limited to explicit APIs. Values and structures observed by users or developers also function as contracts. A small code change can propagate to production screens, tests, reviews, and maintenance procedures.

Existing-contract preservation, current-consumer migration, and legacy support affect different boundaries. When a public API, event, command, configuration, path, or persisted format is replaced, current code, existing tests and usage sites, stored data, published or released status, and placement or isolation at a read boundary reveal distinct impact paths. API compatibility, event upcasters, data migration or backfill, and Read Model rebuilds operate on separate support boundaries and do not imply one another.

## Structure of a Causal Diff

Changes in an existing system divide into `required`, `related`, and `unnecessary` according to their causal relationship to the request. Being located in a target file does not establish that a change is necessary.

| Classification | Structure |
|----------------|-----------|
| `required` | A direct change that makes the request hold |
| `related` | A change connecting the producer, consumer, verification, or consistency of a `required` change |
| `unnecessary` | A change whose removal leaves the request satisfied and whose basis is only proximity, preference, general style, or future prediction |

A related change has a connection traceable to a required change. Updating callers of a function with a new argument or removing an old store after replacing a persistence boundary has such a connection. Renaming a public type near the change or reorganizing a return structure may lack that connection even when it is nearby.

## Observable Contracts and Internal Structure

User-visible copy and state, accessibility, public APIs, events, logs, configuration formats, and file placement can be observable contracts. A test assertion provides evidence of an impact path, but the mere existence of a test does not necessarily turn closed internal structure into a public contract.

Comments can preserve calculation rationale, platform constraints, known-bug workarounds, and prior design decisions. A comment that restates a function name and a comment recording a reason that cannot be recovered from the code have different change impacts.

## Impact Paths for Replacement and Preservation

In a contract replacement, the old definition, the new producer, current consumers, verification sites, persisted data, and published users are distinct impact points. Adding a new path does not by itself complete migration or removal of the old path.

For a preserved contract, the implementation, tests, and usage sites that demonstrate current behavior form reference points. Even when the internal mechanism changes, a contract can remain preserved if the values and states observed at those reference points remain the same.

## Relationship to General Quality Criteria

In maintenance work, general design improvements and framework style do not necessarily align with the request's causal path. Even when the existing structure is imperfect, changing that structure creates its own consumer migration, review scope, and regression surface.

| Change | Primary impact |
|--------|----------------|
| Rename | Changes search, history tracing, references, and review scope |
| File move | Changes ownership boundaries, reference paths, and history tracing |
| UI or accessibility contract change | Affects user experience, assistive technology, and tests |
| Test-expectation weakening | Reduces existing regression detection |
| Additional abstraction | Trades future flexibility for more present-day indirection and change points |
