# Architecture Knowledge

## Boundaries That Aggregate Multiple Failures

A boundary that aggregates failures from multiple operations or layers must first select one primary failure. Classification, cause, recoverability, retry/fallback/stop decisions, external presentation, and abort records must all derive from that same failure.

| Criterion | Decision |
|-----------|----------|
| A fatal failure exists, but collection order or a retryable sibling takes priority | REJECT |
| The parent category, displayed reason, and abort reason come from different failures | REJECT |
| Classified detail is replaced with a generic error before the policy decision | REJECT |
| Failure to persist an auxiliary artifact replaces the primary result or becomes unobservable | REJECT |
| An explicit priority rule selects the primary failure and every decision and representation derives from it | OK |
| An auxiliary persistence failure is recorded safely while the primary result is preserved | OK |

Array order may represent occurrence or definition order, but it does not necessarily represent severity or recoverability priority. Preserve classified causes until the policy decision, and treat failures in auxiliary observability work as secondary failures.

```typescript
// NG - a retryable sibling hides a fatal failure and splits the output cause
const retryable = failures.find((failure) => failure.recovery === 'retry');
const fatal = failures.find((failure) => failure.recovery === 'stop');
return {
  action: retryable ? 'retry' : 'stop',
  category: fatal?.category,
  abortReason: retryable?.detail,
};

// OK - select the primary failure first and keep decisions and external forms aligned
const primary = selectPrimaryFailure(failures);
const result = {
  action: decideRecovery(primary.recovery),
  category: primary.category,
  reason: primary.detail,
  abortReason: primary.detail,
};

try {
  persistFailureArtifact(primary);
} catch (error) {
  observeSecondaryFailure(error);
}
return result;
```

## Structure & Design

**File Organization:**

A file should group code with the same responsibility and reason to change. Line count can prompt a closer look, but it is neither a reason to split nor a quality gate. Separate responsibilities that change independently; small definitions that collaborate closely and change for the same reason may stay together.

**Module Structure:**

- High cohesion: Related functionality grouped together
- Low coupling: Minimal inter-module dependencies
- No circular dependencies
- Appropriate directory hierarchy

**Operation Discoverability:**

Domain operations and external side effects are easier to understand when their purpose and owner can be followed through named boundaries. Calls that reconstruct the same contract in multiple places are candidates for a common owner. Direct use of a generic API whose intent is already clear does not need a wrapper merely to create a catalog.

**Public API Surface:**

Public APIs should expose only domain-level functions and types. Do not export infrastructure internals (provider-specific functions, internal parsers, etc.).

| Judgment | Criteria |
|----------|----------|
| REJECT | Infrastructure-layer functions exported from public API |
| REJECT | Internal implementation functions callable from outside |
| OK | External consumers interact only through domain-level abstractions |

**Function Design:**

- One responsibility per function
- Separate processing with an independent role or reason to change
- Side effects clearly defined

**Layer Design:**

- Dependency direction: Upper layers -> Lower layers (reverse prohibited)
- Controller -> Service -> Repository flow maintained
- 1 interface = 1 responsibility (no giant Service classes)

**Directory Structure:**

Structure pattern selection:

| Pattern | Use Case | Example |
|---------|----------|---------|
| Layered | Small scale, CRUD-centric | `controllers/`, `services/`, `repositories/` |
| Vertical Slice | Medium-large scale, high feature independence | `features/auth/`, `features/order/` |
| Hybrid | Common foundation + feature modules | `core/` + `features/` |

Vertical Slice Architecture (organizing code by feature):

```
src/
├── features/
│   ├── auth/
│   │   ├── LoginCommand.ts
│   │   ├── LoginHandler.ts
│   │   ├── AuthRepository.ts
│   │   └── auth.test.ts
│   └── order/
│       ├── CreateOrderCommand.ts
│       ├── CreateOrderHandler.ts
│       └── ...
└── shared/           # Shared across features
    ├── database/
    └── middleware/
```

Vertical Slice selection factors:

| Condition | Meaning / options |
|-----------|-------------------|
| A feature has an independent business responsibility, reason to change, and data owner | Candidate for a slice |
| The feature boundary aligns with existing dependency directions or deployment boundaries | Slicing can clarify ownership |
| Multiple features share the same business rules and reason to change | Consider layered or hybrid structure that preserves a common owner |
| Feature-specific responsibilities and cross-cutting infrastructure change for different reasons | Candidate for a hybrid of feature slices and shared infrastructure |

