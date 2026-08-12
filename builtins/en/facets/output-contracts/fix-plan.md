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
| {Fix unit} | {Requirement, specification, schema, or public contract} | {Conditions beyond the finding examples} | {Target location, or unchanged for a local issue} | {Only affected paths that actually exist: definition, production, normalization, validation, consumers, terminal or API output, plus retry, fallback, parallel execution, persistence, or restoration only when applicable. Omit non-applicable paths rather than exploring or listing them} | {Representative cases to verify} | {Consumers and duplicate or obsolete paths} |

## Requirement Scenarios (conditional)

Trigger: write this section only when a fix unit introduces or changes "structured input" (classification or transformation where the same literal text is in scope or out of scope depending on position or context) or "identifier generation" (identifiers or sequence numbers sharing a namespace with existing content, persisted data, or artifacts generated in the same operation). Otherwise write one line: "Not applicable — no qualifying fix unit".

~~~gherkin
Scenario: [SCN-{fix-unit ID}-P1] {one line for the in-scope behavior}
  Given {input situation containing a concrete input fragment}
  When {operation}
  Then {externally observable result}

Scenario: [SCN-{fix-unit ID}-N1] {one line for the rejected behavior}
  Given {the same literal text in an out-of-scope context, or an existing value that could collide}
  When {the same operation}
  Then {observable result such as "is not extracted" or "does not collide"}
~~~

- As a rule, one positive and one discriminating negative scenario per qualifying class of each triggered fix unit (usually 2-4 scenarios; when more than 8 are needed, request fix-unit splitting instead of omitting)
- Scenario IDs must be unique within a fix unit; number a second class or additional pair `P2`/`N2` and so on
- One line each for Given/When/Then (plus at most one And). Do not use Background, Scenario Outline, or Examples
- Abstract wording such as "valid input" or "handled correctly" is prohibited. Write concrete input fragments and observable results
- Scenarios concretize acceptance criteria and contracts and never create new requirements
- The "Valid, Failing, and Boundary Examples" column may reference the corresponding scenario IDs (do not duplicate the same content)

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
