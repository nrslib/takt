```markdown
# Fix Plan

## Result: Fix plan finalized / Task-level replanning required

## Finding Coverage
| Finding ID / Source | Authorization Basis | Evidence | Fix Unit / Follow-up | Problem → Direct Cause → Root Cause | Evidence for the Cause / Other Causes Checked | Classification | Acceptance Criteria and Remediation Boundary |
|---------------------|---------------------|----------|----------------------|-------------------------------------|--------------------------------------------------|----------------|----------------------------------------------|
| {ID or report name} | {Basis recorded by adjudication} | {Report or file:line} | {Fix-unit name, which must not change once chosen} | {Confirmed facts, possible causes, and confirmed cause and effect} | {Evidence for the cause and other causes checked; if unconfirmed, the investigation required} | {Local / Structural / Undemonstrable due to environmental factors} | {Completion condition and excluded neighboring contract or adjacent work} |

## Invariant Register
Carry-forward source: {Latest fix-verification in the same remediation / relative path recorded by the review resolution / No prior remediation / Carry-forward source missing: reason}

### Rows from the Carry-forward Source
| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|---------------------|---------------------|-----------------------------|--------------------------------|---------------|--------------|--------------------------------------|-------------------------------|---------|-----------------------------|------------------|
| {Copy every invariant row from the carry-forward source stated above unchanged, one row at a time; do not make No prior remediation or Carry-forward source missing into rows, and preserve their distinction in the source statement above} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} | {Unchanged} |

When review-resolution.md merges a new finding into an existing family, preserve the carry-forward row unchanged. Record that finding under the same fix unit in Finding Coverage and its added path under the same family in Defect-Family Final State; do not add a separate family in New and Current Planning Rows.

### New and Current Planning Rows
| Fix Unit | Family ID | Invariant Name | Observable Invariant | Responsible Source | Classification | Recurrence on a Different Path Confirmed? | Enforcement Point |
|----------|-----------|----------------|----------------------|--------------------|----------------|-------------------------------------------|-------------------|
| {Fix-unit name, which must not change once chosen} | {Family ID} | {Invariant name, which must not change once chosen} | {Externally observable condition} | {Single responsibility and source that defines this invariant and guarantees it holds; do not change it for only moving or splitting files} | {Local / Structural, independently from whether recurrence has been confirmed} | {confirmed / not confirmed / cannot determine with reason} | {Required for a structural issue. When recurrence on a different path is `confirmed` or `cannot determine`, state a single change point, single validation point, or type/state structure that makes violation impossible; when none can be defined, state why the plan must be revised. For an independent local defect with `not confirmed`: Not required; repair directly at the existing responsible source} |

## Defect-Family Final State
| Fix Unit | Contract to Preserve | Complete Invariant Set | Target Responsibility and Source | Affected Contract Paths | Valid, Failing, and Boundary Examples | Migration and Removal |
|----------|------------------------|------------------------|-------------------------------------------|------------------------------|---------------------------------------|-----------------------|
| {Fix unit} | {Requirement, specification, schema, or public contract} | {Conditions beyond the finding examples} | {Target location, or unchanged for a local issue} | {Confirmed bounded graph of affected paths that actually exist: definition, production, normalization, validation, consumers, terminal or API output, plus retry, fallback, parallel execution, persistence, or restoration only when applicable. Omit non-applicable paths rather than exploring or listing them} | {Representative valid, failing, boundary, and adversarial cases} | {Only existing consumers and duplicate or obsolete paths that require migration or removal; None when no such target exists. Exclude unrelated migration or removal work} |

## Execution Order
| Order | Fix Unit | Operation | Dependencies | Targets | Completion Criteria and Evidence |
|-------|----------|-----------|--------------|---------|----------------------------------|
| {N} | {Fix-unit name from Finding Coverage; exclude follow-up verification} | {Boundary change / consumer migration / removal / local fix} | {Prior operations or None} | {file:line} | {Verifiable condition and observation point} |

## Constraint Compatibility
| Fix Unit | Constraint References | Implementation Method and Candidate Decision | Verification Method, Observation Point, and Execution Conditions | Compatibility Rationale |
|----------|-----------------------|----------------------------------------------|----------------------------------------------------------------|-------------------------|
| {Fix unit} | {Requirements, Policy / Knowledge, and public contracts} | {Selected method and rationale for accepting or rejecting candidates} | {Deterministic evidence available now. If environmental factors prevent demonstration, include the factor, alternative evidence, and follow-up} | {Why the constraints are satisfied} |

## Replanning Requirements
- {None, or evidence preventing a sound fix plan, the cause that remains unconfirmed, and the investigation or decision required}
```
