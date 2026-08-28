```markdown
# Repair Plan

## Result: FIX PLAN CONFIRMED / REPLAN REQUIRED

## Findings and Repair Units
For every accepted finding and repair unit, maintain an evidence inventory covering the root cause, boundary, and each in-scope path. Each entry must name the source file path, symbol / function / helper, and relevant caller → callee relationship when one exists; if none exists, state that and provide direct production-entry evidence. A semantic summary without these concrete references is not evidence.
| Finding ID / Source | Repair Unit | Evidence | Acceptance Criteria |
|---------------------|-------------|----------|---------------------|
| {ID and report name} | {Name for repairs sharing the same cause and completion criteria} | {source file path + symbol/function/helper + relevant caller -> callee relation, or direct production-entry evidence when none exists} | {Observable completion conditions} |

## Repair Units
| Repair Unit | Cause | Condition to Preserve | Relevant Paths | Changes | Excluded Scope |
|-------------|-------|-----------------------|----------------|---------|----------------|
| {Name} | {Verified cause and primary alternatives ruled out} | {Externally observable condition} | {Actual paths with source file path, symbol/function/helper, and caller -> callee sequence from the actual top-level production entry through every shared/prior, value-affecting, and effectful stage, consumer, and output} | {Minimum necessary changes} | {Separate contracts, adjacent work, and unnecessary mechanism changes} |

## Input, State, and Path Check
Record the impact-path audit one row per applicable path. Do not replace multiple paths with a summary such as "all consumers" or "same as above". Assign a stable atomic element ID to every applicable field, member, or variant, whether it is edit or verify-only. Use separate rows or provide a separately identified falsification for each ID within the same row: show a concrete baseline input or state separately from a different single-element sentinel mutation, hold every other input, state, and element constant, run the canonical top-level production entry, and record that ID's specific mutated terminal or artifact observation. A baseline-only or preservation-only statement, a boundary-only test, a mutation changing multiple elements at once, or mere enumeration does not satisfy this requirement. If the source declares an element immutable, use an isolated copy or equivalent input at the same consumer boundary; if a mutation is unsupported, exclude it only with source-and-code evidence and do not substitute baseline confirmation.

The Entry-to-Terminal Path must name every real file or module and function / helper in caller-to-callee execution order. Trace independent sibling branches separately from the top-level entry. For each applicable required file, asset, or configuration reference, record an unavailable or omitted falsification and its failure propagation; for a real placeholder, delimiter, or other transform token, record a separate token omission or alteration in addition to data sentinels. For every value-affecting effectful intermediate stage, especially persistence, writing, or dispatch, record an applicable bypass or omission mutation or boundary spy and the concrete terminal or artifact absence or change. Use only source-and-code-grounded finite states and stages; a cross-product of all stages or states is not required.

Every canonical row and evidence-path entry must begin at the actual top-level production entry and include, before its terminal, every shared / prior, value-affecting, and effectful stage in execution order. Do not begin at the defining source or a direct consumer. Repeat the full entry prefix for each sibling terminal instead of abbreviating it as "same as above"; if any prefix stage is omitted, the plan cannot be confirmed and final reconciliation fails.

| Repair Unit | Atomic Element ID | Source of Truth and Evidence | Baseline Input or State | Single-Element Mutation | Entry-to-Terminal Path | Path Treatment | Implementation Constraint | Baseline Expected Result | Mutated Terminal / Artifact Observation | Falsification Method |
|-------------|-------------------|------------------------------|------------------------|------------------------|------------------------|----------------|--------------------------|-------------------------|----------------------------------------|----------------------|
| {repair unit} | {stable atomic element ID} | {source file path + symbol/function/helper + caller -> callee evidence defining the finite set, state, or invariant} | {concrete baseline input or state} | {different single-element sentinel mutation; all other inputs/states/elements fixed} | {actual top-level production entry -> every shared/prior, value-affecting, and effectful stage -> function/helper -> consumer -> terminal, in execution order; repeat the full prefix for each sibling} | {edit / migrate-remove / verify-only at each location} | {contract to preserve, or evidence for "none"} | {observable baseline result} | {specific observation at the mutated terminal or artifact} | {test, reproduction, search, or code trace that fails on violation} |

## Implementation Order
| Order | Repair Unit | Work | Dependency | Completion Criteria |
|-------|-------------|------|------------|---------------------|
| {N} | {Name} | {Boundary change / Consumer migration / Obsolete-path removal / Local repair} | {Earlier work or none} | {Condition verifiable from code and observable results} |

## Verification Approach
| Repair Unit | Path or State to Check | Successful Example | Failure or Boundary Example | Method |
|-------------|------------------------|--------------------|-----------------------------|--------|
| {Name} | {Actual affected path or state} | {Concrete expected success} | {Concrete example that detects a violation} | {Test, reproduction, search, or code tracing} |

## Replanning Items
- {None, or evidence that the cause, requirement, or repair boundary cannot be established and the decision needed}
```

- Combine findings into one repair unit when they share the same cause, condition to preserve, and acceptance criteria
- While planning each repair unit, inspect actual paths affected by the same cause instead of only the reported location
- Do not add nonexistent paths or unrelated mechanisms as checklist items
- Map every in-scope finding ID before confirming the plan; do not stop after the first missing item
