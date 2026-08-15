Determine requirement fulfillment, resolution of preceding findings, and recurrence-register carry-forward from current code and preceding reports.

{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-final-preservation}}

1. Split the task requirements into the smallest independently decidable units and map them to current code
2. Read statements in preceding reports as supporting material, and prefer current code when they conflict
3. Map each preceding finding to its original acceptance criteria and determine whether it is resolved
4. Record the recurrence register from the current carry-forward source in this Report Directory under the invariant-recurrence rules
5. Select APPROVE when every requirement is fulfilled, every preceding finding is resolved, and the recurrence register is carried forward under the invariant-recurrence rules
6. Select REJECT when a requirement is unfulfilled or a finding remains unresolved, and record its actionable family, acceptance criteria, and narrow remediation boundary
7. Select BLOCKED only when current code and preceding reports cannot decide a requirement and task-scope code changes cannot provide the required external decision or information

Do not request or inspect machine-gate execution status, results, or logs, including tests and builds, whether presented as quality-gate or requirement-fulfillment evidence. Do not use their absence as a reason for REJECT or BLOCKED.

Under the provided output contract, record only requirement fulfillment, resolution of preceding findings, and recurrence-register carry-forward.
