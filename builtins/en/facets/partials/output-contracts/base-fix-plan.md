```markdown
# Fix Plan

## Result: Fix plan finalized / Task-level replanning required

## Finding Coverage
| Finding ID / Source | Authorization Basis | Evidence | Fix Unit / Follow-up | Problem → Direct Cause → Root Cause | Classification | Acceptance Criteria and Remediation Boundary |
|---------------------|---------------------|----------|----------------------|-------------------------------------|----------------|----------------------------------------------|
| {ID or report name} | {Basis recorded by adjudication} | {Report or file:line} | {Stable ID} | {Causal chain verified in code} | {Local / Structural / Undemonstrable due to environmental factors} | {Completion condition and excluded neighboring contract or adjacent work} |

## Defect-Family Final State
| Fix Unit | Authoritative Contract | Complete Invariant Set | Target Responsibility and Source of Truth | Participating Contract Paths | Valid, Failing, and Boundary Examples | Migration and Removal |
|----------|------------------------|------------------------|-------------------------------------------|------------------------------|---------------------------------------|-----------------------|
| {Fix unit} | {Requirement, specification, schema, or public contract} | {Conditions beyond the finding examples} | {Target location, or unchanged for a local issue} | {Only affected paths that actually exist: definition, production, normalization, validation, consumers, terminal or API output, plus retry, fallback, parallel execution, persistence, or restoration only when applicable. Omit non-applicable paths rather than exploring or listing them} | {Representative cases to verify} | {Only existing consumers and duplicate or obsolete paths that require migration or removal; None when no such target exists. Exclude unrelated migration or removal work} |

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
