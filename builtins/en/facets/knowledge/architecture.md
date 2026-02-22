# Architecture Knowledge

## Structure & Design

**File Organization:**

| Criteria | Judgment |
|----------|----------|
| Single file > 200 lines | Consider splitting |
| Single file > 300 lines | REJECT |
| Single file with multiple responsibilities | REJECT |
| Unrelated code coexisting | REJECT |

**Module Structure:**

- High cohesion: Related functionality grouped together
- Low coupling: Minimal inter-module dependencies
- No circular dependencies
- Appropriate directory hierarchy

**Operation Discoverability:**

When calls to the same generic function are scattered across the codebase with different purposes, it becomes impossible to understand what the system does without grepping every call site. Group related operations into purpose-named functions within a single module. Reading that module should reveal the complete list of operations the system performs.

| Judgment | Criteria |
|----------|----------|
| REJECT | Same generic function called directly from 3+ places with different purposes |
| REJECT | Understanding all system operations requires grepping every call site |
| OK | Purpose-named functions defined and collected in a single module |

**Public API Surface:**

Public APIs should expose only domain-level functions and types. Do not export infrastructure internals (provider-specific functions, internal parsers, etc.).

| Judgment | Criteria |
|----------|----------|
| REJECT | Infrastructure-layer functions exported from public API |
| REJECT | Internal implementation functions callable from outside |
| OK | External consumers interact only through domain-level abstractions |

**Function Design:**

- One responsibility per function
- Consider splitting functions over 30 lines
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

Vertical Slice criteria:

| Criteria | Judgment |
|----------|----------|
| Single feature spans 3+ layers | Consider slicing |
| Minimal inter-feature dependencies | Recommend slicing |
| Over 50% shared processing | Keep layered |
| Team organized by features | Slicing required |

Prohibited patterns:

| Pattern | Problem |
|---------|---------|
| Bloated `utils/` | Becomes graveyard of unclear responsibilities |
| Lazy placement in `common/` | Dependencies become unclear |
| Excessive nesting (4+ levels) | Navigation difficulty |
| Mixed features and layers | `features/services/` prohibited |

**Separation of Concerns:**

- Read and write responsibilities separated
- Data fetching at root (View/Controller), passed to children
- Error handling centralized (no try-catch scattered everywhere)
- Business logic not leaking into Controller/View

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
// User interruption takes priority over piece-defined transitions
if (status === 'interrupted') {
  return ABORT_STEP;
}

// OK - Reason behind seemingly odd behavior
// stay can cause loops, but is only used when explicitly specified by the user
return step.name;
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

**Conditional Branch Proliferation Detection:**

| Pattern | Judgment |
|---------|----------|
| Same if-else pattern in 3+ places | Abstract with polymorphism → REJECT |
| switch/case with 5+ branches | Consider Strategy/Map pattern |
| Flag arguments changing behavior | Split into separate functions → REJECT |
| Type-based branching (instanceof/typeof) | Replace with polymorphism → REJECT |
| Nested conditionals (3+ levels) | Early return or extract → REJECT |

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

## Strict TODO Comment Prohibition

"We'll do it later" never gets done. What's not done now is never done.

TODO comments are immediate REJECT.

```kotlin
// REJECT - Future-looking TODO
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

Only acceptable TODO cases:

| Condition | Example | Judgment |
|-----------|---------|----------|
| External dependency prevents implementation + Issued | `// TODO(#123): Implement after API key obtained` | Acceptable |
| Technical constraint prevents + Issued | `// TODO(#456): Waiting for library bug fix` | Acceptable |
| "Future implementation", "add later" | `// TODO: Add validation` | REJECT |
| "No time for now" | `// TODO: Refactor` | REJECT |

Correct handling:
- Needed now → Implement now
- Not needed now → Delete the code
- External blocker → Create issue and include ticket number in comment

## DRY Violation Detection

Eliminate duplication by default. When logic is essentially the same and should be unified, apply DRY. Do not judge mechanically by count.

