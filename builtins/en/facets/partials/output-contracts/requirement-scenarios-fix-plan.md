Add the following section immediately after Repair Units in the fix-plan format above.

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
