Analyze the target code and identify missing unit tests.

**Note:** If a Previous Response exists, this is a replan due to rejection.
Revise the test plan taking that feedback into account.

**Actions:**
1. Read the target module source code and understand its behavior, branches, and state transitions
2. Read existing tests and identify what is already covered
3. When consolidation or abstraction is involved, enumerate return / throw / catch / early return paths that carry the same contract
4. Identify missing test cases (happy path, error cases, boundary values, edge cases)
5. Determine test strategy (mock approach, existing test helper usage, fixture design)
6. Provide concrete guidelines for the test implementer
