# Coding Policy

Prioritize correctness over speed, and code accuracy over ease of implementation.

## Principles

| Principle | Criteria |
|-----------|----------|
| Simple > Easy | Prioritize readability over writability |
| DRY | Eliminate essential duplication |
| Comments | Why only. Never write What/How |
| Function size | One function, one responsibility. ~30 lines |
| File size | ~300 lines as a guideline. Be flexible depending on the task |
| Boy Scout | Leave touched areas a little better than you found them |
| Fail Fast | Detect errors early. Never swallow them |
| Project scripts first | Use project-defined scripts for tool execution. Direct invocation is a last resort |
| State normalization | Do not keep the same fact in multiple states |

## No Fallbacks or Default Arguments

Do not write code that obscures the flow of values. Code where you must trace logic to understand a value is bad code.

### Prohibited Patterns

| Pattern | Example | Problem |
|---------|---------|---------|
| Fallback for required data | `user?.id ?? 'unknown'` | Processing continues in a state that should error |
| Default argument abuse | `function f(x = 'default')` where all call sites omit it | Impossible to tell where the value comes from |
| Null coalesce with no way to pass | `options?.cwd ?? process.cwd()` with no path from callers | Always falls back (meaningless) |
| Return empty value in try-catch | `catch { return ''; }` | Swallows the error |
| Silent skip on inconsistent values | `if (a !== expected) return undefined` | Config errors silently ignored at runtime |

### Correct Implementation

```typescript
// ❌ Prohibited - Fallback for required data
const userId = user?.id ?? 'unknown'
processUser(userId)  // Processing continues with 'unknown'

// ✅ Correct - Fail Fast
if (!user?.id) {
  throw new Error('User ID is required')
}
processUser(user.id)

// ❌ Prohibited - Default argument where all call sites omit
function loadConfig(path = './config.json') { ... }
// All call sites: loadConfig()  ← path is never passed

// ✅ Correct - Make it required and pass explicitly
function loadConfig(path: string) { ... }
// Call site: loadConfig('./config.json')  ← explicit

// ❌ Prohibited - Null coalesce with no way to pass
class Engine {
  constructor(config, options?) {
    this.cwd = options?.cwd ?? process.cwd()
    // Problem: if there's no path to pass cwd via options, it always falls back to process.cwd()
  }
}

// ✅ Correct - Allow passing from the caller
function createEngine(config, cwd: string) {
  return new Engine(config, { cwd })
}
```

### Acceptable Cases

- Default values when validating external input (user input, API responses)
- Optional values in config files (explicitly designed to be omittable)
- Only some call sites use the default argument (prohibited if all callers omit it)

### Decision Criteria

1. **Is it required data?** → Throw an error, do not fall back
2. **Do all call sites omit it?** → Remove the default, make it required
3. **Is there a path to pass the value from above?** → If not, add a parameter or field
4. **Do related values have invariants?** → Cross-validate at load/setup time

## Unify Resolution Responsibility

Values that can be decided early — config, options, providers, paths, permissions — must be resolved once at the boundary. Do not re-resolve the same value in multiple layers.

| Pattern | Judgment | Reason |
|---------|----------|--------|
| Resolve at the entry point and pass the value explicitly downward | OK | Source of truth stays traceable |
| Delegate resolution to a dedicated method/object | OK | Preserves a single source of truth |
| Resolve the same config separately in upper and lower layers | REJECT | Creates precedence drift |
| Resolve separately for display and execution | REJECT | Logs and behavior diverge |
| Stack `if` branches for config resolution inside main flow | REJECT | Leaks details into orchestration |

```typescript
// REJECT - Each layer resolves config independently
function executeTask(options) {
  const provider = options.provider ?? loadGlobalConfig().provider;
  return runAgent({
    provider,
    stepProvider: resolveProviderForStep(options.step),
  });
}

function runAgent(options) {
  const provider = options.provider ?? resolveProviderFromConfig();
  return getProvider(provider).call();
}

// OK - Resolve at the boundary, then use resolved values only
function executeTask(options) {
  const resolved = resolveExecutionContext(options);
  return runAgent({
    resolvedProvider: resolved.provider,
    resolvedModel: resolved.model,
  });
}

function runAgent(options) {
  return getProvider(options.resolvedProvider).call();
}
```

