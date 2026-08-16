Strictly review the code diff against the task intent.

Procedure:
1. identify the changed contracts from the task intent, plan, diff, and execution evidence
2. when the current prompt provides judgment criteria or supporting knowledge, select only what applies to the changed contract
3. check for implementation bugs, regressions, security risks at changed trust boundaries, and missing tests for observable contracts
4. trace changed values, state, types, schemas, resolvers, normalizers, adapters, and shared helpers through their real entries and consumers
5. for side effects and state changes, inspect the normal, failure, interruption, and cleanup paths that exist in the changed contract

{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/contract-family-review-by-mode}}
{{include:instructions/review-pr-context}}
