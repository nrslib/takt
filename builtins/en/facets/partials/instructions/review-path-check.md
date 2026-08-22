{{include:instructions/contract-path-analysis}}

Review only the current change request and presented review scope. Within that scope, inspect every path involved in changed invariants, established contracts that must remain intact, and regressions caused by repairs. Do not claim coverage beyond it.

Identify what can be decided in this review and why from the original requirements, acceptance criteria, public specifications, and actual consumer dependencies.

Inspect consumers and branches directly reachable from actual entry points. Separate concrete conditions when their input, precondition, dependency outcome, or externally observable result differs. Record evidence for conditions classified as out of scope or unreachable.

For each condition, compare the expected result with the actual result using code, specifications, or execution evidence. Do not use confirmation of a successful result as confirmation of another condition or combine conditions under a generic label such as "failure paths." Record a condition that cannot be confirmed directly as unchecked.

When the requirement or an actual consumer observes the result at a boundary, verify the expected result from that boundary rather than only at an internal function. Even when distinct conditions have the same expected result, do not treat them as one completed check; record each condition's input, dependency result, expected result, and verification method from that boundary.

Before finishing the review, record the evidence, entry points, consumers, distinct conditions, expected results, actual results, and any unchecked or excluded scope in a form that can be traced from the report.
