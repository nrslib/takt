# Architecture Policy

Provide one source of truth for independent judgments about architecture.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Architecture Criteria

### Boundaries That Aggregate Multiple Failures

| Criterion | Decision |
|-----------|----------|
| Status, category, displayed reason, and abort reason come from different results | REJECT |
| A classified result is replaced with a generic error before a result is selected | REJECT |
| Priority rules for a parallel operation or batch are embedded in the shared classification step | REJECT |
| Classification, selection of one result, and output are handled separately | OK |
| The rule for the operation selects one result once, and every decision and representation comes from it | OK |

### Structure & Design

| Judgment | Criteria |
|----------|----------|
| REJECT | Infrastructure-layer functions exported from public API |
| REJECT | Internal implementation functions callable from outside |
| OK | External consumers interact only through domain-level abstractions |

### Shared Layers and Responsibility Boundaries

| Judgment | Criteria |
|----------|----------|
| REJECT | A `shared` or generic utility depends on data or types owned by a specific feature |
| REJECT | A shared module owns both feature-specific formatting/parsing and infrastructure I/O |
| REJECT | Responsibilities with different reasons to change are collected in one module |
| OK | A shared module handles a domain-neutral contract with one responsibility and one reason to change |

### Structure & Design

| Criteria | Judgment |
|----------|----------|
| Each endpoint / handler implements the same translation from the same exception to the same protocol representation | REJECT |
| Translation to protocol representation lives in the application or domain layer | REJECT |
| API-specific exception translation is placed in a global handler shared by all APIs | REJECT |
| Translation to external representation is centralized in an exception translation layer at the adapter boundary | OK |

### Resolve at the Boundary

| Criteria | Judgment |
|----------|----------|
| Create a resolved object such as `ExecutionContext` or `ResolvedOptions` at the entry point | OK |
| Orchestration layers handle only resolved values | OK |
| Lower layers reload global/project/env and resolve the same value again | REJECT |
| Separate resolution functions exist for display and execution | REJECT |
| Unresolved options are passed deep and later fixed with `??` | REJECT |

### Tell, Don't Ask

| Pattern | Judgment |
|---------|----------|
| Upper layer passes a value such as `resolvedProvider` | OK |
| Lower layer inspects `options` and resolves on its own | REJECT |
| Execution object exposes only `run()` after `setup(config)` | OK |
| Runtime branches call `getGlobalConfig()` during execution | REJECT |

### Anti-Corruption Layer

| Pattern | Judgment |
|---------|----------|
| Encapsulate YAML/env/CLI differences in a resolver/adapter | OK |
| Domain layer directly handles env var names or config key strings | REJECT |
| Conversion from external form to internal form is centralized in one place | OK |
| Same normalization logic is copied in multiple places | REJECT |

### Separating Candidate Resolution from Value Composition

| Criteria | Judgment |
|----------|----------|
| Candidate lookup is first-match, but multiple candidates are implicitly composed because it is confused with value deep-merge | REJECT |
| Nearer-scope candidates are searched after farther-scope candidates | REJECT |
| Reference strings are classified only by the presence of a separator, confusing special references with explicit paths | REJECT |
| Candidate lookup, reference-kind classification, and value composition are readable as separate responsibilities | OK |

### Normalizing Raw Input

| Criteria | Judgment |
|----------|----------|
| Calling array methods or accessing properties directly on parsed unknown values | REJECT |
| Treating existence alone as satisfying file type or directory requirements | REJECT |
| Boundary code normalizes unknown values into internal types and pins contract-invalid shapes to ignore, normalize, or explicit-error behavior | OK |
| File and directory requirements are verified down to the actual entry kind | OK |

### Phase Separation

| Criteria | Judgment |
|----------|----------|
| Convert raw input into a `Resolved*` type at the boundary before entering the core flow | OK |
| Loop body handles only execution on resolved data | OK |
| Config/env/options are interpreted inside every iteration | REJECT |
| Each iteration packs `input -> interpret -> execute -> output` into one function | REJECT |
| Even when optimization requires incremental handling, interpretation is isolated in a dedicated method | OK |

### Code Quality Detection

| Judgment | Criteria |
|----------|----------|
| REJECT | Restates code behavior in natural language |
| REJECT | Repeats what is already obvious from function/variable names |
| REJECT | JSDoc that only paraphrases the function name without adding information |
| OK | Explains why a particular implementation was chosen |
| OK | Explains the reason behind seemingly unusual behavior |
| OK | Explains the calculation basis or components of a constant or magic number |
| Best | No comment needed — the code itself communicates intent |

## Anti-Pattern Detection

| Pattern | Decision |
|---------|----------|
| God Class/Component | REJECT: one class carries too many responsibilities |
| Feature Envy | REJECT: a module frequently reaches into another module's data |
| Shotgun Surgery | REJECT: one change ripples across unrelated files |
| Over-generalization | REJECT: variants or extension points are added without a current need |
| Hidden Dependencies | REJECT: a child component or lower layer calls APIs implicitly |
| Non-idiomatic implementation | REJECT: language or framework conventions are bypassed without a contract reason |

## Specification Constraint Detection

| Pattern | Decision |
|---------|----------|
| A field is used although it is absent from the specification | REJECT |
| A value disallowed by the specification is configured | REJECT |
| A documented constraint is violated | REJECT |