Prohibited patterns:

| Pattern | Problem |
|---------|---------|
| Bloated `utils/` | Becomes graveyard of unclear responsibilities |
| Lazy placement in `common/` | Dependencies become unclear |
| Nesting does not express a responsibility or owner | Makes navigation and change impact difficult to understand |
| Mixed features and layers | `features/services/` prohibited |

**Separation of Concerns:**

- Read and write responsibilities separated
- Data fetching at root (View/Controller), passed to children
- Exception translation for the same external contract is consolidated under its boundary owner, while different contracts remain at their respective boundaries
- Business logic not leaking into Controller/View

**Exception Translation at Protocol Boundaries:**

Adapters such as HTTP, CLI, GraphQL, and message consumers are boundaries that translate internal exceptions into external protocol representations. Scattering the same try-catch / response translation across endpoints or handlers easily makes status codes, error shapes, logs, and authorization failures inconsistent. Centralize exception translation in a dedicated layer at the adapter boundary, and keep only truly cross-cutting translations in a global handler.

| Criteria | Judgment |
|----------|----------|
| Each endpoint / handler implements the same translation from the same exception to the same protocol representation | REJECT |
| Translation to protocol representation lives in the application or domain layer | REJECT |
| API-specific exception translation is placed in a global handler shared by all APIs | REJECT |
| Translation to external representation is centralized in an exception translation layer at the adapter boundary | OK |

## Resolve at the Boundary

Values such as config, options, providers, permissions, and paths should be resolved at the boundary before entering the core flow. Main processing should assume values are already resolved and should not keep asking config sources.

| Criteria | Judgment |
|----------|----------|
| Create a resolved object such as `ExecutionContext` or `ResolvedOptions` at the entry point | OK |
| Orchestration layers handle only resolved values | OK |
| Lower layers reload global/project/env and resolve the same value again | REJECT |
| Separate resolution functions exist for display and execution | REJECT |
| Unresolved options are passed deep and later fixed with `??` | REJECT |

```typescript
// REJECT - Execution layer knows config sources directly
async function executeWorkflow(options) {
  const engine = new WorkflowEngine({
    provider: options.provider ?? globalConfig.provider,
  });
}

class AgentRunner {
  run(step, options) {
    const provider = options.provider ?? resolveProviderFromConfig();
    return getProvider(provider).call();
  }
}

// OK - Resolve at the boundary, use resolved values internally
async function executeWorkflow(options) {
  const context = resolveExecutionContext(options);
  const engine = new WorkflowEngine(context);
}

class AgentRunner {
  run(step, options) {
    return getProvider(options.resolvedProvider).call();
  }
}
```

### Tell, Don't Ask

Do not make lower layers inspect config sources and decide for themselves. Upper layers should tell them what to use by passing resolved values. Separate value selection from execution.

| Pattern | Judgment |
|---------|----------|
| Upper layer passes a value such as `resolvedProvider` | OK |
| Lower layer inspects `options` and resolves on its own | REJECT |
| Execution object exposes only `run()` after `setup(config)` | OK |
| Runtime branches call `getGlobalConfig()` during execution | REJECT |

### Anti-Corruption Layer

Precedence resolution and external config formats belong in a dedicated boundary layer. Pass only normalized internal values into the core model.

| Pattern | Judgment |
|---------|----------|
| Encapsulate YAML/env/CLI differences in a resolver/adapter | OK |
| Domain layer directly handles env var names or config key strings | REJECT |
| Conversion from external form to internal form is centralized in one place | OK |
| Same normalization logic is copied in multiple places | REJECT |

### Separating Candidate Resolution from Value Composition

Selecting a referenced target from multiple candidates and composing the selected value are separate contracts. Mixing lookup order, override rules, and reference kinds makes display, validation, and execution drift.

| Criteria | Judgment |
|----------|----------|
| Candidate lookup is first-match, but multiple candidates are implicitly composed because it is confused with value deep-merge | REJECT |
| Nearer-scope candidates are searched after farther-scope candidates | REJECT |
| Reference strings are classified only by the presence of a separator, confusing special references with explicit paths | REJECT |
| Candidate lookup, reference-kind classification, and value composition are readable as separate responsibilities | OK |

```typescript
// REJECT - Reference kind and lookup basis are mixed into one condition
const root = ref.includes('/') ? currentRoot : ownerRoot

// OK - Classify first, then resolve according to that kind's contract
const kind = classifyReference(ref)
const root = resolveRootForReference(kind, resolvedPath)
```

