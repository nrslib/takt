```markdown
# Fix Plan

## Result: Fix plan finalized / Task-level replanning required

## Finding Coverage
| Finding ID / Source | Authorization Basis | Evidence | Fix Unit / Follow-up | Problem → Direct Cause → Root Cause | Evidence for the Cause / Other Causes Checked | Classification | Acceptance Criteria and Remediation Boundary |
|---------------------|---------------------|----------|----------------------|-------------------------------------|--------------------------------------------------|----------------|----------------------------------------------|
| {ID or report name} | {Basis recorded by adjudication} | {Report or file:line} | {Stable ID} | {Confirmed facts, possible causes, and confirmed cause and effect} | {Evidence for the cause and other causes checked; if unconfirmed, the investigation required} | {Local / Structural / Undemonstrable due to environmental factors} | {Completion condition and excluded neighboring contract or adjacent work} |

## Invariant Register
| Fix Unit | Family ID | Invariant Stable ID | Observable Invariant | Authoritative Owner | Classification and Recorded Recurrence Trigger | Enforcement Point |
|----------|-----------|---------------------|----------------------|---------------------|------------------------------------------------|-------------------|
| {Stable fix-unit ID} | {Stable family ID} | {Stable ID within the family} | {Externally observable condition} | {Single responsibility and source of truth} | {Local / Structural; true / false / not evaluable with reason} | {Required for a structural issue or a unit whose recorded trigger is true: single change point, single validation point, or type/structure that makes violation impossible. For an independent local defect: Not required; direct repair at the existing owner} |

## Defect-Family Final State
| Fix Unit | Authoritative Contract | Complete Invariant Set | Target Responsibility and Source of Truth | Participating Contract Paths | Valid, Failing, and Boundary Examples | Migration and Removal |
|----------|------------------------|------------------------|-------------------------------------------|------------------------------|---------------------------------------|-----------------------|
| {Fix unit} | {Requirement, specification, schema, or public contract} | {Conditions beyond the finding examples} | {Target location, or unchanged for a local issue} | {Confirmed bounded graph of affected paths that actually exist: definition, production, normalization, validation, consumers, terminal or API output, plus retry, fallback, parallel execution, persistence, or restoration only when applicable. Omit non-applicable paths rather than exploring or listing them} | {Representative valid, failing, boundary, and adversarial cases} | {Only existing consumers and duplicate or obsolete paths that require migration or removal; None when no such target exists. Exclude unrelated migration or removal work} |

## Execution Order
| Order | Fix Unit | Operation | Dependencies | Targets | Completion Criteria and Evidence |
|-------|----------|-----------|--------------|---------|----------------------------------|
| {N} | {Stable fix-unit ID from Finding Coverage; exclude follow-up verification} | {Boundary change / consumer migration / removal / local fix} | {Prior operations or None} | {file:line} | {Verifiable condition and observation point} |

## Constraint Compatibility
| Fix Unit | Constraint References | Implementation Method and Candidate Decision | Verification Method, Observation Point, and Execution Conditions | Compatibility Rationale | Quality Gates |
|----------|-----------------------|----------------------------------------------|----------------------------------------------------------------|-------------------------|---------------|
| {Fix unit} | {Requirements, Policy / Knowledge, and public contracts} | {Selected method and rationale for accepting or rejecting candidates} | {Deterministic evidence available now. If environmental factors prevent demonstration, include the factor, alternative evidence, and follow-up} | {Why the constraints are satisfied} | {Commands} |

## Replanning Requirements
- {None, or evidence preventing a sound fix plan, the cause that remains unconfirmed, and the investigation or decision required}
```
