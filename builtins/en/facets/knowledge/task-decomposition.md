# Task Decomposition Knowledge

## Decomposition Feasibility

Before splitting a task into multiple parts, assess whether decomposition is appropriate. Conditions that prohibit decomposition and exclusion criteria are defined in the Task Decomposition Policy. This section explains the underlying reasoning.

### Decision Criteria Table (Rationale)


### Detecting Cross-Cutting Concerns

When any of the following apply, independent parts cannot maintain consistency. Consolidate into a single part.

- A new ID, key, or type is generated in one module and consumed in another
- Both the event emitter and event receiver need changes
- An existing interface signature changes, requiring updates to all call sites

## Grouping Priority

When decomposition is appropriate, use the following criteria to group files.

1. **By dependency direction** — keep dependency source and target in the same part
2. **By layer** — domain layer / infrastructure layer / API layer
3. **By feature** — independent functional units

## Failure Patterns

### Part Overlap

When two parts own the same file or feature, sub-agents overwrite each other's changes, causing repeated review failures.

```
// Avoid: part-2 and part-3 own the same file
part-2: taskInstructionActions.ts — instruct confirmation dialog
part-3: taskInstructionActions.ts — requeue confirmation dialog

// Example: consolidate into one part
part-1: taskInstructionActions.ts — both instruct/requeue confirmation dialogs
```

### Shared Contract Mismatch

When part A generates an ID that part B consumes, both parts implement independently, leading to mismatches in ID name, type, or passing mechanism.

```
// Avoid: shared contract across independent parts
part-1: generates phaseExecutionId
part-2: consumes phaseExecutionId
→ part-1 uses string, part-2 expects number → integration error

// Example: single part for consistent implementation
part-1: implements phaseExecutionId from generation to consumption
```