Decision criteria:
1. Can this value be fixed before execution starts? → Resolve it at the boundary
2. Does the same precedence logic exist in 2+ places? → Centralize it in a dedicated method/object
3. Does a lower layer know config sources directly? → Pass only resolved values
4. Are display, execution, and persistence resolving separately? → Share the same resolved result

## Phase Separation

Separate input collection, interpretation/normalization, execution, and output/side effects into distinct phases. Do not keep receiving unresolved input in the middle of loops or main processing and interpret it on the spot.

| Pattern | Judgment | Reason |
|---------|----------|--------|
| Split into stages such as `RawOptions -> ResolvedOptions -> ExecutionContext` | OK | Responsibility of each phase is explicit |
| Normalize input before entering the loop | OK | Every iteration runs on the same assumptions |
| Resolve `options ?? config ?? env` inside every iteration | REJECT | Iteration assumptions can drift |
| Mix input interpretation and execution logic per iteration | REJECT | Intent of the flow becomes unreadable |
| Even when true streaming/optimization forces per-item handling, isolate interpretation in a dedicated method | OK | Keeps minimum responsibility separation |

```typescript
// REJECT - Interpret input inside the loop every time
for (const step of steps) {
  const provider = options.provider
    ?? step.provider
    ?? projectConfig.provider
    ?? globalConfig.provider;
  const result = await executeStep(step, { provider });
  printResult(result);
}

// OK - Resolve first, loop only executes
const context = resolveExecutionContext(rawOptions, steps);

for (const step of context.steps) {
  const result = await executeStep(step, {
    resolvedProvider: step.resolvedProvider,
  });
  printResult(result);
}
```

Decision criteria:
1. Is a branch inside the loop business logic or input interpretation? → Move input interpretation outside
2. Is the same interpretation repeated for each iteration? → Normalize once up front
3. Does an execution function accept raw input directly? → Convert to a `Resolved*` type first
4. Does optimization require incremental handling? → At least extract interpretation into a dedicated function

## Abstraction

### Think Before Adding Conditionals

- Does the same condition exist elsewhere? → Abstract with a pattern
- Will more branches be added? → Use Strategy/Map pattern
- Branching on type? → Replace with polymorphism

```typescript
// ❌ Growing conditionals
if (type === 'A') { ... }
else if (type === 'B') { ... }
else if (type === 'C') { ... }  // Yet another branch

// ✅ Abstract with a Map
const handlers = { A: handleA, B: handleB, C: handleC };
handlers[type]?.();
```

### Do Not Over-Abstract

Use abstraction to reduce duplication and real axes of change, and also to name concepts so the code is easier to understand. Turning a few concrete operations into "config objects + function objects + loops" is not abstraction if it only makes domain differences harder to read.

| Criteria | Judgment |
|----------|----------|
| A small number of branches differs by event type, state, or domain concept | Use explicit `when` / `switch` |
| The same operation with the same argument shape repeats in 3+ places | Consider abstraction |
| A config array or function object is used in only one place | REJECT. Prefer explicit branching first |
| Side effects or removed fields cannot be understood without reading config objects | REJECT |
| Strategy names a domain concept and makes interchangeable implementations explicit | OK |
| Branch names read as domain concepts | OK |

```typescript
// ❌ Over-abstracted - readers must inspect both the config array and loop to see behavior
const operations = [
  { kind: 'create', normalize: ['owner'], remove: [] },
  { kind: 'revise', normalize: ['owner'], remove: ['legacyOwner'] },
]
for (const operation of operations) {
  applyOperation(record, operation)
}

// ✅ When branch meaning matters, make it explicit
switch (record.kind) {
  case 'create':
    normalizeOwner(record)
    break
  case 'revise':
    removeLegacyOwner(record)
    normalizeOwner(record)
    break
}
```

### Keep Abstraction Levels Consistent

Within a single function, keep operations at the same granularity. Extract detailed operations into separate functions. Do not mix "what to do" with "how to do it."

```typescript
// ❌ Mixed abstraction levels
function processOrder(order) {
  validateOrder(order);           // High level
  const conn = pool.getConnection(); // Low-level detail
  conn.query('INSERT...');        // Low-level detail
}

// ✅ Consistent abstraction levels
function processOrder(order) {
  validateOrder(order);
  saveOrder(order);  // Details are hidden
}
```