### Normalizing Raw Input

Values read from external files or configuration may be syntactically valid while not matching the expected shape. Treat them as unknown at the boundary, normalize into arrays, records, or scalars, and only then pass them into internal processing.

| Criteria | Judgment |
|----------|----------|
| Calling array methods or accessing properties directly on parsed unknown values | REJECT |
| Treating existence alone as satisfying file type or directory requirements | REJECT |
| Boundary code normalizes unknown values into internal types and pins contract-invalid shapes to ignore, normalize, or explicit-error behavior | OK |
| File and directory requirements are verified down to the actual entry kind | OK |

### Phase Separation

Separate input, interpretation, execution, and output into distinct stages. Iterative processing should, as much as possible, receive already interpreted input in bulk and then repeat only execution.

| Criteria | Judgment |
|----------|----------|
| Convert raw input into a `Resolved*` type at the boundary before entering the core flow | OK |
| Loop body handles only execution on resolved data | OK |
| Config/env/options are interpreted inside every iteration | REJECT |
| Each iteration packs `input -> interpret -> execute -> output` into one function | REJECT |
| Even when optimization requires incremental handling, interpretation is isolated in a dedicated method | OK |

```typescript
// REJECT - Each iteration also interprets input
for (const item of items) {
  const resolved = resolveItem(item, rawOptions, config);
  const result = execute(resolved);
  output(result);
}

// OK - Interpret first, iterations only execute
const resolvedItems = items.map((item) => resolveItem(item, rawOptions, config));

for (const item of resolvedItems) {
  const result = execute(item);
  output(result);
}
```

Even when interpretation must happen incrementally, keep `nextRawInput()`, `resolveInput()`, and `executeResolved()` as separate responsibilities. Performance constraints may compress phases, but must not mix responsibilities.

## Code Quality Detection

**Explanatory Comment (What/How) Detection Criteria:**

Detect comments that simply restate code behavior in natural language.

| Judgment | Criteria |
|----------|----------|
| REJECT | Restates code behavior in natural language |
| REJECT | Repeats what is already obvious from function/variable names |
| REJECT | JSDoc that only paraphrases the function name without adding information |
| OK | Explains why a particular implementation was chosen |
| OK | Explains the reason behind seemingly unusual behavior |
| OK | Explains the calculation basis or components of a constant or magic number |
| Best | No comment needed — the code itself communicates intent |

```typescript
// REJECT - Restates code (What)
// If interrupted, abort immediately
if (status === 'interrupted') {
  return ABORT_STEP;
}

// REJECT - Restates the loop
// Check transitions in order
for (const transition of step.transitions) {

// REJECT - Repeats the function name
/** Check if status matches transition condition. */
export function matchesCondition(status: Status, condition: TransitionCondition): boolean {

// OK - Design decision (Why)
// User interruption takes priority over workflow-defined transitions
if (status === 'interrupted') {
  return ABORT_STEP;
}

// OK - Reason behind seemingly odd behavior
// stay can cause loops, but is only used when explicitly specified by the user
return step.name;

// OK - Calculation basis for a constant
// paddingTop + paddingBottom + button height
const footerHeight = 24 + 12 + 48;
```

**Direct State Mutation Detection Criteria:**

Detect direct mutation of arrays or objects.

```typescript
// REJECT - Direct array mutation
const steps: Step[] = getSteps();
steps.push(newStep);           // Mutates original array
steps.splice(index, 1);       // Mutates original array
steps[0].status = 'done';     // Nested object also mutated directly

// OK - Immutable operations
const withNew = [...steps, newStep];
const without = steps.filter((_, i) => i !== index);
const updated = steps.map((s, i) =>
  i === 0 ? { ...s, status: 'done' } : s
);

// REJECT - Direct object mutation
function updateConfig(config: Config) {
  config.logLevel = 'debug';   // Mutates argument directly
  config.steps.push(newStep);  // Nested mutation too
  return config;
}

// OK - Returns new object
function updateConfig(config: Config): Config {
  return {
    ...config,
    logLevel: 'debug',
    steps: [...config.steps, newStep],
  };
}
```

## Security (Basic Checks)

- Injection prevention (SQL, Command, XSS)
- User input validation
- Hardcoded sensitive information

## Testability

- Dependency injection enabled
- Mockable design
- Tests are written

## Anti-Pattern Detection

