Determine requirement fulfillment, resolution of preceding findings, and recurrence-register carry-forward from current code and the current review resolution.

{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-final-preservation}}

**Current review resolution:**
{report:review-resolution.md}

**Depth of fulfillment judgment:**

The only valid basis for judging a requirement fulfilled is having confirmed the path by which the required result actually holds in the code. The existence of a call to a function that validates, saves, or propagates is not a basis. For every location cited as evidence of fulfillment, open the callee implementation and confirm with file:line that the path connects from the required input to the observable result (the save destination path, the output format, the propagation to consumers). Never cite a file you have not opened. Treat any requirement you could not confirm as unfulfilled.

1. Split the original requirements into the smallest independently decidable units and map them to current code
2. Recheck each preceding finding against its original acceptance criteria and determine whether it is resolved
3. Copy the carry-forward source and every row from Invariant Register Carry-forward in the current review-resolution.md unchanged into the section with the same name in the final review-resolution.md
4. Select APPROVE when every requirement is fulfilled and every preceding finding is resolved
5. Select REJECT when a requirement is unfulfilled or a finding remains unresolved, and record its actionable family, acceptance criteria, and narrow remediation boundary
6. Select BLOCKED only when current code and the current review resolution cannot decide a requirement and task-scope code changes cannot provide the required external decision or information

Do not request or inspect machine-gate execution status, results, or logs, including tests and builds, whether presented as quality-gate or requirement-fulfillment evidence. Do not use their absence as a reason for REJECT or BLOCKED.