In orchestration functions (Step 1 → Step 2 → Step 3), pay special attention. If an individual step's internals expand with conditional branches, extract that step into a function. The criterion is not the number of branches, but **whether the branch belongs at the function's abstraction level**.

```typescript
// ❌ Low-level branching exposed in orchestration function
async function executePipeline(options) {
  const task = resolveTask(options);      // Step 1: high level ✅

  // Step 2: low-level details exposed ❌
  let execCwd = cwd;
  if (options.createWorktree) {
    const result = await confirmAndCreateWorktree(cwd, task, true);
    execCwd = result.execCwd;
    branch = result.branch;
  } else if (!options.skipGit) {
    baseBranch = getCurrentBranch(cwd);
    branch = generateBranchName(config, options.issueNumber);
    createBranch(cwd, branch);
  }

  await executeTask({ cwd: execCwd, ... }); // Step 3: high level ✅
}

// ✅ Extract details, keep abstraction levels consistent
async function executePipeline(options) {
  const task = resolveTask(options);
  const ctx = await resolveExecutionContext(options);
  await executeTask({ cwd: ctx.execCwd, ... });
}
```

### Follow Language and Framework Conventions

- Write Pythonic Python, idiomatic Kotlin, etc.
- Use framework-recommended patterns
- Prefer standard approaches over custom ones
- When unsure, research. Do not implement based on guesses

### Interface Design

Design interfaces from the consumer's perspective. Do not expose internal implementation details.

| Principle | Criteria |
|-----------|----------|
| Consumer perspective | Do not force things the caller does not need |
| Separate configuration from execution | Decide "what to use" at setup time, keep the execution API simple |
| No method proliferation | Absorb differences through configuration, not multiple methods doing the same thing |

```typescript
// ❌ Method proliferation — pushing configuration differences onto the caller
interface NotificationService {
  sendEmail(to, subject, body)
  sendSMS(to, message)
  sendPush(to, title, body)
  sendSlack(channel, message)
}

// ✅ Separate configuration from execution
interface NotificationService {
  setup(config: ChannelConfig): Channel
}
interface Channel {
  send(message: Message): Promise<Result>
}
```

### Explicit Dependencies

Pass dependencies in a form whose role and type are visible. Do not reject function-typed parameters categorically; judge whether they hide a stable business role or external dependency behind an anonymous callback.

| Pattern | Verdict |
|---------|---------|
| A business rule or external lookup relayed through multiple layers as an anonymous callback | REJECT. Give the role a name and promote it to a port, validator, service, or equivalent boundary |
| A function type defined as a named business role or port | OK. Its meaning and substitution boundary are visible |
| A function passed for local enrichment or conversion at a layer boundary | OK. The responsibility stays within the boundary and is not relayed onward |
| A block that scopes a lock, transaction, or resource | OK. It is a control structure, not dependency smuggling |

### Leaky Abstraction

If a specific implementation appears in a generic layer, the abstraction is leaking. The generic layer should only know interfaces; branching should be absorbed by implementations.

```typescript
// ❌ Specific implementation imports and branching in generic layer
import { uploadToS3 } from '../aws/s3.js'
if (config.storage === 's3') {
  return uploadToS3(config.bucket, file, options)
}

// ✅ Generic layer uses interface only. Unsupported cases error at creation time
const storage = createStorage(config)
return storage.upload(file, options)
```

## Naming

A name expresses the code's actual role and effect, not its implementation mechanism. Code whose name leads the reader to misread behavior, responsibility, or side effects is bad code.

| Pattern | Example | Verdict |
|---------|---------|---------|
| Name contradicts the actual effect | Reads as if it causes a side effect every time, but actually returns a cached value | REJECT |
| Side effects or call frequency are unreadable | Cannot tell from the name whether it initializes, retrieves, or updates | REJECT |
| Cannot distinguish it from nearby APIs | Same name as the wrapped or delegated API, hiding which layer owns the responsibility | REJECT |
| Named after role/effect | The provided value, state change, or responsibility is clear from the name | OK |
| Path/origin suffix with no distinct counterpart path in existence | FromRequest / ViaApi on the only existing path | REJECT. Drop the suffix; when the counterpart path disappears, the name follows |
| Naming convention differs for only some of a set of same-kind operations | createXxxFromRequest / updateXxxFromRequest / deleteXxx | REJECT. Make them consistent |

