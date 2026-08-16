Determine requirement fulfillment and resolution of preceding concerns from current code and the current review decision.

{{include:instructions/final-preservation-check}}

**Current review resolution:**
{report:review-resolution.md}

1. Split the original requirements into the smallest independently decidable units and map them to current code
2. Recheck each preceding finding against its original acceptance criteria and determine whether it is resolved
3. When a requirement is unfulfilled or a concern remains unresolved, record the repair target, acceptance criteria, and narrow repair boundary
4. Treat the work as externally blocked only when current code and the current review decision cannot decide a requirement and task-scope code changes cannot provide the required external decision or information

Do not request or inspect machine-gate execution status, results, or logs, including tests and builds, whether presented as quality-gate or requirement-fulfillment evidence. Their absence is not evidence that the work requires repair or external input.

Record the result according to the supplied output contract.
