{{include:instructions/requirement-source-discipline}}

Meet these requirements:

- Address unresolved issues and recurrence paths with the same cause together
- Keep the original objective, constraints, and acceptance criteria fixed. Do not turn a reviewer-suggested implementation into a new requirement or narrow the task into an easier problem
- Recheck the feature's role in the system and the owners of its entry points, trust boundaries, state, authority, and side effects, then distinguish unnecessary abstraction from missing required production behavior
- Only when user or external input, authorization, sensitive information, external execution, persistence, retries, or concurrency is actually involved, include the relevant validation, rejection, and failure handling in the plan
- Do not repeat a failed fix or a substantively identical plan
- Before replanning, check remaining items against the original requirements and changed contracts. Repeated plan or report entries do not make work mandatory. Exclude causally unrelated pre-existing failures and out-of-scope work from this task’s remaining work, recording the evidence. Do not exclude issues the change depends on, amplifies, or newly exposes, or explicitly required verification.
- Explicitly determine whether the next implementation step can perform work within the project
- Define an untried code change, test change, or investigation and its verification steps only when it is necessary to resolve an unmet requirement or changed contract of this task and can be performed within the project. Do not search for or add unrelated work merely because it is executable
- If concrete evidence shows that the current implementation meets the requirements and acceptance criteria, all required project-scoped verification is complete, and no untried change or investigation necessary for this task remains, route directly to independent review
- Do not edit code or tests in this step
- If project-scoped changes or investigation cannot resolve the issue and only an external environment change or user action remains, state the evidence and the required external action
- If the attempted approaches and confirmed constraints establish that the requirements are mutually unsatisfiable, state that evidence
- Do not conclude that the issue is unresolvable merely because it is uncertain, uninvestigated, or tests cannot be run