```typescript
// REJECT - Name reads as if it causes a side effect every time, but it is a memoized accessor
let resourcePromise: Promise<Resource> | null = null
function openResource(): Promise<Resource> {
  if (!resourcePromise) {
    resourcePromise = createResource()
  }
  return resourcePromise
}

// OK - Name it after its actual role: getting an available resource
function getResource(): Promise<Resource> {
  if (!resourcePromise) {
    resourcePromise = createResource()
  }
  return resourcePromise
}
```

Criteria:
1. Does the name express the actual role/effect?
2. Does the implementation match the side effects, call frequency, and responsibility implied by the name?
3. Does it avoid confusion with wrapped, delegated, or nearby APIs?
4. Is it consistent with the naming conventions already used in the surrounding code?

## Structure

### Criteria for Splitting

- Has its own state → Separate
- UI/logic exceeding 50 lines → Separate
- Has multiple responsibilities → Separate
- Has an independent reason to change, responsibility, or reuse boundary → Separate. Whether small supporting types may share a file depends on language conventions and file cohesion

### Reachability When Adding Features

When adding a new feature or screen, update the paths by which users reach it in the same change set. Framework-specific wiring belongs in domain knowledge.

| Criteria | Judgment |
|----------|----------|
| A new feature is implemented but callers, entry points, or navigation are not updated | REJECT |
| A user-facing feature is added without defining how users reach it | REJECT |
| Implementation and reachability updates are made in the same change set | OK |
| A temporary entry path is added and its purpose/removal condition is documented | OK |

### Dependency Direction

- Upper layers → Lower layers (reverse direction prohibited)
- Fetch data at the root (View/Controller) and pass it down
- Children do not know about their parents

### Align execution triggers with actual intent

Dependencies and triggers must match the conditions under which the behavior should actually run again. Do not add triggers only to satisfy linting or implementation convenience if that changes runtime behavior.

| Criteria | Judgment |
|----------|----------|
| Dependencies or triggers are expanded only for linting/convenience and create rerun loops | REJECT |
| Initial processing reruns because of unrelated state changes or recreated callbacks | REJECT |
| Rerun conditions correspond to URL, filters, explicit refresh actions, or other intended behavior | OK |
| Initialization and later refetch triggers are designed separately | OK |

## Contract Change Consistency

When changing contracts that other code or users depend on — types, interfaces, APIs, config schemas, persistence formats, events, or file formats — keep definitions, producers, consumers, and verification aligned in the same change.

| Criteria | Judgment |
|----------|----------|
| Only the contract definition is changed, while callers, producers, or readers are not updated | REJECT |
| A new argument, field, or config value is added but there is no route to pass it to consumers | REJECT |
| Fields or values not present in the documented schema/config format are used | REJECT |
| Mocks, fixtures, or test data return shapes that differ from the real contract | REJECT |
| The contract change and updates to callers, producers, and tests are made in the same change | OK |

## State Management

- Confine state to where it is used
- Children do not modify state directly (notify parents via events)
- State flow is unidirectional
- Do not keep derived values that can be computed from canonical state as independent state
- If multiple fields require constant synchronization, revisit the state model

| Criteria | Judgment |
|----------|----------|
| A value that can always be computed from one state is kept as another state | REJECT |
| Multiple states have invariants that must always stay in sync | REJECT |
| Persistence, sending, or diffing depends on derived values | REJECT |
| Only canonical state is stored, and derived values are generated at use sites or boundaries | OK |

## Unfinished Code

Do not leave TODO/FIXME comments, empty implementations, stubs, or commented-out old implementations as substitutes for completed code. Implement what is needed now and delete what is not needed.

| Criteria | Judgment |
|----------|----------|
| TODO/FIXME without an issue number, external blocker, and removal condition | REJECT |
| Authorization, validation, persistence, or error handling is deferred with TODO | REJECT |
| Empty implementations, `return null`, `pass`, or commented-out old implementations remain | REJECT |
| An external dependency or known blocker makes implementation impossible now, with issue number and removal condition documented | Acceptable |
| TODO only for future extension | REJECT |