| Pattern | Judgment |
|---------|----------|
| Essentially identical logic duplicated | REJECT - Extract to function/method |
| Same validation duplicated | REJECT - Extract to validator function |
| Essentially identical component structure | REJECT - Create shared component |
| Copy-paste derived code | REJECT - Parameterize or abstract |

When NOT to apply DRY:
- Different domains: Don't abstract (e.g., customer validation vs admin validation are different things)
- Superficially similar but different reasons to change: Treat as separate code

## Spec Compliance Verification

Verify that changes comply with the project's documented specifications.

Verification targets:

| Target | What to Check |
|--------|---------------|
| CLAUDE.md / README.md | Conforms to schema definitions, design principles, constraints |
| Type definitions / Zod schemas | New fields reflected in schemas |
| YAML/JSON config files | Follows documented format |

Specific checks:

1. When config files (YAML, etc.) are modified or added:
   - Cross-reference with schema definitions in CLAUDE.md, etc.
   - No ignored or invalid fields present
   - No required fields missing

2. When type definitions or interfaces are modified:
   - Documentation schema descriptions are updated
   - Existing config files are compatible with new schema

REJECT when these patterns are found:

| Pattern | Problem |
|---------|---------|
| Fields not in the spec | Ignored or unexpected behavior |
| Invalid values per spec | Runtime error or silently ignored |
| Violation of documented constraints | Against design intent |

## Call Chain Verification

When new parameters/fields are added, verify not just the changed file but also callers.

Verification steps:
1. When finding new optional parameters or interface fields, `Grep` all callers
2. Check if all callers pass the new parameter
3. If fallback value (`?? default`) exists, verify if fallback is used as intended

Danger patterns:

| Pattern | Problem | Detection |
|---------|---------|-----------|
| `options.xxx ?? fallback` where all callers omit `xxx` | Feature implemented but always falls back | grep callers |
| Tests set values directly with mocks | Don't go through actual call chain | Check test construction |
| `executeXxx()` doesn't receive `options` it uses internally | No route to pass value from above | Check function signature |

```typescript
// Missing wiring: No route to receive projectCwd
export async function executePiece(config, cwd, task) {
  const engine = new PieceEngine(config, cwd, task);  // No options
}

// Wired: Can pass projectCwd
export async function executePiece(config, cwd, task, options?) {
  const engine = new PieceEngine(config, cwd, task, options);
}
```

Logically dead code due to caller constraints:

Call chain verification applies not only to "missing wiring" but also to the reverse — unnecessary guards for conditions that callers already guarantee.

| Pattern | Problem | Detection |
|---------|---------|-----------|
| TTY check when all callers require TTY | Unreachable branch remains | grep all callers' preconditions |
| Null guard when callers already check null | Redundant defense | Trace caller constraints |
| Runtime type check when TypeScript types constrain | Not trusting type safety | Check TypeScript type constraints |

Verification steps:
1. When finding defensive branches (TTY check, null guard, etc.), grep all callers
2. If all callers already guarantee the condition, guard is unnecessary → REJECT
3. If some callers don't guarantee it, keep the guard

## Quality Attributes

| Attribute | Review Point |
|-----------|--------------|
| Scalability | Design handles increased load |
| Maintainability | Easy to modify and fix |
| Observability | Logging and monitoring enabled |

## Big Picture

Don't get lost in minor "clean code" nitpicks.

Verify:
- How will this code evolve in the future
- Is scaling considered
- Is technical debt being created
- Does it align with business requirements
- Is naming consistent with the domain

## Change Scope Assessment

Check change scope and include in report (non-blocking).

| Scope Size | Lines Changed | Action |
|------------|---------------|--------|
| Small | ~200 lines | Review as-is |
| Medium | 200-500 lines | Review as-is |
| Large | 500+ lines | Continue review. Suggest splitting if possible |

Note: Some tasks require large changes. Don't REJECT based on line count alone.

Verify:
- Changes are logically cohesive (no unrelated changes mixed in)
- Coder's scope declaration matches actual changes

Include as suggestions (non-blocking):
- If splittable, present splitting proposal
