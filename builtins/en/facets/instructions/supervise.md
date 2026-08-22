Determine requirement fulfillment and resolution of preceding concerns from current code and preceding reports.

{{include:instructions/final-preservation-check}}

1. Split the task requirements into the smallest independently decidable units and map them to current code
2. Read statements in preceding reports as supporting material, and prefer current code when they conflict
3. Map each preceding finding to its original acceptance criteria and determine whether it is resolved
4. When a requirement is unfulfilled or a concern remains unresolved, record the repair target, acceptance criteria, and narrow repair boundary
5. Treat the work as externally blocked only when current code and preceding reports cannot decide a requirement and task-scope code changes cannot provide the required external decision or information

Do not request or inspect machine-gate execution status, results, or logs, including tests and builds, whether presented as quality-gate or requirement-fulfillment evidence. Their absence is not evidence that the work requires repair or external input.

Record the result according to the supplied output contract.