## Sensitive Information Handling

Do not expose passwords, tokens, API keys, session IDs, auth headers, personal information, or other sensitive data in code, logs, error responses, or test output.

| Criteria | Judgment |
|----------|----------|
| Sensitive data is hardcoded in source code or config files | REJECT |
| Logs, exceptions, error responses, or test snapshots contain sensitive data | REJECT |
| Whole requests or DTOs are logged and may include sensitive fields | REJECT |
| Sensitive fields are explicitly omitted or masked | OK |
| Debug logs include personal data but are assumed disabled in production | Warning. Verify it cannot leak through misconfiguration |

## Error Handling

Centralize error handling. Do not scatter try-catch everywhere.

```typescript
// ❌ Scattered try-catch
async function createUser(data) {
  try {
    const user = await userService.create(data)
    return user
  } catch (e) {
    console.error(e)
    throw new Error('Failed to create user')
  }
}

// ✅ Centralized handling at the upper layer
// Handle collectively at the boundary exception translation layer
async function createUser(data) {
  return await userService.create(data)  // Let exceptions propagate up
}
```

### Error Handling Placement

| Layer | Responsibility |
|-------|---------------|
| Domain/Service layer | Throw exceptions on business rule violations |
| Application layer | Do not swallow exceptions; only handle explicit compensation or retry |
| Adapter boundary | Translate exceptions to protocol-specific responses or presentation |
| Global handler | Handle only cross-cutting exceptions such as authentication, validation, and common error shapes |

### HTTP Exception Translation

HTTP adapters / controllers / handlers must not translate exceptions into HTTP representation endpoint by endpoint. Translate exceptions into HTTP status codes, response bodies, and headers at an exception translation layer on the HTTP adapter boundary.

| Criteria | Judgment |
|----------|----------|
| Each endpoint maps exceptions to HTTP representation through the same try-catch or wrapper | REJECT. Move it to an exception translation layer at the HTTP adapter boundary |
| API-specific exception mapping is added to a global handler shared by all APIs | REJECT. Keep it inside the target API boundary |
| Only truly cross-cutting mappings such as authentication, validation, and common error shapes are handled by a global handler | OK |
| HTTP representation mapping lives in the application or domain layer | REJECT. Keep it at the HTTP adapter boundary |

## Conversion Placement

Place conversion methods on the DTO side.

```typescript
// ✅ Conversion methods on Request/Response DTOs
interface CreateUserRequest {
  name: string
  email: string
}

function toUseCaseInput(req: CreateUserRequest): CreateUserInput {
  return { name: req.name, email: req.email }
}

// Controller
const input = toUseCaseInput(request)
const output = await useCase.execute(input)
return UserResponse.from(output)
```

Conversion direction:
```
Request → toInput() → UseCase/Service → Output → Response.from()
```

## Shared Code Decisions

Eliminate duplication by default. When logic is essentially the same and should be unified, apply DRY. Do not decide mechanically by count.

### Should Be Shared

- Essentially identical logic duplicated
- Same style/UI pattern
- Same validation logic
- Same formatting logic

### Should Not Be Shared

- Duplication across different domains (e.g., customer validation and admin validation are separate concerns)
- Superficially similar code with different reasons to change
- Based on "might need it in the future" predictions

```typescript
// ❌ Over-generalization
function formatValue(value, type, options) {
  if (type === 'currency') { ... }
  else if (type === 'date') { ... }
  else if (type === 'percentage') { ... }
}

// ✅ Separate functions by purpose
function formatCurrency(amount: number): string { ... }
function formatDate(date: Date): string { ... }
function formatPercentage(value: number): string { ... }
```

## Same Implementation with Different Names (DRY Violation)

AI tends to define the same logic under multiple function names.

| Pattern | Example | Verdict |
|---------|---------|---------|
| Same implementation with different names | `copyFacets()` and `placeFacetFiles()` doing the same thing | REJECT |
| Same parameter signature and body | Two functions taking the same params and doing the same work | REJECT |
| Public method only forwards to a private method with the identical signature and has no distinct public contract, registration, decorator, authorization, instrumentation, or side effect | Internal alias delegates 1:1 to the implementation | REJECT. Promote the delegate and merge |
| A 1:1 delegating public method is a stable API or an entry point for framework registration, decorators, authorization, or instrumentation | Public boundary delegates implementation while preserving an external contract | OK. Keep the boundary and make its role explicit |