REJECT when these patterns are found:

| Anti-Pattern | Problem |
|--------------|---------|
| God Class/Component | Single class with too many responsibilities |
| Feature Envy | Frequently accessing other modules' data |
| Shotgun Surgery | Single change ripples across multiple files |
| Over-generalization | Variants and extension points not currently needed |
| Hidden Dependencies | Child components implicitly calling APIs etc. |
| Non-idiomatic | Custom implementation ignoring language/FW conventions |

## Abstraction Level Evaluation

**Conditionals and Abstraction:**

Branch counts and syntax do not determine the right abstraction. Once two implementations with the same meaning, contract, and reason to change are observed, decide whether they belong under a common owner. A first implementation can still deserve an abstraction when it already crosses a real boundary such as external I/O versus domain logic, policy versus mechanism, or public contract versus internal implementation. Do not add Strategy or polymorphic variants based only on predicted future needs.

**Abstraction Level Mismatch Detection:**

| Pattern | Problem | Fix |
|---------|---------|-----|
| Low-level details in high-level processing | Hard to read | Extract details to functions |
| Mixed abstraction levels in one function | Cognitive load | Align to same granularity |
| DB operations mixed with business logic | Responsibility violation | Separate to Repository layer |
| Config values mixed with processing logic | Hard to change | Externalize configuration |

**Good Abstraction Examples:**

```typescript
// Proliferating conditionals
function process(type: string) {
  if (type === 'A') { /* process A */ }
  else if (type === 'B') { /* process B */ }
  else if (type === 'C') { /* process C */ }
  // ...continues
}

// Abstract with Map pattern
const processors: Record<string, () => void> = {
  A: processA,
  B: processB,
  C: processC,
};
function process(type: string) {
  processors[type]?.();
}
```

```typescript
// Mixed abstraction levels
function createUser(data: UserData) {
  // High level: business logic
  validateUser(data);
  // Low level: DB operation details
  const conn = await pool.getConnection();
  await conn.query('INSERT INTO users...');
  conn.release();
}

// Aligned abstraction levels
function createUser(data: UserData) {
  validateUser(data);
  await userRepository.save(data);  // Details hidden
}
```

## Workaround Detection

Don't overlook compromises made to "just make it work."

| Pattern | Example |
|---------|---------|
| Unnecessary package additions | Mystery libraries added just to make things work |
| Test deletion/skipping | `@Disabled`, `.skip()`, commented out |
| Empty implementations/stubs | `return null`, `// TODO: implement`, `pass` |
| Mock data in production | Hardcoded dummy data |
| Swallowed errors | Empty `catch {}`, `rescue nil` |
| Magic numbers | Unexplained `if (status == 3)` |

## Unfinished Code Detection

Unfinished-code judgment follows the coding policy. In architecture review, check whether TODO/FIXME comments, empty implementations, or stubs are being used as substitutes for required boundaries, authorization, validation, or contract updates.

TODO/FIXME without an issue number, external blocker, and removal condition is REJECT.

```kotlin
// REJECT - Authorization check deferred with TODO
// TODO: Add authorization check by facility ID
fun deleteCustomHoliday(@PathVariable id: String) {
    deleteCustomHolidayInputPort.execute(input)
}

// APPROVE - Implement now
fun deleteCustomHoliday(@PathVariable id: String) {
    val currentUserFacilityId = getCurrentUserFacilityId()
    val holiday = findHolidayById(id)
    require(holiday.facilityId == currentUserFacilityId) {
        "Cannot delete holiday from another facility"
    }
    deleteCustomHolidayInputPort.execute(input)
}
```

Acceptable TODO/FIXME cases:

| Condition | Example | Judgment |
|-----------|---------|----------|
| External dependency prevents implementation + issue exists + removal condition documented | `// TODO(#123): Implement after API key obtained` | Acceptable |
| Technical constraint prevents implementation + issue exists + removal condition documented | `// TODO(#456): Waiting for library bug fix` | Acceptable |
| "Future implementation", "add later" | `// TODO: Add validation` | REJECT |
| "No time for now" | `// TODO: Refactor` | REJECT |

Correct handling:
- Needed now → Implement now
- Not needed now → Delete the code
- External blocker → Create issue and include ticket number in comment

## DRY Violation Detection

DRY reduces duplicated knowledge, not merely similar code shapes. Once two implementations with the same meaning, contract, and reason to change are observed, decide whether they belong under a common owner. Choose the form that naturally owns the responsibility: a function, value object, component, policy, or another local abstraction.

