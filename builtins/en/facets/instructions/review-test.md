Review the changes from a test quality perspective.

**Review criteria:**
- Whether all test plan items are covered
- Test quality (Given-When-Then structure, independence, reproducibility)
- Test naming conventions
- Completeness (unnecessary tests, missing cases)
- Appropriateness of mocks and fixtures
- When an external contract exists, whether request body / query / path input locations are verified as defined
- Whether the tests would catch an implementation that incorrectly reuses a response envelope for request parsing


**Design decisions reference:**
Review {report:coder-decisions.md} to understand the recorded design decisions.
- Do not flag intentionally documented decisions as FP
- However, also evaluate whether the design decisions themselves are sound, and flag any problems

## Judgment Procedure

1. Cross-reference the test plan/test scope reports in the Report Directory with the implemented tests
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
4. If an external contract exists and input locations (root body / query / path) are not verified, treat it as a coverage gap by default