```typescript
// REJECT - Same implementation exists under different names
function copyFiles(src: string, dest: string): void {
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(dest, f));
  }
}
function placeFiles(src: string, dest: string): void {
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(dest, f));
  }
}

// OK - Consolidate into a single function
function copyFiles(src: string, dest: string): void {
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(dest, f));
  }
}
```

Verification approach:
1. Check if newly added functions have bodies identical or nearly identical to existing functions
2. Compare functions within the same file and within the same module
3. If duplication is found, consolidate into one and unify call sites

## Dangerous Stateful Regex Patterns

Regular expressions with the `/g` flag are stateful (they retain `lastIndex`). Defining them at module scope and mixing `test()` and `replace()` causes unexpected results.

| Pattern | Example | Verdict |
|---------|---------|---------|
| Module-scope `/g` regex used with `test()` | `const RE = /x/g; if (RE.test(s)) ...` | REJECT |
| `/g` regex shared between `test()` and `replace()` | `RE.test(s)` followed by `s.replace(RE, ...)` | REJECT |

```typescript
// REJECT - Module-scope /g regex used with test()
const PATTERN = /\{\{facet:(\w+)\}\}/g;
function hasFacetRef(text: string): boolean {
  return PATTERN.test(text);  // lastIndex advances, next call returns different result
}

// OK - Don't use /g for test(), or create new RegExp inside function
const PATTERN_CHECK = /\{\{facet:(\w+)\}\}/;  // no /g
const PATTERN_REPLACE = /\{\{facet:(\w+)\}\}/g;  // /g for replace
function hasFacetRef(text: string): boolean {
  return PATTERN_CHECK.test(text);
}
function replaceFacetRefs(text: string): string {
  return text.replace(PATTERN_REPLACE, ...);
}
```

Verification approach:
1. Check if module-scope regexes have the `/g` flag
2. Check if `/g` regexes are used with `test()`
3. Check if the same regex is used with both `test()` and `replace()`

## Prohibited

- **Fallbacks are prohibited by default** - Do not write fallbacks using `?? 'unknown'`, `|| 'default'`, or swallowing via `try-catch`. Propagate errors upward. If absolutely necessary, add a comment explaining why
- **Explanatory comments** - Express intent through code. Do not write What/How comments
- **Unused code** - Do not write "just in case" code
- **Unfinished code** - Do not leave TODO/FIXME without an issue number, external blocker, and removal condition; do not leave stubs or commented-out old code
- **any type** - Do not break type safety
- **Direct mutation of objects/arrays** - Create new instances with spread operators
- **console.log** - Do not leave in production code
- **Sensitive information exposure** - Do not include sensitive data in hardcoded values, logs, error responses, or test output
- **Scattered hardcoded contract strings** - File names and config key names must be defined as constants in one place. Scattered literals are prohibited
- **Scattered try-catch** - Centralize error handling at the upper layer
- **Unsolicited backward compatibility / legacy support** - Not needed unless explicitly instructed
- **Internal implementation exported from public API** - Only export domain-level functions and types. Do not export infrastructure functions or internal classes
- **Replaced code surviving after refactoring** - Remove replaced code and exports. Do not keep unless explicitly told to
- **Workarounds that bypass safety mechanisms** - If the root fix is correct, no additional bypass is needed
- **Direct tool execution bypassing project scripts** - `npx tool` and similar bypass the lockfile, causing version mismatches. Look for project-defined scripts (npm scripts, Makefile, etc.) first. Only consider direct execution when no script exists
- **Missing wiring** - When adding new parameters or fields, search the entire call chain to verify. If callers do not pass the value, `options.xxx ?? fallback` always uses the fallback
- **Redundant conditionals** - When if/else calls the same function with only argument differences, unify using ternary operators or spread syntax
- **Copy-paste patterns** - Before writing new code, search for existing implementations of the same kind and follow the existing pattern. Do not introduce your own style
