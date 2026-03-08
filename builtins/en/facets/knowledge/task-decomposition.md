# Task Decomposition Knowledge

## Decomposition Feasibility

Before splitting a task into multiple parts, assess whether decomposition is appropriate. Conditions that prohibit decomposition and REJECT criteria are defined in the Task Decomposition Policy. This section explains the underlying reasoning.

### Decision Criteria Table (Rationale)

| Perspective | Detection Pattern | Recommended Judgment | Rationale (Why) |
|-------------|-------------------|----------------------|-----------------|
| Shared contracts (ID/type) | A new ID/type is defined in one part and referenced by another | Do not decompose (single part) | Producer/consumer mismatches in type, naming, and handoff are common |
| Event chains | Both emitter and receiver must be changed together | Do not decompose (single part) | Bidirectional assumptions drift and cause runtime inconsistencies |
| Interface changes | Existing signature change + multiple call-site updates required | Do not decompose (single part) | Missed call-site updates easily lead to build/runtime failures |
| File ownership overlap | Same file assigned to multiple parts | Do not decompose (restructure plan) | Overwrites/conflicts create repeated REJECT in review cycles |
| Layer independence | API/Domain/Infra boundaries are clear and dependencies are one-way | Decomposition allowed | Clear boundaries reduce coupling across parts |

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

When two parts own the same file or feature, sub-agents overwrite each other's changes, causing repeated REJECT in reviews.

```
// NG: part-2 and part-3 own the same file
part-2: taskInstructionActions.ts — instruct confirmation dialog
part-3: taskInstructionActions.ts — requeue confirmation dialog

// OK: consolidate into one part
part-1: taskInstructionActions.ts — both instruct/requeue confirmation dialogs
```

### Shared Contract Mismatch

When part A generates an ID that part B consumes, both parts implement independently, leading to mismatches in ID name, type, or passing mechanism.

```
// NG: shared contract across independent parts
part-1: generates phaseExecutionId
part-2: consumes phaseExecutionId
→ part-1 uses string, part-2 expects number → integration error

// OK: single part for consistent implementation
part-1: implements phaseExecutionId from generation to consumption
```
