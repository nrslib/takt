```markdown
# Fix Plan

## Result: Fix plan finalized / Task-level replanning required

## Finding Coverage
| Finding ID / Source | Evidence | Fix Unit / Follow-up | Problem → Direct Cause → Root Cause | Classification | Acceptance Criteria |
|---------------------|----------|----------------------|-------------------------------------|----------------|---------------------|
| {ID or report name} | {Report or file:line} | {Stable ID} | {Causal chain verified in code} | {Local / Structural / Undemonstrable due to environmental factors} | {Completion condition or follow-up verification} |

## Defect-Family Final State
| Fix Unit | Authoritative Contract | Complete Invariant Set | Target Responsibility and Source of Truth | Participating Contract Paths | Valid, Failing, and Boundary Examples | Migration and Removal |
|----------|------------------------|------------------------|-------------------------------------------|------------------------------|---------------------------------------|-----------------------|
| {Fix unit} | {Requirement, specification, schema, or public contract} | {Conditions beyond the finding examples} | {Target location, or unchanged for a local issue} | {Entries, types, schemas, validation, consumers, state, side effects, and failure paths} | {Representative cases to verify} | {Consumers and duplicate or obsolete paths} |

## Execution Order
| Order | Fix Unit | Operation | Dependencies | Targets | Completion Criteria and Evidence |
|-------|----------|-----------|--------------|---------|----------------------------------|
| {N} | {Stable fix-unit ID from Finding Coverage; exclude follow-up verification} | {Boundary change / consumer migration / removal / local fix} | {Prior operations or None} | {file:line} | {Verifiable condition and observation point} |

## Constraint Compatibility
| Fix Unit | Constraint References | Implementation Method and Candidate Decision | Verification Method, Observation Point, and Execution Conditions | Compatibility Rationale | Quality Gates |
|----------|-----------------------|----------------------------------------------|----------------------------------------------------------------|-------------------------|---------------|
| {Fix unit} | {Requirements, Policy / Knowledge, and public contracts} | {Selected method and rationale for accepting or rejecting candidates} | {Deterministic evidence available now. If environmental factors prevent demonstration, include the factor, alternative evidence, and follow-up} | {Why the constraints are satisfied} | {Commands} |

## Replanning Requirements
- {None, or evidence preventing a sound fix plan and the decision required}
```