When NOT to apply DRY:
- Different domains: Don't abstract (e.g., customer validation vs admin validation are different things)
- Superficially similar but different reasons to change: Treat as separate code

## Spec Compliance Verification

Contract-change consistency follows the active contract replacement policy. In architecture review, check whether changes contradict documented specifications, types, schemas, or config formats.

Conditions that require consistency:

| Change | Governing contracts |
|--------|---------------|
| Added or changed configuration | Documented schema, required fields, and valid values |
| Added or changed types or schemas | Producers, consumers, user-facing documentation, and valid configuration outside the changed contract |
| Changes involving design constraints | The primary specification that owns the constraint and its implementation boundary |

REJECT when these patterns are found:

| Pattern | Problem |
|---------|---------|
| Fields not in the spec | Ignored or unexpected behavior |
| Invalid values per spec | Runtime error or silently ignored |
| Violation of documented constraints | Against design intent |

## Call Chain Verification

Missing wiring after contract changes follows the coding policy. In architecture review, check whether new parameters or fields actually reach callers, producers, and readers instead of staying local to the changed file.

When a contract crosses a call chain, its definition alone is insufficient. The entry point that produces a value, callers that propagate it, and consumers that read it must share the same meaning; fallbacks must also match whether the contract truly permits omission.

Danger patterns:

| Pattern | Problem | Detection |
|---------|---------|-----------|
| `options.xxx ?? fallback` where all callers omit `xxx` | Feature implemented but always falls back | Check callers |
| Tests set values directly with mocks | Don't go through actual call chain | Check test construction |
| `executeXxx()` doesn't receive `options` it uses internally | No route to pass value from above | Check function signature |

```typescript
// Missing wiring: No route to receive projectCwd
export async function executeWorkflow(config, cwd, task) {
  const engine = new WorkflowEngine(config, cwd, task);  // No options
}

// Wired: Can pass projectCwd
export async function executeWorkflow(config, cwd, task, options?) {
  const engine = new WorkflowEngine(config, cwd, task, options);
}
```

Logically dead code due to caller constraints:

Call chain verification applies not only to "missing wiring" but also to the reverse — unnecessary guards for conditions that callers already guarantee.

| Pattern | Problem | Detection |
|---------|---------|-----------|
| TTY check when all callers require TTY | Unreachable branch remains | Check all callers' preconditions |
| Null guard when callers already check null | Redundant defense | Trace caller constraints |
| Runtime type check when TypeScript types constrain | Not trusting type safety | Check TypeScript type constraints |

The need for a defensive condition depends on preconditions guaranteed by reachable entry points. If every real entry point guarantees the same condition, the internal guard is logically unreachable; if any entry point does not, the guard can be a meaningful boundary defense.

## Immutability of Published State

For shared state published by a module (initial state, singletons, configuration objects), consumer mutations must not leak to other consumers. The required property is observable isolation. Factories, defensive copies, persistent data structures, and freezing are implementation choices; do not require recursive freezing or reference identity unless the public contract specifies the mechanism.

```typescript
// REJECT - mutable published initial state; one consumer write poisons every replay
export const initialState: State = { count: 0, entries: {} };

// Option - frozen, including nested objects
export const initialState: State = Object.freeze({ count: 0, entries: Object.freeze({}) });

// Option - factory returning a fresh instance every time
export function createInitialState(): State {
  return { count: 0, entries: {} };
}
```

## Quality Attributes

| Attribute | Review Point |
|-----------|--------------|
| Scalability | Design handles increased load |
| Maintainability | Easy to modify and fix |
| Observability | Logging and monitoring enabled |

## Big Picture

Don't get lost in minor "clean code" nitpicks.

Quality attributes become design constraints only when their need is supported by the request, current load, an existing operational contract, or a boundary changed now. Predictions that the code or scale may change do not by themselves justify extension points or extra layers. Domain naming and alignment with current business contracts remain present semantic concerns rather than future forecasts.

## Change Scope Assessment

Assess scope by whether it forms a coherent set of requirements, root causes, and affected paths with the same contract, not by line count. A broad change may be indispensable, while a small unrelated edit is still scope expansion.

Logical cohesion can be explained by a shared requirement, root cause, contract, or real boundary. A coder's scope declaration is supporting evidence; when it differs from the actual change, evaluate against the request and affected paths as the authority.
