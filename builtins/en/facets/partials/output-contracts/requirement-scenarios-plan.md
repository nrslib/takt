Add the following section immediately after Completion Contracts in the plan format above.

### Requirement Scenarios (conditional)

Trigger: write this section only when a completion contract involves "structured input" (classification or transformation where the same literal text is in scope or out of scope depending on position or context) or "identifier generation" (identifiers or sequence numbers sharing a namespace with existing content, persisted data, or artifacts generated in the same operation). Otherwise write one line: "Not applicable — no qualifying completion contract".

~~~gherkin
Scenario: [SCN-{contract ID}-P1] {one line for the in-scope behavior}
  Given {input situation containing a concrete input fragment}
  When {operation}
  Then {externally observable result}

Scenario: [SCN-{contract ID}-N1] {one line for the rejected behavior}
  Given {the same literal text in an out-of-scope context, or an existing value that could collide}
  When {the same operation}
  Then {observable result such as "is not extracted" or "does not collide"}
~~~

- As a rule, one positive and one discriminating negative scenario per qualifying class of each triggered completion contract (usually 2-4 scenarios; when more than 8 are needed, request contract or task splitting instead of omitting)
- Scenario IDs must be unique within a contract; number a second class or additional pair `P2`/`N2` and so on
- One line each for Given/When/Then (plus at most one And). Do not use Background, Scenario Outline, or Examples
- Abstract wording such as "valid input" or "handled correctly" is prohibited. Write concrete input fragments and observable results
- Scenarios concretize existing completion contracts and never create new requirements. Do not write origins, design rationale, implementation locations, or test paths in scenarios
- The "Valid Behavior" column may reference the corresponding positive scenario ID and the "Incorrect Implementation to Reject" column the negative scenario ID (do not duplicate the same content)
