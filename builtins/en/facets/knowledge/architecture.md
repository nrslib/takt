# Architecture Knowledge

## Boundaries That Aggregate Multiple Failures

When a process combines multiple results, it selects one result using the rule defined for that process. Every control decision and external representation comes from that same result. Other results may remain recorded, but they do not replace the selected result through a priority rule that was not defined.


A shared classification step converts each response or exception exactly once into a result with its classification, cause, and recovery method. Each parallel operation, parent-child operation, or batch selects one result using its own rule. The output step derives status, category, reason, retry, fallback, stop decisions, abort reasons, and external representations from the selected result. Do not replace these three steps with one universal priority rule.

```typescript
// Avoid: select different parent fields from different siblings
const retryable = outcomes.find((outcome) => outcome.recovery === 'retry');
const categorized = outcomes.find((outcome) => outcome.category !== undefined);
return {
  action: retryable ? 'retry' : 'stop',
  category: categorized?.category,
  abortReason: retryable?.detail,
};

// Example: select once through the boundary policy and project one primary
const outcomes = responses.map(classifyOutcome);
const primary = selectPrimaryOutcome(outcomes, boundaryPolicy);
return {
  action: decideRecovery(primary.recovery),
  category: primary.category,
  reason: primary.detail,
  abortReason: primary.detail,
};
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

`utils/` and `common/` tend to grow without expressing a responsibility or owner. When features and layers are represented in the same hierarchy, verify the dependency direction and change impact.

**Separation of Concerns:**

- Read and write responsibilities separated
- Data fetching at root (View/Controller), passed to children
- Exception translation for the same external contract is consolidated under its boundary owner, while different contracts remain at their respective boundaries
- Business logic not leaking into Controller/View

**Exception Translation at Protocol Boundaries:**

Adapters such as HTTP, CLI, GraphQL, and message consumers are boundaries that translate internal exceptions into external protocol representations. Scattering the same try-catch / response translation across endpoints or handlers easily makes status codes, error shapes, logs, and authorization failures inconsistent. Centralize exception translation in a dedicated layer at the adapter boundary, and keep only truly cross-cutting translations in a global handler.


## Resolve at the Boundary

Values such as config, options, providers, permissions, and paths should be resolved at the boundary before entering the core flow. Main processing should assume values are already resolved and should not keep asking config sources.


```typescript
// Avoid: Execution layer knows config sources directly
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

// Example: Resolve at the boundary, use resolved values internally
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


### Anti-Corruption Layer

Precedence resolution and external config formats belong in a dedicated boundary layer. Pass only normalized internal values into the core model.


### Separating Candidate Resolution from Value Composition

Selecting a referenced target from multiple candidates and composing the selected value are separate contracts. Mixing lookup order, override rules, and reference kinds makes display, validation, and execution drift.


```typescript
// Avoid: Reference kind and lookup basis are mixed into one condition
const root = ref.includes('/') ? currentRoot : ownerRoot

// Example: Classify first, then resolve according to that kind's contract
const kind = classifyReference(ref)
const root = resolveRootForReference(kind, resolvedPath)
```

### Normalizing Raw Input

Values read from external files or configuration may be syntactically valid while not matching the expected shape. Treat them as unknown at the boundary, normalize into arrays, records, or scalars, and only then pass them into internal processing.


### Phase Separation

Separate input, interpretation, execution, and output into distinct stages. Iterative processing should, as much as possible, receive already interpreted input in bulk and then repeat only execution.


```typescript
// Avoid: Each iteration also interprets input
for (const item of items) {
  const resolved = resolveItem(item, rawOptions, config);
  const result = execute(resolved);
  output(result);
}

// Example: Interpret first, iterations only execute
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


```typescript
// Avoid: Restates code (What)
// If interrupted, abort immediately
if (status === 'interrupted') {
  return ABORT_STEP;
}

// Avoid: Restates the loop
// Check transitions in order
for (const transition of step.transitions) {

// Avoid: Repeats the function name
/** Check if status matches transition condition. */
export function matchesCondition(status: Status, condition: TransitionCondition): boolean {

// Example: Design decision (Why)
// User interruption takes priority over workflow-defined transitions
if (status === 'interrupted') {
  return ABORT_STEP;
}

// Example: Reason behind seemingly odd behavior
// stay can cause loops, but is only used when explicitly specified by the user
return step.name;

// Example: Calculation basis for a constant
// paddingTop + paddingBottom + button height
const footerHeight = 24 + 12 + 48;
```

**Direct State Mutation Detection Criteria:**

Detect direct mutation of arrays or objects.

```typescript
// Avoid: Direct array mutation
const steps: Step[] = getSteps();
steps.push(newStep);           // Mutates original array
steps.splice(index, 1);       // Mutates original array
steps[0].status = 'done';     // Nested object also mutated directly

// Example: Immutable operations
const withNew = [...steps, newStep];
const without = steps.filter((_, i) => i !== index);
const updated = steps.map((s, i) =>
  i === 0 ? { ...s, status: 'done' } : s
);

// Avoid: Direct object mutation
function updateConfig(config: Config) {
  config.logLevel = 'debug';   // Mutates argument directly
  config.steps.push(newStep);  // Nested mutation too
  return config;
}

// Example: Returns new object
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

In architecture review, check whether TODO/FIXME comments, empty implementations, or stubs are being used as substitutes for required boundaries, authorization, validation, or contract updates.

## DRY Violation Detection

DRY reduces duplicated knowledge, not merely similar code shapes. Once two implementations with the same meaning, contract, and reason to change are observed, decide whether they belong under a common owner. Choose the form that naturally owns the responsibility: a function, value object, component, policy, or another local abstraction.

When NOT to apply DRY:
- Different domains: Don't abstract (e.g., customer validation vs admin validation are different things)
- Superficially similar but different reasons to change: Treat as separate code

## Spec Compliance Verification

In architecture review, check whether contract changes contradict documented specifications, types, schemas, or config formats.

Conditions that require consistency:

| Change | Governing contracts |
|--------|---------------|
| Added or changed configuration | Documented schema, required fields, and valid values |
| Added or changed types or schemas | Producers, consumers, user-facing documentation, and valid configuration outside the changed contract |
| Changes involving design constraints | The primary specification that owns the constraint and its implementation boundary |

## Call Chain Verification

In architecture review, check whether new parameters or fields actually reach callers, producers, and readers instead of staying local to the changed file.

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
// Avoid: mutable published initial state; one consumer write poisons every replay
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

## Termination-Path Completeness

For features that create temporary files or external resources, verify that they are released not only on normal completion but at every terminal: failure, cancellation, and forced termination. `process.exit()` and forced termination (repeated SIGINT, an abort handler that exits immediately) do not run `finally` blocks. Cleanup that relies on `finally` is bypassed on any path that calls `process.exit` inside it and on forced-termination paths. For each entry point that creates resources, build the list of terminals (normal, failure, cancellation, forced termination) and enumerate the terminals where cleanup does not run.
